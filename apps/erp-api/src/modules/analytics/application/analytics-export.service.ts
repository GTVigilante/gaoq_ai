import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';

import { AuditService } from '../../../core/audit/audit.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  ANALYTICS_GENERATE_EXPORT_JOB,
  type AnalyticsExportJobData,
  ANALYTICS_EXPORT_QUEUE,
} from '../analytics-export.queue.js';
import {
  AnalyticsManagementExportRecord,
  type AnalyticsManagementExportDocument,
} from '../persistence/analytics.schemas.js';
import { ManagementDashboardService } from './management-dashboard.service.js';

const EXPORT_TTL_MS = 24 * 60 * 60 * 1_000;
const PROCESSING_LEASE_MS = 5 * 60 * 1_000;

export interface AnalyticsExportView {
  readonly id: string;
  readonly asOf: string;
  readonly format: 'json';
  readonly status: 'queued' | 'processing' | 'ready' | 'failed';
  readonly resourceUri: string;
  readonly contentHash: string | null;
  readonly artifact: Readonly<Record<string, unknown>> | null;
  readonly expiresAt: string;
}

/** 受控导出应用服务：R2 执行后入队，资源读取再次按可信租户与发起人约束。 */
@Injectable()
export class AnalyticsExportService {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(AnalyticsManagementExportRecord.name)
    private readonly exports: Model<AnalyticsManagementExportDocument>,
    @InjectQueue(ANALYTICS_EXPORT_QUEUE)
    private readonly queue: Queue<AnalyticsExportJobData>,
    private readonly dashboard: ManagementDashboardService,
    private readonly audit: AuditService,
  ) {}

  async request(exportId: string, asOf: string): Promise<AnalyticsExportView> {
    if (!ULID_PATTERN.test(exportId)) throw new Error('ANALYTICS_EXPORT_ID_INVALID');
    await this.dashboard.get(asOf);
    const trusted = this.context.getRequired();
    const resourceUri = `erp://analytics/exports/${exportId}`;
    const record = {
      id: exportId,
      tenantId: trusted.tenant.tenantId,
      requestedBy: trusted.actor.actorId,
      asOf,
      format: 'json' as const,
      status: 'queued' as const,
      resourceUri,
      artifactJson: null,
      contentHash: null,
      failureCode: null,
      processingStartedAt: null,
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
    };
    try {
      await this.exports.create(record);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await this.findOwned(exportId);
      if (existing.asOf !== asOf) throw new Error('ANALYTICS_EXPORT_ID_REUSED', { cause: error });
      if (existing.status === 'queued' || existing.status === 'failed') {
        if (existing.status === 'failed') {
          await this.exports.updateOne(
            { id: exportId, tenantId: existing.tenantId, status: 'failed' },
            { $set: { status: 'queued', failureCode: null } },
            { runValidators: true },
          ).exec();
        }
        try {
          await this.enqueue({
            exportId, tenantId: existing.tenantId, requestedBy: existing.requestedBy,
          });
        } catch (error) {
          await this.markQueueFailure(exportId, existing.tenantId);
          throw error;
        }
        return view({ ...existing, status: 'queued' });
      }
      return view(existing);
    }
    try {
      await this.enqueue({ exportId, tenantId: record.tenantId, requestedBy: record.requestedBy });
    } catch (error) {
      await this.markQueueFailure(exportId, record.tenantId);
      throw error;
    }
    return view(record);
  }

  async get(exportId: string): Promise<AnalyticsExportView> {
    if (!ULID_PATTERN.test(exportId)) throw new NotFoundException();
    return view(await this.findOwned(exportId));
  }

  async process(input: AnalyticsExportJobData): Promise<void> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const claimed = await this.exports.findOneAndUpdate(
      {
        id: input.exportId, tenantId: input.tenantId, requestedBy: input.requestedBy,
        expiresAt: { $gt: now },
        $or: [
          { status: { $in: ['queued', 'failed'] } },
          { status: 'processing', processingStartedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: 'processing', processingStartedAt: now, failureCode: null } },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (claimed === null) return;
    try {
      const dashboard = await this.context.run({
        tenant: { tenantId: input.tenantId, source: 'service_identity' },
        actor: {
          actorId: input.requestedBy, actorType: 'user', tenantId: input.tenantId,
          roleCodes: [], scopes: ['erp:analytics:management:read'], departmentIds: [],
          traceId: input.exportId,
        },
      }, () => this.dashboard.get(claimed.asOf));
      const artifactJson = JSON.stringify(Object.freeze({
        schemaVersion: 'management-dashboard-export.v1',
        exportedAt: new Date().toISOString(),
        dashboard,
      }));
      const contentHash = createHash('sha256').update(artifactJson, 'utf8').digest('base64url');
      await this.audit.recordSystem(input.tenantId, {
        action: 'analytics.management_dashboard.export.generate',
        resourceType: 'analytics_export', resourceId: input.exportId,
        riskLevel: 'R2', outcome: 'success', traceId: input.exportId,
        metadata: { asOf: claimed.asOf, contentHash },
      });
      const updated = await this.exports.findOneAndUpdate(
        { id: input.exportId, tenantId: input.tenantId, status: 'processing' },
        {
          $set: {
            status: 'ready', processingStartedAt: null,
            artifactJson, contentHash, failureCode: null,
          },
        },
        { returnDocument: 'after', runValidators: true },
      ).lean().exec();
      if (updated === null) throw new Error('ANALYTICS_EXPORT_STATE_CONFLICT');
    } catch (error) {
      const failureCode = safeFailure(error);
      await this.exports.updateOne(
        { id: input.exportId, tenantId: input.tenantId, status: 'processing' },
        {
          $set: {
            status: 'failed', processingStartedAt: null, artifactJson: null,
            contentHash: null, failureCode,
          },
        },
        { runValidators: true },
      ).exec();
      await this.audit.recordSystem(input.tenantId, {
        action: 'analytics.management_dashboard.export.generate',
        resourceType: 'analytics_export', resourceId: input.exportId,
        riskLevel: 'R2', outcome: 'failure', traceId: input.exportId,
        metadata: { asOf: claimed.asOf, failureCode },
      });
      throw error;
    }
  }

  private async findOwned(exportId: string) {
    const trusted = this.context.getRequired();
    const record = await this.exports.findOne({
      id: exportId,
      tenantId: trusted.tenant.tenantId,
      requestedBy: trusted.actor.actorId,
      expiresAt: { $gt: new Date() },
    }).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'ANALYTICS_EXPORT_NOT_FOUND', message: '分析导出不存在或已过期',
    });
    return record;
  }

  private async enqueue(data: AnalyticsExportJobData): Promise<void> {
    await this.queue.add(ANALYTICS_GENERATE_EXPORT_JOB, data, {
      jobId: data.exportId, attempts: 4,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    });
  }

  private async markQueueFailure(exportId: string, tenantId: string): Promise<void> {
    await this.exports.updateOne(
      { id: exportId, tenantId, status: 'queued' },
      {
        $set: {
          status: 'failed', processingStartedAt: null,
          failureCode: 'ANALYTICS_EXPORT_QUEUE_UNAVAILABLE',
        },
      },
      { runValidators: true },
    ).exec();
  }
}

function view(record: {
  readonly id: string; readonly asOf: string; readonly format: 'json';
  readonly status: 'queued' | 'processing' | 'ready' | 'failed';
  readonly resourceUri: string; readonly contentHash: string | null;
  readonly artifactJson: string | null; readonly expiresAt: Date;
}): AnalyticsExportView {
  let artifact: Readonly<Record<string, unknown>> | null = null;
  if (record.artifactJson !== null) {
    const actualHash = createHash('sha256').update(record.artifactJson, 'utf8').digest('base64url');
    if (record.contentHash === null || actualHash !== record.contentHash) {
      throw new Error('ANALYTICS_EXPORT_INTEGRITY_FAILED');
    }
    const parsed = JSON.parse(record.artifactJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('ANALYTICS_EXPORT_ARTIFACT_INVALID');
    }
    artifact = parsed as Readonly<Record<string, unknown>>;
  }
  return Object.freeze({
    id: record.id, asOf: record.asOf, format: record.format, status: record.status,
    resourceUri: record.resourceUri, contentHash: record.contentHash,
    artifact,
    expiresAt: record.expiresAt.toISOString(),
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

function safeFailure(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,95}$/.test(error.message)
    ? error.message : 'ANALYTICS_EXPORT_GENERATION_FAILED';
}
