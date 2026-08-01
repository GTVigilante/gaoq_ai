import { createHash, randomBytes } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';

import { AuditService, type SystemAuditRecordInput } from '../../../core/audit/audit.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  analyticsExportArtifactSchema,
  analyticsExportViewSchema,
  type AnalyticsExportView,
} from '../analytics.contract.js';
import {
  ANALYTICS_GENERATE_EXPORT_JOB,
  type AnalyticsExportJobData,
  ANALYTICS_EXPORT_QUEUE,
  createAnalyticsExportJobId,
} from '../analytics-export.queue.js';
import {
  AnalyticsManagementExportRecord,
  type AnalyticsManagementExportDocument,
} from '../persistence/analytics.schemas.js';
import { ManagementDashboardService } from './management-dashboard.service.js';

const EXPORT_TTL_MS = 24 * 60 * 60 * 1_000;
const PROCESSING_LEASE_MS = 5 * 60 * 1_000;
const MAX_ARTIFACT_BYTES = 65_536;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_ID = /^[A-Za-z0-9._-]{1,128}$/;

type ExportRecordView = {
  readonly id: string;
  readonly asOf: string;
  readonly format: 'json';
  readonly status: 'queued' | 'processing' | 'ready' | 'failed';
  readonly resourceUri: string;
  readonly contentHash: string | null;
  readonly artifactJson: string | null;
  readonly expiresAt: Date;
};

/** 受控导出应用服务：R2 执行后入队，资源读取再次按可信租户与发起人约束。 */
@Injectable()
export class AnalyticsExportService {
  private readonly logger = new Logger(AnalyticsExportService.name);

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
    const trusted = this.assertRequestAccess();
    if (!ULID_PATTERN.test(exportId)) {
      throw new BadRequestException({
        code: 'ANALYTICS_EXPORT_ID_INVALID',
        message: '分析导出标识必须是 ULID',
      });
    }
    this.dashboard.validateAsOf(asOf);
    const record = {
      id: exportId,
      tenantId: trusted.tenant.tenantId,
      requestedBy: trusted.actor.actorId,
      asOf,
      format: 'json' as const,
      generation: 1,
      status: 'queued' as const,
      resourceUri: `erp://analytics/exports/${exportId}`,
      artifactJson: null,
      contentHash: null,
      failureCode: null,
      processingStartedAt: null,
      processingJobId: null,
      processingToken: null,
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
    };
    try {
      await this.exports.create(record);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      return this.handleExistingRequest(exportId, asOf, error);
    }
    await this.enqueueOrFail(record);
    return view(record);
  }

  async get(exportId: string): Promise<AnalyticsExportView> {
    this.assertExportReadAccess();
    if (!ULID_PATTERN.test(exportId)) throw new NotFoundException();
    return view(await this.findOwned(exportId));
  }

  async process(input: AnalyticsExportJobData, processingJobId: string): Promise<void> {
    assertProcessInput(input, processingJobId);
    const processingToken = randomBytes(16).toString('base64url');
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const claimed = await this.exports.findOneAndUpdate(
      {
        id: input.exportId,
        tenantId: input.tenantId,
        requestedBy: input.requestedBy,
        generation: input.generation,
        expiresAt: { $gt: now },
        $or: [
          { status: { $in: ['queued', 'failed'] } },
          { status: 'processing', processingJobId },
          { status: 'processing', processingStartedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: {
          status: 'processing',
          processingStartedAt: now,
          processingJobId,
          processingToken,
          failureCode: null,
        },
      },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (claimed === null) return;

    let artifactJson: string;
    let contentHash: string;
    try {
      const dashboard = await this.context.run({
        tenant: { tenantId: input.tenantId, source: 'service_identity' },
        actor: {
          actorId: 'system:analytics-export',
          actorType: 'system_job',
          tenantId: input.tenantId,
          roleCodes: [],
          scopes: ['erp:analytics:management:read'],
          departmentIds: [],
          traceId: input.exportId,
        },
      }, () => this.dashboard.get(claimed.asOf));
      const artifact = analyticsExportArtifactSchema.parse({
        schemaVersion: 'management-dashboard-export.v1',
        exportedAt: new Date().toISOString(),
        dashboard,
      });
      artifactJson = JSON.stringify(artifact);
      if (Buffer.byteLength(artifactJson, 'utf8') > MAX_ARTIFACT_BYTES) {
        throw new Error('ANALYTICS_EXPORT_ARTIFACT_TOO_LARGE');
      }
      contentHash = createHash('sha256').update(artifactJson, 'utf8').digest('base64url');
    } catch (error) {
      await this.failClaim(
        input,
        processingJobId,
        processingToken,
        claimed.asOf,
        error,
      );
      throw error;
    }

    const updated = await this.exports.findOneAndUpdate(
      {
        id: input.exportId,
        tenantId: input.tenantId,
        requestedBy: input.requestedBy,
        generation: input.generation,
        status: 'processing',
        processingJobId,
        processingToken,
      },
      {
        $set: {
          status: 'ready',
          processingStartedAt: null,
          processingJobId: null,
          processingToken: null,
          artifactJson,
          contentHash,
          failureCode: null,
        },
      },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (updated === null) throw new Error('ANALYTICS_EXPORT_LEASE_LOST');
    await this.auditAfterDecision(input.tenantId, {
      action: 'analytics.management_dashboard.export.generate',
      resourceType: 'analytics_export',
      resourceId: input.exportId,
      riskLevel: 'R2',
      outcome: 'success',
      traceId: input.exportId,
      metadata: { asOf: claimed.asOf, contentHash, generation: input.generation },
    }, {
      code: 'ANALYTICS_EXPORT_SUCCESS_AUDIT_AFTER_COMMIT_FAILED',
      tenantId: input.tenantId,
      exportId: input.exportId,
    });
  }

  private assertRequestAccess() {
    const trusted = this.context.getRequired();
    const missing = ['erp:analytics:management:read', 'erp:analytics:management:export']
      .find((scope) => !trusted.actor.scopes.includes(scope));
    if (trusted.actor.actorType !== 'user' || missing !== undefined) {
      throw new ForbiddenException({
        code: 'ANALYTICS_EXPORT_REQUEST_DENIED',
        message: '分析导出只允许具备读取与导出权限的当前用户发起',
      });
    }
    return trusted;
  }

  private assertExportReadAccess(): void {
    if (!this.context.getActorRequired().scopes.includes('erp:analytics:management:export')) {
      throw new ForbiddenException({
        code: 'ANALYTICS_EXPORT_READ_DENIED',
        message: '当前身份无权读取分析导出',
      });
    }
  }

  private async handleExistingRequest(
    exportId: string,
    asOf: string,
    duplicateError: unknown,
  ): Promise<AnalyticsExportView> {
    let existing = await this.findOwned(exportId);
    if (existing.asOf !== asOf) {
      throw new ConflictException({
        code: 'ANALYTICS_EXPORT_ID_REUSED',
        message: '同一分析导出标识不能绑定不同口径日',
      }, { cause: duplicateError });
    }
    if (existing.status === 'failed') {
      const requeued = await this.exports.findOneAndUpdate(
        {
          id: existing.id,
          tenantId: existing.tenantId,
          requestedBy: existing.requestedBy,
          generation: existing.generation,
          status: 'failed',
        },
        {
          $set: {
            status: 'queued',
            failureCode: null,
            processingStartedAt: null,
            processingJobId: null,
            processingToken: null,
            artifactJson: null,
            contentHash: null,
          },
          $inc: { generation: 1 },
        },
        { returnDocument: 'after', runValidators: true },
      ).lean().exec();
      existing = requeued ?? await this.findOwned(exportId);
    }
    if (existing.status === 'queued') await this.enqueueOrFail(existing);
    return view(existing);
  }

  private async findOwned(exportId: string) {
    const trusted = this.context.getRequired();
    const record = await this.exports.findOne({
      id: exportId,
      tenantId: trusted.tenant.tenantId,
      requestedBy: trusted.actor.actorId,
      expiresAt: { $gt: new Date() },
    }).lean().exec();
    if (record === null) {
      throw new NotFoundException({
        code: 'ANALYTICS_EXPORT_NOT_FOUND',
        message: '分析导出不存在或已过期',
      });
    }
    return record;
  }

  private async enqueueOrFail(record: {
    readonly id: string;
    readonly tenantId: string;
    readonly requestedBy: string;
    readonly generation: number;
  }): Promise<void> {
    const data: AnalyticsExportJobData = {
      exportId: record.id,
      tenantId: record.tenantId,
      requestedBy: record.requestedBy,
      generation: record.generation,
    };
    try {
      await this.queue.add(ANALYTICS_GENERATE_EXPORT_JOB, data, {
        jobId: createAnalyticsExportJobId(data),
        attempts: 4,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 604_800, count: 10_000 },
      });
    } catch (error) {
      await this.markQueueFailure(record.id, record.tenantId, record.generation);
      throw error;
    }
  }

  private async markQueueFailure(
    exportId: string,
    tenantId: string,
    generation: number,
  ): Promise<void> {
    await this.exports.updateOne(
      { id: exportId, tenantId, generation, status: 'queued' },
      {
        $set: {
          status: 'failed',
          processingStartedAt: null,
          processingJobId: null,
          processingToken: null,
          artifactJson: null,
          contentHash: null,
          failureCode: 'ANALYTICS_EXPORT_QUEUE_UNAVAILABLE',
        },
      },
      { runValidators: true },
    ).exec();
  }

  private async failClaim(
    input: AnalyticsExportJobData,
    processingJobId: string,
    processingToken: string,
    asOf: string,
    error: unknown,
  ): Promise<void> {
    const failureCode = safeFailure(error);
    const updated = await this.exports.updateOne(
      {
        id: input.exportId,
        tenantId: input.tenantId,
        requestedBy: input.requestedBy,
        generation: input.generation,
        status: 'processing',
        processingJobId,
        processingToken,
      },
      {
        $set: {
          status: 'failed',
          processingStartedAt: null,
          processingJobId: null,
          processingToken: null,
          artifactJson: null,
          contentHash: null,
          failureCode,
        },
      },
      { runValidators: true },
    ).exec();
    if (updated.modifiedCount !== 1) throw new Error('ANALYTICS_EXPORT_LEASE_LOST');
    await this.auditAfterDecision(input.tenantId, {
      action: 'analytics.management_dashboard.export.generate',
      resourceType: 'analytics_export',
      resourceId: input.exportId,
      riskLevel: 'R2',
      outcome: 'failure',
      traceId: input.exportId,
      metadata: { asOf, failureCode, generation: input.generation },
    }, {
      code: 'ANALYTICS_EXPORT_FAILURE_AUDIT_AFTER_DECISION_FAILED',
      tenantId: input.tenantId,
      exportId: input.exportId,
    });
  }

  private async auditAfterDecision(
    tenantId: string,
    input: SystemAuditRecordInput,
    context: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      await this.audit.recordSystem(tenantId, input);
    } catch {
      this.logger.error(context);
    }
  }
}

function view(record: ExportRecordView): AnalyticsExportView {
  if (!(record.expiresAt instanceof Date) || Number.isNaN(record.expiresAt.getTime())) {
    throw new Error('ANALYTICS_EXPORT_RECORD_INVALID');
  }
  let artifact: unknown = null;
  if (record.artifactJson !== null) {
    const actualHash = createHash('sha256').update(record.artifactJson, 'utf8').digest('base64url');
    if (record.contentHash === null || actualHash !== record.contentHash) {
      throw new Error('ANALYTICS_EXPORT_INTEGRITY_FAILED');
    }
    try {
      artifact = JSON.parse(record.artifactJson) as unknown;
    } catch {
      throw new Error('ANALYTICS_EXPORT_ARTIFACT_INVALID');
    }
  }
  const parsed = analyticsExportViewSchema.safeParse({
    id: record.id,
    asOf: record.asOf,
    format: record.format,
    status: record.status,
    resourceUri: record.resourceUri,
    contentHash: record.contentHash,
    artifact,
    expiresAt: record.expiresAt.toISOString(),
  });
  if (!parsed.success) throw new Error('ANALYTICS_EXPORT_RECORD_INVALID');
  return deepFreeze(parsed.data);
}

function assertProcessInput(input: AnalyticsExportJobData, processingJobId: string): void {
  if (
    !ULID_PATTERN.test(input.exportId) ||
    !ID.test(input.tenantId) ||
    !ID.test(input.requestedBy) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !JOB_ID.test(processingJobId) ||
    processingJobId !== createAnalyticsExportJobId(input)
  ) {
    throw new Error('ANALYTICS_EXPORT_JOB_INVALID');
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === 11000;
}

function safeFailure(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,95}$/.test(error.message)
    ? error.message : 'ANALYTICS_EXPORT_GENERATION_FAILED';
}
