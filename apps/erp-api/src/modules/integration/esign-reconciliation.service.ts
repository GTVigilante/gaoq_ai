import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import { ESignAdapter } from './esign.adapter.js';
import { ESignBinding, type ESignBindingDocument } from './esign-binding.schema.js';
import { projectESignFlow } from './esign-flow-projection.js';
import { ESignFlowRecord, type ESignFlowDocument } from './esign-flow.schema.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import {
  ESIGN_ARCHIVE_EVIDENCE_JOB,
  ESIGN_WEBHOOK_QUEUE,
  createESignEvidenceJobId,
  type ESignQueueJobData,
} from './esign-webhook.queue.js';
import { ESignSecretResolver } from './esign-webhook.service.js';

const STALE_AFTER_MS = 10 * 60 * 1_000;

/** 每 15 分钟拉取长时间未更新流程，作为 Webhook 丢失的可验证补偿通道。 */
@Injectable()
export class ESignReconciliationService {
  private readonly logger = new Logger(ESignReconciliationService.name);

  constructor(
    private readonly adapter: ESignAdapter,
    private readonly secrets: ESignSecretResolver,
    private readonly crypto: ESignWebhookCryptoService,
    private readonly audit: AuditService,
    @InjectModel(ESignBinding.name)
    private readonly bindings: Model<ESignBindingDocument>,
    @InjectModel(ESignFlowRecord.name)
    private readonly flows: Model<ESignFlowDocument>,
    @InjectQueue(ESIGN_WEBHOOK_QUEUE)
    private readonly queue: Queue<ESignQueueJobData>,
  ) {}

  async runStaleBatch(now = new Date(), limit = 50): Promise<number> {
    const candidates = await this.flows.find({
      status: { $in: ['awaiting_signature', 'partial_signed', 'provider_completed'] },
      reviewRequired: false,
      updatedAt: { $lte: new Date(now.getTime() - STALE_AFTER_MS) },
    }).sort({ updatedAt: 1 }).limit(Math.max(1, Math.min(limit, 100))).lean().exec();
    let processed = 0;
    for (const flow of candidates) {
      try {
        await this.reconcileOne(flow, now);
        processed += 1;
      } catch (error) {
        await this.auditSystemAfterBusiness(flow.tenantId, {
          action: 'integration.esign.reconcile', resourceType: 'esign_flow',
          resourceId: flow.id, riskLevel: 'R2', outcome: 'failure', traceId: flow.id,
          metadata: { failureCode: safeFailureCode(error) },
        }, {
          code: 'ESIGN_RECONCILIATION_FAILURE_AUDIT_FAILED',
          tenantId: flow.tenantId,
          flowId: flow.id,
        });
      }
    }
    return processed;
  }

  private async reconcileOne(flow: ESignFlowRecord, observedAt: Date): Promise<void> {
    if (flow.status === 'provider_completed') {
      await this.enqueueEvidence(flow.id, flow.tenantId);
      await this.auditSystemAfterBusiness(flow.tenantId, {
        action: 'integration.esign.reconcile', resourceType: 'esign_flow',
        resourceId: flow.id, riskLevel: 'R2', outcome: 'success', traceId: flow.id,
        metadata: { providerStatus: flow.providerStatus ?? 2, flowStatus: flow.status },
      }, {
        code: 'ESIGN_RECONCILIATION_RECOVERY_AUDIT_AFTER_COMMIT_FAILED',
        tenantId: flow.tenantId,
        flowId: flow.id,
      });
      return;
    }
    const binding = await this.bindings.findOne({
      tenantId: flow.tenantId, provider: 'esign_cn', appId: flow.appId, status: 'active',
    }).lean().exec();
    if (binding === null) throw new Error('ESIGN_BINDING_NOT_FOUND');
    const externalFlowId = this.crypto.unprotectExternalId(flow.tenantId, flow.id, flow);
    const providerStatus = await this.adapter.getFlow({
      appId: binding.appId, appSecret: this.secrets.resolve(binding.credentialSecretRef),
    }, externalFlowId);
    const projection = providerStatus === 0 || providerStatus === 1
      ? {
          status: flow.status, providerStatus, reviewRequired: false,
          reviewCode: null, changed: true,
        }
      : projectESignFlow(
          flow.status, flow.providerStatus, flow.reviewRequired, flow.reviewCode,
          'SIGN_FLOW_COMPLETE', providerStatus,
        );
    const updated = await this.flows.updateOne(
      { tenantId: flow.tenantId, id: flow.id, version: flow.version },
      { $set: {
        status: projection.status, providerStatus: projection.providerStatus,
        lastProviderAction: 'RECONCILE_FLOW_DETAIL', providerOccurredAt: observedAt,
        reviewRequired: projection.reviewRequired, reviewCode: projection.reviewCode,
        updatedAt: observedAt,
      }, $inc: { version: 1 } },
      { runValidators: true, timestamps: false },
    );
    if (updated.modifiedCount !== 1) throw new Error('ESIGN_FLOW_VERSION_CONFLICT');
    if (projection.status === 'provider_completed') {
      await this.enqueueEvidence(flow.id, flow.tenantId);
    }
    await this.auditSystemAfterBusiness(flow.tenantId, {
      action: 'integration.esign.reconcile', resourceType: 'esign_flow',
      resourceId: flow.id, riskLevel: 'R2',
      outcome: projection.reviewRequired ? 'failure' : 'success', traceId: flow.id,
      metadata: { providerStatus, flowStatus: projection.status },
    }, {
      code: 'ESIGN_RECONCILIATION_AUDIT_AFTER_COMMIT_FAILED',
      tenantId: flow.tenantId,
      flowId: flow.id,
    });
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

  private async auditSystemAfterBusiness(
    tenantId: string,
    input: Parameters<AuditService['recordSystem']>[1],
    context: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      await this.audit.recordSystem(tenantId, input);
    } catch {
      this.logger.error(context);
    }
  }
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'ESIGN_RECONCILIATION_FAILED';
}
