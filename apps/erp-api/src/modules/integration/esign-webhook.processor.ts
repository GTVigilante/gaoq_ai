import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { AuditService } from '../../core/audit/audit.service.js';
import { ESignFlowRecord, type ESignFlowDocument, type ESignFlowStatus } from './esign-flow.schema.js';
import { hashExternalFlowId } from './esign-flow.service.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import {
  ESignWebhookInboxRecord,
  type ESignWebhookInboxDocument,
} from './esign-webhook-inbox.schema.js';
import {
  ESIGN_PROCESS_WEBHOOK_JOB,
  ESIGN_WEBHOOK_QUEUE,
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
const TERMINAL_STATUSES = new Set<ESignFlowStatus>([
  'provider_completed', 'completed', 'rejected', 'expired', 'cancelled',
]);

export interface ESignFlowProjection {
  readonly status: ESignFlowStatus;
  readonly providerStatus: number | null;
  readonly reviewRequired: boolean;
  readonly reviewCode: string | null;
  readonly changed: boolean;
}

/** eSign 回调 Worker；仅投影供应商状态，不在未归档签署文件时标记 Offer 已签。 */
@Processor(ESIGN_WEBHOOK_QUEUE, { concurrency: 4, limiter: { max: 20, duration: 1_000 } })
export class ESignWebhookProcessor extends WorkerHost {
  constructor(
    @InjectModel(ESignWebhookInboxRecord.name)
    private readonly inbox: Model<ESignWebhookInboxDocument>,
    @InjectModel(ESignFlowRecord.name)
    private readonly flows: Model<ESignFlowDocument>,
    private readonly crypto: ESignWebhookCryptoService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  override async process(job: Job<ESignWebhookJobData>): Promise<number> {
    if (job.name !== ESIGN_PROCESS_WEBHOOK_JOB) throw new Error('ESIGN_WEBHOOK_JOB_UNKNOWN');
    const claimed = await this.inbox.findOneAndUpdate(
      {
        tenantId: job.data.tenantId, id: job.data.inboxId,
        status: { $in: ['pending', 'processing', 'failed'] },
      },
      {
        $set: { status: 'processing', processingStartedAt: new Date(), failureCode: null },
        $inc: { attempts: 1 },
      },
      { new: true, runValidators: true },
    ).lean().exec();
    if (claimed === null) return 0;
    try {
      if (!KNOWN_ACTIONS.has(claimed.action)) {
        await this.audit.recordSystem(claimed.tenantId, {
          action: 'integration.esign.webhook.ignore', resourceType: 'esign_webhook_inbox',
          resourceId: claimed.id, riskLevel: 'R1', outcome: 'success', traceId: claimed.id,
          metadata: { providerAction: claimed.action, reasonCode: 'ESIGN_ACTION_UNKNOWN' },
        });
        await this.finishInbox(claimed.tenantId, claimed.id, 'ignored', 'ESIGN_ACTION_UNKNOWN');
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
        await this.finishInbox(claimed.tenantId, claimed.id, 'ignored', 'ESIGN_EVENT_OUT_OF_ORDER');
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
      await this.audit.recordSystem(claimed.tenantId, {
        action: 'integration.esign.webhook.apply', resourceType: 'esign_flow',
        resourceId: flow.id, riskLevel: 'R2',
        outcome: projection.reviewRequired ? 'failure' : 'success', traceId: claimed.id,
        metadata: {
          providerAction: envelope.action, flowStatus: projection.status,
          providerStatus: projection.providerStatus ?? -1,
          reviewRequired: projection.reviewRequired,
        },
      });
      await this.finishInbox(claimed.tenantId, claimed.id, 'completed', null);
      return 1;
    } catch (error) {
      await this.finishInbox(claimed.tenantId, claimed.id, 'failed', failureCode(error));
      throw error;
    }
  }

  private async finishInbox(
    tenantId: string,
    id: string,
    status: 'completed' | 'ignored' | 'failed',
    failureCode: string | null,
  ): Promise<void> {
    const updated = await this.inbox.updateOne(
      { tenantId, id, status: 'processing' },
      { $set: {
        status, failureCode, processedAt: status === 'failed' ? null : new Date(),
        processingStartedAt: null,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('ESIGN_WEBHOOK_INBOX_LEASE_LOST');
  }
}

export function projectESignFlow(
  current: ESignFlowStatus,
  currentProviderStatus: number | null,
  currentReviewRequired: boolean,
  currentReviewCode: string | null,
  action: 'SIGN_MISSON_COMPLETE' | 'SIGN_FLOW_COMPLETE',
  providerStatus: number | null,
): ESignFlowProjection {
  if (action === 'SIGN_MISSON_COMPLETE') {
    const status = current === 'awaiting_signature' ? 'partial_signed' : current;
    return Object.freeze({
      status, providerStatus: currentProviderStatus,
      reviewRequired: currentReviewRequired, reviewCode: currentReviewCode,
      changed: status !== current,
    });
  }
  const target = mapProviderStatus(providerStatus);
  if (target === null) return Object.freeze({
    status: current, providerStatus, reviewRequired: true,
    reviewCode: 'ESIGN_PROVIDER_STATUS_UNKNOWN', changed: true,
  });
  if (current === 'completed') return Object.freeze({
    status: current, providerStatus: currentProviderStatus,
    reviewRequired: target !== 'provider_completed' || currentReviewRequired,
    reviewCode: target === 'provider_completed' ? null : 'ESIGN_TERMINAL_STATUS_CONFLICT',
    changed: target !== 'provider_completed',
  });
  if (TERMINAL_STATUSES.has(current) && current !== target) return Object.freeze({
    status: current, providerStatus: currentProviderStatus, reviewRequired: true,
    reviewCode: 'ESIGN_TERMINAL_STATUS_CONFLICT', changed: true,
  });
  return Object.freeze({
    status: target, providerStatus, reviewRequired: currentReviewRequired,
    reviewCode: currentReviewCode,
    changed: target !== current || providerStatus !== currentProviderStatus,
  });
}

function mapProviderStatus(status: number | null): ESignFlowStatus | null {
  switch (status) {
    case 2: return 'provider_completed';
    case 3: return 'cancelled';
    case 5: return 'expired';
    case 7: return 'rejected';
    default: return null;
  }
}

function failureCode(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'ESIGN_WEBHOOK_BODY_INVALID';
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'ESIGN_WEBHOOK_PROCESSING_FAILED';
}
