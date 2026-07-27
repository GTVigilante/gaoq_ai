import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Model } from 'mongoose';

import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants.js';
import { AuditService } from '../../core/audit/audit.service.js';
import {
  OP_MAX_WEBHOOK_BODY_BYTES,
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
  OpClientBindingRecord,
  type OpClientBindingDocument,
  OpOperatingSummaryInboxRecord,
  type OpOperatingSummaryInboxDocument,
} from './persistence/op.schemas.js';

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const TIMESTAMP = /^[0-9]{13}$/;
const SIGNATURE = /^[A-Fa-f0-9]{64}$/;
const SECRET_REF = /^GAOQ_OP_HMAC_[A-Z0-9_]{1,96}$/;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_EVENT_AGE_MS = 31 * 24 * 60 * 60 * 1_000;
const REPLAY_TTL_SECONDS = 24 * 60 * 60;
const INBOX_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export interface OpWebhookHeaders {
  readonly clientId: string | undefined;
  readonly timestamp: string | undefined;
  readonly nonce: string | undefined;
  readonly eventId: string | undefined;
  readonly signature: string | undefined;
  readonly algorithm: string | undefined;
}

/** OP HMAC Secret 解析器；仅允许专用前缀，禁止任意环境变量读取。 */
@Injectable()
export class OpWebhookSecretResolver {
  resolve(reference: string): string {
    if (!SECRET_REF.test(reference)) throw denied();
    const secret = process.env[reference];
    if (secret === undefined || secret.length < 32 || secret.length > 2_048) {
      throw new ServiceUnavailableException({
        code: 'OP_WEBHOOK_SECRET_UNAVAILABLE', message: 'OP 回调验证暂不可用',
      });
    }
    return secret;
  }
}

/** OP 入站边界：验签、租户解析、防重放、加密入箱与异步排队。 */
@Injectable()
export class OpWebhookService {
  private readonly logger = new Logger(OpWebhookService.name);

  constructor(
    @InjectModel(OpClientBindingRecord.name)
    private readonly bindings: Model<OpClientBindingDocument>,
    @InjectModel(OpOperatingSummaryInboxRecord.name)
    private readonly inbox: Model<OpOperatingSummaryInboxDocument>,
    private readonly secrets: OpWebhookSecretResolver,
    private readonly crypto: OpWebhookCryptoService,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(OP_OPERATING_SUMMARY_QUEUE)
    private readonly queue: Queue<OpOperatingSummaryJobData>,
  ) {}

  async accept(
    headers: OpWebhookHeaders,
    rawBody: Buffer | undefined,
  ): Promise<{ readonly inboxId: string; readonly duplicate: boolean }> {
    const receivedAt = new Date();
    this.assertHeaders(headers, receivedAt);
    if (rawBody !== undefined && rawBody.length > OP_MAX_WEBHOOK_BODY_BYTES) {
      throw new PayloadTooLargeException({
        code: 'OP_WEBHOOK_BODY_TOO_LARGE', message: 'OP 回调正文不得超过 1 MiB',
      });
    }
    if (rawBody === undefined || rawBody.length < 2) {
      throw new BadRequestException({
        code: 'OP_WEBHOOK_RAW_BODY_REQUIRED', message: 'OP 回调缺少有效原始正文',
      });
    }
    const clientId = headers.clientId;
    const externalEventId = headers.eventId;
    const nonce = headers.nonce;
    if (clientId === undefined || externalEventId === undefined || nonce === undefined) throw denied();
    const binding = await this.bindings.findOne({ clientId, status: 'active' }).lean().exec();
    if (binding === null) throw denied();
    try {
      this.verifySignature(headers, rawBody, this.secrets.resolve(binding.credentialSecretRef));
    } catch (error) {
      await this.auditVerificationSafe(binding.tenantId, clientId, payloadTrace(rawBody), 'failure');
      throw error;
    }
    let envelope;
    try {
      envelope = opOperatingSummaryEnvelopeSchema.parse(JSON.parse(rawBody.toString('utf8')) as unknown);
    } catch {
      await this.auditVerificationSafe(binding.tenantId, clientId, payloadTrace(rawBody), 'failure');
      throw new BadRequestException({
        code: 'OP_WEBHOOK_BODY_INVALID', message: 'OP 回调正文不符合经营摘要契约',
      });
    }
    const providerOccurredAt = new Date(envelope.occurredAt);
    if (providerOccurredAt.getTime() > receivedAt.getTime() + CLOCK_SKEW_MS ||
      providerOccurredAt.getTime() < receivedAt.getTime() - MAX_EVENT_AGE_MS) {
      await this.auditVerificationSafe(
        binding.tenantId, clientId, externalEventId, 'failure',
      );
      throw denied();
    }
    const payloadHash = hashOpPayload(rawBody);
    const existing = await this.inbox.findOne({
      tenantId: binding.tenantId, clientId, externalEventId,
    }).lean().exec();
    if (existing !== null) {
      if (existing.payloadHash !== payloadHash) {
        await this.auditVerificationSafe(binding.tenantId, clientId, existing.id, 'failure');
        throw new ConflictException({
          code: 'OP_EVENT_PAYLOAD_CONFLICT', message: '同一 OP 事件标识对应不同载荷',
        });
      }
      await this.enqueue(existing.id, binding.tenantId, payloadHash);
      await this.auditVerificationSafe(binding.tenantId, clientId, existing.id, 'success');
      return Object.freeze({ inboxId: existing.id, duplicate: true });
    }
    const nonceHash = createHash('sha256').update(clientId).update('\0').update(nonce)
      .digest('base64url');
    try {
      await this.reserveNonce(clientId, nonceHash, payloadHash);
    } catch (error) {
      await this.auditVerificationSafe(binding.tenantId, clientId, payloadTrace(rawBody), 'failure');
      throw error;
    }
    const inboxId = createEventId(receivedAt);
    const protectedPayload = this.crypto.protect(binding.tenantId, inboxId, rawBody);
    try {
      await this.inbox.create({
        id: inboxId, tenantId: binding.tenantId, clientId, externalEventId, nonceHash,
        payloadHash, providerOccurredAt, receivedAt,
        expiresAt: new Date(receivedAt.getTime() + INBOX_RETENTION_MS), ...protectedPayload,
        status: 'pending', attempts: 0, failureCode: null, processedAt: null,
        processingStartedAt: null,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.inbox.findOne({
        tenantId: binding.tenantId, clientId, externalEventId,
      }).lean().exec();
      if (raced === null || raced.payloadHash !== payloadHash) {
        await this.auditVerificationSafe(
          binding.tenantId, clientId, externalEventId, 'failure',
        );
        throw new ConflictException({
          code: 'OP_WEBHOOK_REPLAY_DETECTED', message: 'OP 回调重放已被拒绝',
        });
      }
      await this.enqueue(raced.id, raced.tenantId, payloadHash);
      await this.auditVerificationSafe(binding.tenantId, clientId, raced.id, 'success');
      return Object.freeze({ inboxId: raced.id, duplicate: true });
    }
    await this.enqueue(inboxId, binding.tenantId, payloadHash);
    await this.auditVerificationSafe(binding.tenantId, clientId, inboxId, 'success');
    return Object.freeze({ inboxId, duplicate: false });
  }

  private assertHeaders(headers: OpWebhookHeaders, now: Date): void {
    if (headers.clientId === undefined || !CLIENT_ID.test(headers.clientId) ||
      headers.timestamp === undefined || !TIMESTAMP.test(headers.timestamp) ||
      headers.nonce === undefined || !NONCE.test(headers.nonce) ||
      headers.eventId === undefined || !EVENT_ID.test(headers.eventId) ||
      headers.signature === undefined || !SIGNATURE.test(headers.signature) ||
      headers.algorithm?.toLowerCase() !== 'hmac-sha256' ||
      Math.abs(now.getTime() - Number(headers.timestamp)) > CLOCK_SKEW_MS) throw denied();
  }

  private verifySignature(headers: OpWebhookHeaders, body: Buffer, secret: string): void {
    const expected = createHmac('sha256', secret)
      .update(`${headers.timestamp}\n${headers.nonce}\n${headers.eventId}\n`, 'utf8')
      .update(body).digest();
    const provided = Buffer.from(headers.signature ?? '', 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw denied();
  }

  private async reserveNonce(clientId: string, nonceHash: string, payloadHash: string): Promise<void> {
    try {
      const created = await this.redis.set(
        `op:webhook:nonce:${clientId}:${nonceHash}`, payloadHash, 'EX', REPLAY_TTL_SECONDS, 'NX',
      );
      if (created !== 'OK') throw new ConflictException({
        code: 'OP_WEBHOOK_REPLAY_DETECTED', message: 'OP 回调重放已被拒绝',
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException({
        code: 'OP_WEBHOOK_REPLAY_STORE_UNAVAILABLE', message: 'OP 防重放设施暂不可用',
      });
    }
  }

  private async enqueue(inboxId: string, tenantId: string, payloadHash: string): Promise<void> {
    await this.queue.add(OP_PROCESS_OPERATING_SUMMARY_JOB, { inboxId, tenantId }, {
      jobId: `op_summary_${payloadHash}`, attempts: 12,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 1_000, removeOnFail: 10_000,
    });
  }

  private async auditVerification(
    tenantId: string,
    clientId: string,
    traceId: string,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    await this.audit.recordTrustedExternalService(tenantId, {
      actorId: `op:${clientId}`, traceId,
      action: 'integration.op.webhook.verify', resourceType: 'op_webhook',
      riskLevel: 'R1', outcome,
      metadata: { clientId, protocol: 'hmac-sha256-v1' },
    });
  }

  private async auditVerificationSafe(
    tenantId: string,
    clientId: string,
    traceId: string,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    try {
      await this.auditVerification(tenantId, clientId, traceId, outcome);
    } catch {
      this.logger.error({
        code: 'OP_WEBHOOK_AUDIT_AFTER_DECISION_FAILED',
        outcome,
      });
    }
  }
}

function denied(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'OP_WEBHOOK_VERIFICATION_FAILED', message: 'OP 回调验证失败',
  });
}

function payloadTrace(rawBody: Buffer): string {
  return `op_${createHash('sha256').update(rawBody).digest('base64url').slice(0, 40)}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
