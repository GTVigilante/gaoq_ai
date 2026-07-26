import { createHash } from 'node:crypto';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { AttendanceApplicationService } from '../attendance/application/attendance-application.service.js';
import { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import { AttendanceProviderRegistry } from './attendance-provider.adapter.js';
import { AttendanceProviderPullService } from './attendance-provider-pull.service.js';
import {
  AttendanceProviderEmployeeMappingRecord,
  type AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderInboxRecord,
  type AttendanceProviderInboxDocument,
  AttendanceProviderStateRecord,
  type AttendanceProviderStateDocument,
} from './attendance-provider.schemas.js';
import {
  ATTENDANCE_PROVIDER_PROCESS_JOB,
  ATTENDANCE_PROVIDER_PULL_JOB,
  ATTENDANCE_PROVIDER_QUEUE,
  ATTENDANCE_PROVIDER_SCAN_JOB,
  type AttendanceProviderJobData,
} from './attendance-provider.queue.js';

const tenantIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const pullJobSchema = z.object({
  tenantId: tenantIdSchema, stateId: z.string().regex(ULID_PATTERN),
}).strict();
const processJobSchema = z.object({
  tenantId: tenantIdSchema, inboxId: z.string().regex(ULID_PATTERN),
}).strict();
const protectedEnvelopeSchema = z.object({
  payload: z.unknown(),
  transportRequestId: z.string().min(8).max(256).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
const PROCESSING_LEASE_MS = 15 * 60 * 1_000;

@Processor(ATTENDANCE_PROVIDER_QUEUE, { concurrency: 4, limiter: { max: 20, duration: 1_000 } })
export class AttendanceProviderProcessor extends WorkerHost {
  constructor(
    @InjectModel(AttendanceProviderStateRecord.name)
    private readonly states: Model<AttendanceProviderStateDocument>,
    @InjectModel(AttendanceProviderEmployeeMappingRecord.name)
    private readonly mappings: Model<AttendanceProviderEmployeeMappingDocument>,
    @InjectModel(AttendanceProviderInboxRecord.name)
    private readonly inbox: Model<AttendanceProviderInboxDocument>,
    private readonly context: TenantContextService,
    private readonly audit: AuditService,
    private readonly pull: AttendanceProviderPullService,
    private readonly attendance: AttendanceApplicationService,
    private readonly crypto: AttendanceDataCryptoService,
    private readonly registry: AttendanceProviderRegistry,
  ) { super(); }

  override async process(job: Job<AttendanceProviderJobData>): Promise<number> {
    if (job.name === ATTENDANCE_PROVIDER_SCAN_JOB) {
      z.object({}).strict().parse(job.data);
      return this.pull.enqueueDueStates();
    }
    if (job.name === ATTENDANCE_PROVIDER_PULL_JOB) {
      const data = pullJobSchema.parse(job.data);
      return this.runTrusted(data.tenantId, data.stateId, 'pull', async () => {
        try {
          const count = await this.pull.pullState(data.stateId);
          await this.audit.record({
            action: 'integration.attendance_provider.pull',
            resourceType: 'attendance_provider_state', resourceId: data.stateId,
            riskLevel: 'R1', outcome: 'success', metadata: { eventCount: count },
          });
          return count;
        } catch (error) {
          await this.audit.record({
            action: 'integration.attendance_provider.pull',
            resourceType: 'attendance_provider_state', resourceId: data.stateId,
            riskLevel: 'R1', outcome: 'failure', metadata: { failureCode: failureCode(error) },
          });
          throw error;
        }
      });
    }
    if (job.name !== ATTENDANCE_PROVIDER_PROCESS_JOB) {
      throw new Error('ATTENDANCE_PROVIDER_JOB_UNKNOWN');
    }
    const data = processJobSchema.parse(job.data);
    return this.runTrusted(data.tenantId, data.inboxId, 'process', () =>
      this.processInbox(data.tenantId, data.inboxId));
  }

  private async processInbox(tenantId: string, inboxId: string): Promise<number> {
    const staleAt = new Date(Date.now() - PROCESSING_LEASE_MS);
    const claimed = await this.inbox.findOneAndUpdate(
      {
        tenantId, id: inboxId,
        $or: [
          { status: { $in: ['pending', 'failed'] } },
          { status: 'processing', processingStartedAt: { $lte: staleAt } },
        ],
      },
      {
        $set: { status: 'processing', processingStartedAt: new Date(), failureCode: null },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (claimed === null) return 0;
    try {
      const protectedEnvelope = protectedEnvelopeSchema.parse(this.crypto.unprotect({
        tenantId, resourceType: 'provider_inbox', resourceId: claimed.id,
      }, {
        keyId: claimed.payloadKeyId, iv: claimed.payloadIv,
        ciphertext: claimed.payloadCiphertext, authTag: claimed.payloadAuthTag,
      }));
      if (digest(['request', protectedEnvelope.transportRequestId]) !== claimed.transportRequestIdFingerprint) {
        await this.finishReview(claimed, 'ATTENDANCE_PROVIDER_TRANSPORT_EVIDENCE_MISMATCH', null);
        return 1;
      }
      const verifier = this.registry.verifier(claimed.providerCode);
      if (!verifier.verify(protectedEnvelope.payload, protectedEnvelope.transportRequestId)) {
        await this.finishReview(claimed, 'ATTENDANCE_PROVIDER_EVIDENCE_UNVERIFIED', null);
        return 1;
      }
      const state = await this.states.findOne({
        tenantId, id: claimed.stateId, providerCode: claimed.providerCode, status: 'active',
      }).lean().exec();
      if (state === null) throw new Error('ATTENDANCE_PROVIDER_STATE_NOT_FOUND');
      const normalizer = this.registry.normalizer(claimed.providerCode);
      if (
        (claimed.normalizerVersion === null) !== (claimed.evidenceVerifiedAt === null) ||
        (claimed.normalizerVersion !== null && claimed.normalizerVersion !== normalizer.schemaVersion)
      ) {
        await this.finishReview(
          claimed, 'ATTENDANCE_PROVIDER_NORMALIZER_VERSION_CHANGED',
          claimed.normalizerVersion ?? normalizer.schemaVersion,
        );
        return 1;
      }
      let normalized: ReturnType<typeof normalizer.normalize>;
      try {
        normalized = normalizer.normalize(protectedEnvelope.payload, state.timeZone);
      } catch {
        await this.finishReview(
          claimed, 'ATTENDANCE_PROVIDER_NORMALIZED_PAYLOAD_INVALID', normalizer.schemaVersion,
        );
        return 1;
      }
      if (claimed.normalizerVersion === null) {
        const checkpoint = await this.inbox.updateOne(
          { tenantId, id: claimed.id, status: 'processing', normalizerVersion: null },
          { $set: {
            normalizerVersion: normalizer.schemaVersion, evidenceVerifiedAt: new Date(),
          } },
          { runValidators: true },
        );
        if (checkpoint.modifiedCount !== 1) {
          throw new Error('ATTENDANCE_PROVIDER_INBOX_LEASE_LOST');
        }
      }
      const employeeId = await this.resolveEmployee(
        tenantId, claimed.providerCode, normalized.externalEmployeeId,
      );
      if (employeeId === null) {
        await this.finishReview(
          claimed, 'ATTENDANCE_PROVIDER_EMPLOYEE_UNBOUND', normalizer.schemaVersion,
        );
        return 1;
      }
      const result = await this.attendance.ingest(
        `attendance-provider-${digest([tenantId, claimed.id])}`,
        {
          employeeId, providerCode: claimed.providerCode,
          externalEventId: normalized.externalEventId, factType: normalized.factType,
          occurredAt: normalized.occurredAt, timeZone: normalized.timeZone,
          impact: normalized.impact, sourceObservedAt: normalized.sourceObservedAt,
        },
      );
      const updated = await this.inbox.updateOne(
        { tenantId, id: claimed.id, status: 'processing' },
        { $set: {
          status: 'completed', processingStartedAt: null, processedAt: new Date(),
          failureCode: null, normalizerVersion: normalizer.schemaVersion,
          evidenceVerifiedAt: new Date(), sourceFactId: result.fact.id,
        } },
        { runValidators: true },
      );
      if (updated.modifiedCount !== 1) throw new Error('ATTENDANCE_PROVIDER_INBOX_LEASE_LOST');
      await this.audit.record({
        action: 'integration.attendance_provider.fact.ingest',
        resourceType: 'attendance_source_fact', resourceId: result.fact.id,
        riskLevel: 'R1', outcome: 'success', metadata: {
          providerCode: claimed.providerCode, normalizerVersion: normalizer.schemaVersion,
        },
      });
      return 1;
    } catch (error) {
      await this.failInbox(claimed, failureCode(error));
      await this.audit.record({
        action: 'integration.attendance_provider.fact.ingest',
        resourceType: 'attendance_provider_inbox', resourceId: claimed.id,
        riskLevel: 'R1', outcome: 'failure', metadata: {
          providerCode: claimed.providerCode, failureCode: failureCode(error),
        },
      });
      throw error;
    }
  }

  private async resolveEmployee(
    tenantId: string,
    providerCode: 'dingtalk' | 'feishu',
    externalEmployeeId: string,
  ): Promise<string | null> {
    const fingerprints = this.crypto.providerFingerprints(
      tenantId, 'employee', providerCode, externalEmployeeId,
    );
    const mappings = await this.mappings.find({
      tenantId, providerCode, status: 'active',
      externalIdBlindIndexes: { $in: [...fingerprints] },
    }, { employeeId: 1, _id: 0 }).limit(2).lean().exec();
    if (mappings.length > 1) throw new Error('ATTENDANCE_PROVIDER_EMPLOYEE_MAPPING_CONFLICT');
    return mappings[0]?.employeeId ?? null;
  }

  private async finishReview(
    inbox: AttendanceProviderInboxRecord,
    code: string,
    normalizerVersion: string | null,
  ): Promise<void> {
    const updated = await this.inbox.updateOne(
      { tenantId: inbox.tenantId, id: inbox.id, status: 'processing' },
      { $set: {
        status: 'manual_review', processingStartedAt: null, processedAt: new Date(),
        failureCode: code, normalizerVersion,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('ATTENDANCE_PROVIDER_INBOX_LEASE_LOST');
    await this.audit.record({
      action: 'integration.attendance_provider.fact.review',
      resourceType: 'attendance_provider_inbox', resourceId: inbox.id,
      riskLevel: 'R2', outcome: 'failure', metadata: {
        providerCode: inbox.providerCode, failureCode: code,
        ...(normalizerVersion === null ? {} : { normalizerVersion }),
      },
    });
  }

  private async failInbox(inbox: AttendanceProviderInboxRecord, code: string): Promise<void> {
    const updated = await this.inbox.updateOne(
      { tenantId: inbox.tenantId, id: inbox.id, status: 'processing' },
      { $set: {
        status: 'failed', processingStartedAt: null, processedAt: null, failureCode: code,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('ATTENDANCE_PROVIDER_INBOX_LEASE_LOST');
  }

  private runTrusted<T>(
    tenantId: string,
    traceId: string,
    mode: 'pull' | 'process',
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.context.run({
      tenant: { tenantId, source: 'service_identity' },
      actor: {
        actorId: 'system:attendance-provider', actorType: 'system_job', tenantId,
        roleCodes: ['ATTENDANCE_PROVIDER_WORKER'],
        scopes: mode === 'pull'
          ? ['erp:attendance:provider:pull']
          : ['erp:attendance:provider:process', 'erp:attendance:source:ingest'],
        departmentIds: [], traceId,
      },
    }, operation);
  }
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'ATTENDANCE_PROVIDER_PROCESSING_FAILED';
}
