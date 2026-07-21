import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { ESignBinding, type ESignBindingDocument } from './esign-binding.schema.js';
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

const SIGNATURE_PATTERN = /^[A-Fa-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{13}$/;
const SECRET_REF_PATTERN = /^GAOQ_ESIGN_APP_[A-Z0-9_]{1,96}$/;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_PROVIDER_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_BODY_BYTES = 1024 * 1024;

const envelopeSchema = z.object({
  action: z.string().min(1).max(128),
  timestamp: z.number().int().nonnegative(),
  data: z.unknown().optional(),
}).passthrough();

export interface ESignWebhookHeaders {
  readonly appId: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly algorithm: string | undefined;
}

/** 受控 Secret 解析器；只允许 eSign 专用前缀，禁止任意环境变量读取。 */
@Injectable()
export class ESignSecretResolver {
  resolve(reference: string): string {
    if (!SECRET_REF_PATTERN.test(reference)) throw webhookDenied();
    const secret = process.env[reference];
    if (secret === undefined || secret.length < 16 || secret.length > 2_048) {
      throw new ServiceUnavailableException({
        code: 'ESIGN_WEBHOOK_SECRET_UNAVAILABLE', message: 'eSign 回调验证暂不可用',
      });
    }
    return secret;
  }
}

/** e签宝回调验签、租户映射、加密入箱与幂等排队；不在 HTTP 请求内推进业务状态。 */
@Injectable()
export class ESignWebhookService {
  constructor(
    @InjectModel(ESignBinding.name)
    private readonly bindings: Model<ESignBindingDocument>,
    @InjectModel(ESignWebhookInboxRecord.name)
    private readonly inbox: Model<ESignWebhookInboxDocument>,
    private readonly secrets: ESignSecretResolver,
    private readonly crypto: ESignWebhookCryptoService,
    @InjectQueue(ESIGN_WEBHOOK_QUEUE)
    private readonly queue: Queue<ESignWebhookJobData>,
  ) {}

  async accept(
    headers: ESignWebhookHeaders,
    rawBody: Buffer | undefined,
  ): Promise<{ readonly inboxId: string; readonly duplicate: boolean }> {
    const receivedAt = new Date();
    this.assertHeaders(headers, receivedAt);
    const appId = headers.appId;
    if (appId === undefined) throw webhookDenied();
    if (rawBody === undefined || rawBody.length < 2 || rawBody.length > MAX_BODY_BYTES) {
      throw new BadRequestException({
        code: 'ESIGN_WEBHOOK_RAW_BODY_REQUIRED', message: 'eSign 回调缺少有效原始正文',
      });
    }
    const binding = await this.bindings.findOne({
      provider: 'esign_cn', appId, status: 'active',
    }).lean().exec();
    if (binding === null) throw webhookDenied();
    const secret = this.secrets.resolve(binding.credentialSecretRef);
    this.verifySignature(headers, rawBody, secret);
    let parsed: z.infer<typeof envelopeSchema>;
    try {
      parsed = envelopeSchema.parse(JSON.parse(rawBody.toString('utf8')) as unknown);
    } catch {
      throw new BadRequestException({
        code: 'ESIGN_WEBHOOK_BODY_INVALID', message: 'eSign 回调正文格式无效',
      });
    }
    const providerOccurredAt = new Date(parsed.timestamp);
    if (
      Number.isNaN(providerOccurredAt.getTime()) ||
      providerOccurredAt.getTime() > receivedAt.getTime() + CLOCK_SKEW_MS ||
      providerOccurredAt.getTime() < receivedAt.getTime() - MAX_PROVIDER_EVENT_AGE_MS
    ) throw webhookDenied();
    const providerEventId = createHash('sha256')
      .update(appId, 'utf8')
      .update(Buffer.from([0]))
      .update(rawBody)
      .digest('base64url');
    const existing = await this.inbox.findOne({
      tenantId: binding.tenantId, provider: 'esign_cn', appId: binding.appId, providerEventId,
    }).lean().exec();
    if (existing !== null) {
      await this.enqueue(existing.id, existing.tenantId, providerEventId);
      return Object.freeze({ inboxId: existing.id, duplicate: true });
    }
    const inboxId = createEventId(receivedAt);
    const protectedPayload = this.crypto.protect(binding.tenantId, inboxId, rawBody);
    try {
      await this.inbox.create({
        id: inboxId, tenantId: binding.tenantId, provider: 'esign_cn', appId: binding.appId,
        providerEventId, action: parsed.action, providerOccurredAt,
        ...protectedPayload, status: 'pending', attempts: 0, failureCode: null, processedAt: null,
        processingStartedAt: null,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.inbox.findOne({
        tenantId: binding.tenantId, provider: 'esign_cn', appId: binding.appId, providerEventId,
      }).lean().exec();
      if (raced === null) throw error;
      await this.enqueue(raced.id, raced.tenantId, providerEventId);
      return Object.freeze({ inboxId: raced.id, duplicate: true });
    }
    await this.enqueue(inboxId, binding.tenantId, providerEventId);
    return Object.freeze({ inboxId, duplicate: false });
  }

  private assertHeaders(headers: ESignWebhookHeaders, now: Date): void {
    if (
      headers.appId === undefined || !/^[A-Za-z0-9_-]{4,128}$/.test(headers.appId) ||
      headers.timestamp === undefined || !TIMESTAMP_PATTERN.test(headers.timestamp) ||
      headers.signature === undefined || !SIGNATURE_PATTERN.test(headers.signature) ||
      headers.algorithm?.toLowerCase() !== 'hmac-sha256'
    ) throw webhookDenied();
    if (Math.abs(now.getTime() - Number(headers.timestamp)) > CLOCK_SKEW_MS) throw webhookDenied();
  }

  private verifySignature(headers: ESignWebhookHeaders, rawBody: Buffer, secret: string): void {
    const expected = createHmac('sha256', secret)
      .update(headers.timestamp ?? '', 'utf8')
      .update(rawBody)
      .digest();
    const provided = Buffer.from(headers.signature ?? '', 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw webhookDenied();
    }
  }

  private async enqueue(inboxId: string, tenantId: string, providerEventId: string): Promise<void> {
    await this.queue.add(
      ESIGN_PROCESS_WEBHOOK_JOB,
      { inboxId, tenantId },
      {
        jobId: `esign_${providerEventId}`,
        attempts: 12,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 10_000,
      },
    );
  }
}

function webhookDenied(): ForbiddenException {
  return new ForbiddenException({
    code: 'ESIGN_WEBHOOK_VERIFICATION_FAILED', message: 'eSign 回调验证失败',
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
