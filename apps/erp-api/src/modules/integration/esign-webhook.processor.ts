import { randomBytes } from 'node:crypto';

import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Job, Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { z } from 'zod';

import {
  AuditService,
  type SystemAuditRecordInput,
} from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { ESignEvidenceService } from './esign-evidence.service.js';
import { ESignReconciliationService } from './esign-reconciliation.service.js';
import { projectESignFlow } from './esign-flow-projection.js';
import { ESignFlowRecord, type ESignFlowDocument } from './esign-flow.schema.js';
import { hashExternalFlowId } from './esign-flow.service.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import {
  ESignWebhookInboxRecord,
  type ESignWebhookInboxDocument,
} from './esign-webhook-inbox.schema.js';
import {
  ESIGN_PROCESS_WEBHOOK_JOB,
  ESIGN_ARCHIVE_EVIDENCE_JOB,
  ESIGN_RECONCILE_FLOWS_JOB,
  ESIGN_WEBHOOK_QUEUE,
  createESignEvidenceJobId,
  createESignWebhookJobId,
  type ESignEvidenceArchiveJobData,
  type ESignQueueJobData,
  type ESignWebhookJobData,
} from './esign-webhook.queue.js';

const knownEnvelopeSchema = z.object({
  action: z.enum(['SIGN_MISSON_COMPLETE', 'SIGN_FLOW_COMPLETE']),
  timestamp: z.number().int().nonnegative(),
  data: z.object({
    signFlowId: z.string().min(1).max(128),
    signFlowStatus: z.number().int().min(0).max(99).optional(),
  }).passthrough(),
}).passthrough();

const KNOWN_ACTIONS = new Set(['SIGN_MISSON_COMPLETE', 'SIGN_FLOW_COMPLETE']);
const tenantIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const webhookJobSchema = z.object({
  inboxId: z.string().regex(ULID_PATTERN),
  tenantId: tenantIdSchema,
  providerEventId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
const evidenceJobSchema = z.object({
  flowId: z.string().regex(ULID_PATTERN), tenantId: tenantIdSchema,
}).strict();
const reconciliationJobSchema = z.object({}).strict();
const PROCESSING_LEASE_MS = 15 * 60 * 1_000;

/** eSign 回调 Worker；仅投影供应商状态，不在未归档签署文件时标记 Offer 已签。 */
@Processor(ESIGN_WEBHOOK_QUEUE, { concurrency: 4, limiter: { max: 20, duration: 1_000 } })
export class ESignWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(ESignWebhookProcessor.name);

  constructor(
    @InjectModel(ESignWebhookInboxRecord.name)
    private readonly inbox: Model<ESignWebhookInboxDocument>,
    @InjectModel(ESignFlowRecord.name)
    private readonly flows: Model<ESignFlowDocument>,
    private readonly crypto: ESignWebhookCryptoService,
    private readonly audit: AuditService,
    private readonly evidence: ESignEvidenceService,
    private readonly reconciliation: ESignReconciliationService,
    private readonly context: TenantContextService,
    @InjectQueue(ESIGN_WEBHOOK_QUEUE)
    private readonly queue: Queue<ESignQueueJobData>,
  ) {
    super();
  }

  override async process(job: Job<ESignQueueJobData>): Promise<number> {
    if (job.name === ESIGN_RECONCILE_FLOWS_JOB) {
      reconciliationJobSchema.parse(job.data);
      return this.reconciliation.runStaleBatch();
    }
    if (job.name === ESIGN_ARCHIVE_EVIDENCE_JOB) {
      const data: ESignEvidenceArchiveJobData = evidenceJobSchema.parse(job.data);
      if (String(job.id ?? '') !== createESignEvidenceJobId(data.tenantId, data.flowId)) {
        throw new Error('ESIGN_EVIDENCE_JOB_ID_MISMATCH');
      }
      await this.context.run({
        tenant: { tenantId: data.tenantId, source: 'service_identity' },
        actor: {
          actorType: 'system_job', actorId: 'system:esign-evidence',
          tenantId: data.tenantId, roleCodes: ['INTEGRATION_WORKER'],
          scopes: [
            'erp:integration:esign:archive', 'erp:integration:esign:apply',
            'erp:recruitment:offer:read_all',
          ],
          departmentIds: [], traceId: data.flowId,
        },
      }, async () => this.evidence.archiveCompletedFlow(data.flowId));
      return 1;
    }
    if (job.name !== ESIGN_PROCESS_WEBHOOK_JOB) throw new Error('ESIGN_WEBHOOK_JOB_UNKNOWN');
    const webhookData: ESignWebhookJobData = webhookJobSchema.parse(job.data);
    const jobId = String(job.id ?? '');
    if (jobId !== createESignWebhookJobId(
      webhookData.tenantId,
      webhookData.inboxId,
      webhookData.providerEventId,
    )) throw new Error('ESIGN_WEBHOOK_JOB_ID_MISMATCH');
    const processingToken = randomBytes(16).toString('base64url');
    const staleAt = new Date(Date.now() - PROCESSING_LEASE_MS);
    const claimed = await this.inbox.findOneAndUpdate(
      {
        tenantId: webhookData.tenantId, id: webhookData.inboxId,
        $or: [
          { status: { $in: ['pending', 'failed'] } },
          { status: 'processing', processingStartedAt: { $lte: staleAt } },
        ],
      },
      {
        $set: {
          status: 'processing',
          processingStartedAt: new Date(),
          processingToken,
          processingJobId: jobId,
          failureCode: null,
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (claimed === null) return 0;
    if (
      claimed.providerEventId !== webhookData.providerEventId ||
      claimed.processingToken !== processingToken ||
      claimed.processingJobId !== jobId
    ) throw new Error('ESIGN_WEBHOOK_CLAIM_INTEGRITY_INVALID');
    const lease = Object.freeze({
      attempts: claimed.attempts,
      processingToken,
      processingJobId: jobId,
    });
    try {
      if (!KNOWN_ACTIONS.has(claimed.action)) {
        await this.auditSystemAfterBusiness(claimed.tenantId, {
          action: 'integration.esign.webhook.ignore', resourceType: 'esign_webhook_inbox',
          resourceId: claimed.id, riskLevel: 'R1', outcome: 'success', traceId: claimed.id,
          metadata: { providerAction: claimed.action, reasonCode: 'ESIGN_ACTION_UNKNOWN' },
        }, {
          code: 'ESIGN_WEBHOOK_IGNORE_AUDIT_FAILED',
          tenantId: claimed.tenantId, inboxId: claimed.id,
        });
        await this.finishInbox(
          claimed.tenantId, claimed.id, lease, 'ignored', 'ESIGN_ACTION_UNKNOWN',
        );
        return 1;
      }
      const raw = this.crypto.unprotect(claimed.tenantId, claimed.id, claimed);
      const envelope = knownEnvelopeSchema.parse(JSON.parse(raw.toString('utf8')) as unknown);
      if (
        envelope.action !== claimed.action ||
        envelope.timestamp !== claimed.providerOccurredAt.getTime()
      ) throw new Error('ESIGN_WEBHOOK_ENVELOPE_MISMATCH');
      if (envelope.action === 'SIGN_FLOW_COMPLETE' && envelope.data.signFlowStatus === undefined) {
        throw new Error('ESIGN_FLOW_STATUS_REQUIRED');
      }
      const externalFlowIdHash = hashExternalFlowId(claimed.appId, envelope.data.signFlowId);
      const flow = await this.flows.findOne({
        tenantId: claimed.tenantId, provider: 'esign_cn', appId: claimed.appId,
        externalFlowIdHash,
      }).lean().exec();
      if (flow === null) throw new Error('ESIGN_FLOW_UNBOUND');
      if (
        flow.providerOccurredAt !== null &&
        claimed.providerOccurredAt.getTime() < flow.providerOccurredAt.getTime()
      ) {
        await this.finishInbox(
          claimed.tenantId, claimed.id, lease, 'ignored', 'ESIGN_EVENT_OUT_OF_ORDER',
        );
        return 1;
      }
      const projection = projectESignFlow(
        flow.status, flow.providerStatus, flow.reviewRequired, flow.reviewCode,
        envelope.action, envelope.data.signFlowStatus ?? null,
      );
      if (projection.changed) {
        const updated = await this.flows.updateOne(
          { tenantId: flow.tenantId, id: flow.id, version: flow.version },
          { $set: {
            status: projection.status, providerStatus: projection.providerStatus,
            lastProviderAction: envelope.action, providerOccurredAt: claimed.providerOccurredAt,
            reviewRequired: projection.reviewRequired, reviewCode: projection.reviewCode,
            updatedAt: new Date(),
          }, $inc: { version: 1 } },
          { runValidators: true, timestamps: false },
        );
        if (updated.modifiedCount !== 1) throw new Error('ESIGN_FLOW_VERSION_CONFLICT');
      }
      await this.auditSystemAfterBusiness(claimed.tenantId, {
        action: 'integration.esign.webhook.apply', resourceType: 'esign_flow',
        resourceId: flow.id, riskLevel: 'R2',
        outcome: projection.reviewRequired ? 'failure' : 'success', traceId: claimed.id,
        metadata: {
          providerAction: envelope.action, flowStatus: projection.status,
          providerStatus: projection.providerStatus ?? -1,
          reviewRequired: projection.reviewRequired,
        },
      }, {
        code: 'ESIGN_WEBHOOK_APPLY_AUDIT_AFTER_COMMIT_FAILED',
        tenantId: claimed.tenantId, inboxId: claimed.id, flowId: flow.id,
      });
      if (projection.status === 'provider_completed') {
        await this.enqueueEvidence(flow.id, flow.tenantId);
      }
      await this.finishInbox(claimed.tenantId, claimed.id, lease, 'completed', null);
      return 1;
    } catch (error) {
      if (error instanceof Error && error.message === 'ESIGN_WEBHOOK_INBOX_LEASE_LOST') {
        throw error;
      }
      await this.finishInbox(
        claimed.tenantId, claimed.id, lease, 'failed', failureCode(error),
      );
      throw error;
    }
  }

  private async enqueueEvidence(flowId: string, tenantId: string): Promise<void> {
    await this.queue.add(
      ESIGN_ARCHIVE_EVIDENCE_JOB,
      { flowId, tenantId },
      {
        jobId: createESignEvidenceJobId(tenantId, flowId),
        attempts: 12,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 1_000,
        removeOnFail: true,
      },
    );
  }

  private async finishInbox(
    tenantId: string,
    id: string,
    lease: {
      readonly attempts: number;
      readonly processingToken: string;
      readonly processingJobId: string;
    },
    status: 'completed' | 'ignored' | 'failed',
    failureCode: string | null,
  ): Promise<void> {
    const updated = await this.inbox.updateOne(
      {
        tenantId,
        id,
        status: 'processing',
        attempts: lease.attempts,
        processingToken: lease.processingToken,
        processingJobId: lease.processingJobId,
      },
      { $set: {
        status, failureCode, processedAt: status === 'failed' ? null : new Date(),
        processingStartedAt: null,
        processingToken: null,
        processingJobId: null,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('ESIGN_WEBHOOK_INBOX_LEASE_LOST');
  }

  private async auditSystemAfterBusiness(
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

function failureCode(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'ESIGN_WEBHOOK_BODY_INVALID';
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'ESIGN_WEBHOOK_PROCESSING_FAILED';
}
