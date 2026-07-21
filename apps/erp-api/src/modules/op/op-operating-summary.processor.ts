import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { HttpException } from '@nestjs/common';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { OpOperatingSummaryService } from './application/op-operating-summary.service.js';
import {
  hashOpPayload,
  opOperatingSummaryEnvelopeSchema,
} from './op-operating-summary.contract.js';
import {
  OP_OPERATING_SUMMARY_QUEUE,
  OP_PROCESS_OPERATING_SUMMARY_JOB,
  type OpOperatingSummaryJobData,
} from './op-operating-summary.queue.js';
import { OpWebhookCryptoService } from './op-webhook-crypto.service.js';
import {
  OpOperatingSummaryInboxRecord,
  type OpOperatingSummaryInboxDocument,
} from './persistence/op.schemas.js';

const jobSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  inboxId: z.string().regex(ULID_PATTERN),
}).strict();

/** OP 经营摘要 Worker；在可信租户上下文中完成追加投影、Outbox 与审计。 */
@Processor(OP_OPERATING_SUMMARY_QUEUE, { concurrency: 4, limiter: { max: 50, duration: 1_000 } })
export class OpOperatingSummaryProcessor extends WorkerHost {
  constructor(
    @InjectModel(OpOperatingSummaryInboxRecord.name)
    private readonly inbox: Model<OpOperatingSummaryInboxDocument>,
    private readonly crypto: OpWebhookCryptoService,
    private readonly summaries: OpOperatingSummaryService,
    private readonly audit: AuditService,
    private readonly context: TenantContextService,
  ) {
    super();
  }

  override async process(job: Job<OpOperatingSummaryJobData>): Promise<number> {
    if (job.name !== OP_PROCESS_OPERATING_SUMMARY_JOB) throw new Error('OP_JOB_UNKNOWN');
    const data = jobSchema.parse(job.data);
    const claimed = await this.inbox.findOneAndUpdate({
      tenantId: data.tenantId, id: data.inboxId,
      status: { $in: ['pending', 'processing', 'failed'] },
    }, {
      $set: { status: 'processing', processingStartedAt: new Date(), failureCode: null },
      $inc: { attempts: 1 },
    }, { new: true, runValidators: true }).lean().exec();
    if (claimed === null) return 0;
    try {
      const raw = this.crypto.unprotect(claimed.tenantId, claimed.id, claimed);
      if (hashOpPayload(raw) !== claimed.payloadHash) throw new Error('OP_PAYLOAD_HASH_MISMATCH');
      const envelope = opOperatingSummaryEnvelopeSchema.parse(
        JSON.parse(raw.toString('utf8')) as unknown,
      );
      if (new Date(envelope.occurredAt).getTime() !== claimed.providerOccurredAt.getTime()) {
        throw new Error('OP_ENVELOPE_TIME_MISMATCH');
      }
      const summary = await this.context.run({
        tenant: { tenantId: claimed.tenantId, source: 'service_identity' },
        actor: {
          actorType: 'system_job', actorId: 'system:op-operating-summary',
          tenantId: claimed.tenantId, roleCodes: ['INTEGRATION_WORKER'],
          scopes: ['erp:op:operating_summary:ingest'], departmentIds: [], traceId: claimed.id,
        },
      }, async () => this.summaries.apply({
        tenantId: claimed.tenantId, clientId: claimed.clientId,
        externalEventId: claimed.externalEventId, inboxId: claimed.id,
        payloadHash: claimed.payloadHash, receivedAt: claimed.receivedAt, envelope,
      }));
      await this.audit.recordSystem(claimed.tenantId, {
        action: 'op.operating_summary.apply', resourceType: 'op_operating_summary',
        resourceId: summary.id, riskLevel: 'R1', outcome: 'success', traceId: claimed.id,
        metadata: {
          summaryDate: summary.summaryDate, revision: summary.revision,
          payloadHash: summary.payloadHash,
        },
      });
      await this.finish(claimed.tenantId, claimed.id, 'completed', null);
      return 1;
    } catch (error) {
      const code = failureCode(error);
      await this.finish(claimed.tenantId, claimed.id, 'failed', code);
      await this.audit.recordSystem(claimed.tenantId, {
        action: 'op.operating_summary.apply', resourceType: 'op_operating_summary_inbox',
        resourceId: claimed.id, riskLevel: 'R1', outcome: 'failure', traceId: claimed.id,
        metadata: { failureCode: code },
      });
      if (isPermanent(error)) return 1;
      throw error;
    }
  }

  private async finish(
    tenantId: string,
    id: string,
    status: 'completed' | 'failed',
    failureCodeValue: string | null,
  ): Promise<void> {
    const updated = await this.inbox.updateOne(
      { tenantId, id, status: 'processing' },
      { $set: {
        status, failureCode: failureCodeValue,
        processedAt: status === 'completed' ? new Date() : null,
        processingStartedAt: null,
      } },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw new Error('OP_INBOX_LEASE_LOST');
  }
}

function isPermanent(error: unknown): boolean {
  return error instanceof z.ZodError || error instanceof SyntaxError ||
    (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500) ||
    (error instanceof Error && [
      'OP_WEBHOOK_PAYLOAD_INVALID', 'OP_PAYLOAD_HASH_MISMATCH', 'OP_ENVELOPE_TIME_MISMATCH',
    ].includes(error.message));
}

function failureCode(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'OP_WEBHOOK_BODY_INVALID';
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null &&
      typeof (response as { code?: unknown }).code === 'string') {
      return (response as { code: string }).code;
    }
  }
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) return error.message;
  return 'OP_OPERATING_SUMMARY_PROCESSING_FAILED';
}
