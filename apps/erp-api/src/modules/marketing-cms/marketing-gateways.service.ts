import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AppEnvironment } from '../../config/environment.js';

const httpsCapabilityUrl = (maximum: number) => z.string().url().max(maximum).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '';
}, '必须是无凭据、无片段的 HTTPS URL');
const uploadResponse = z.object({
  objectRef: z.string().min(8).max(512),
  uploadUrl: httpsCapabilityUrl(4_096),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();
const scanResponse = z.object({
  objectRef: z.string().min(8).max(512),
  checksum: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scanEvidenceId: z.string().min(1).max(128),
  malwareClean: z.literal(true),
  variants: z.record(
    z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    httpsCapabilityUrl(2_048),
  ).refine((value) =>
    Object.keys(value).length <= 12 &&
    !Object.keys(value).some((key) =>
      ['__proto__', 'prototype', 'constructor'].includes(key)),
  '图片衍生规格无效'),
}).strict();
const aiResponse = z.object({
  modelId: z.string().min(1).max(128),
  promptVersion: z.string().min(1).max(128),
  output: z.unknown().transform((value, context) => {
    try {
      return safeMarketingAiOutput(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'AI 输出不是安全的有界 JSON' });
      return z.NEVER;
    }
  }),
}).strict();

export type MarketingUploadTicket = z.infer<typeof uploadResponse>;
export type MarketingScanReceipt = z.infer<typeof scanResponse>;
export type MarketingAiResult = z.infer<typeof aiResponse>;

/** 克隆并冻结 AI JSON；阻断原型污染、可执行标记与无界嵌套。 */
export function safeMarketingAiOutput(value: unknown): Readonly<Record<string, unknown>> {
  const state = { nodes: 0, bytes: 0 };
  const output = cloneSafeJson(value, 0, state);
  if (
    typeof output !== 'object' ||
    output === null ||
    Array.isArray(output) ||
    state.bytes > 250_000
  ) throw new Error('MARKETING_AI_OUTPUT_INVALID');
  return output as Readonly<Record<string, unknown>>;
}

/** CMS 媒体隔离网关：网关负责签名上传、病毒扫描和图片衍生。 */
@Injectable()
export class MarketingMediaGateway {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  createUpload(
    input: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
  ): Promise<MarketingUploadTicket> {
    return this.call('/v1/uploads', input, idempotencyKey, uploadResponse);
  }

  verifyUpload(
    input: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
  ): Promise<MarketingScanReceipt> {
    return this.call('/v1/uploads/verify', input, idempotencyKey, scanResponse);
  }

  private async call<T>(
    path: string,
    input: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const endpoint = this.config.get('MARKETING_MEDIA_GATEWAY_ENDPOINT', { infer: true });
    const token = this.config.get('MARKETING_MEDIA_GATEWAY_BEARER_TOKEN', { infer: true });
    if (endpoint === undefined || token === undefined) throw unavailable('媒体');
    try {
      const response = await fetch(new URL(path, endpoint), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw unavailable('媒体');
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) throw unavailable('媒体');
      return parsed.data;
    } catch {
      throw unavailable('媒体');
    }
  }
}

/** AI 内容网关：只接收当前编辑内容，输出永远保持待人工审核状态。 */
@Injectable()
export class MarketingAiGateway {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  async generate(
    input: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
  ): Promise<MarketingAiResult> {
    const endpoint = this.config.get('MARKETING_AI_GATEWAY_ENDPOINT', { infer: true });
    const token = this.config.get('MARKETING_AI_GATEWAY_BEARER_TOKEN', { infer: true });
    if (endpoint === undefined || token === undefined) throw unavailable('AI');
    try {
      const response = await fetch(new URL('/v1/generate', endpoint), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw unavailable('AI');
      const parsed = aiResponse.safeParse(await response.json());
      if (!parsed.success) throw unavailable('AI');
      return parsed.data;
    } catch {
      throw unavailable('AI');
    }
  }
}

function unavailable(capability: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: `MARKETING_${capability === 'AI' ? 'AI' : 'MEDIA'}_GATEWAY_UNAVAILABLE`,
    message: `${capability}网关暂时不可用`,
  });
}

function cloneSafeJson(
  value: unknown,
  depth: number,
  state: { nodes: number; bytes: number },
): unknown {
  state.nodes += 1;
  if (depth > 12 || state.nodes > 5_000) throw new Error('MARKETING_AI_OUTPUT_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MARKETING_AI_OUTPUT_INVALID');
    return value;
  }
  if (typeof value === 'string') {
    state.bytes += Buffer.byteLength(value, 'utf8');
    if (/<\s*script|javascript:|data:\s*text\/html|on[a-z]+\s*=/iu.test(value)) {
      throw new Error('MARKETING_AI_OUTPUT_INVALID');
    }
    return value;
  }
  if (typeof value !== 'object') throw new Error('MARKETING_AI_OUTPUT_INVALID');
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error('MARKETING_AI_OUTPUT_INVALID');
    return Object.freeze(value.map((item) => cloneSafeJson(item, depth + 1, state)));
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('MARKETING_AI_OUTPUT_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string') || keys.length > 256) {
    throw new Error('MARKETING_AI_OUTPUT_INVALID');
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) throw new Error('MARKETING_AI_OUTPUT_INVALID');
    state.bytes += Buffer.byteLength(key, 'utf8');
    result[key] = cloneSafeJson(descriptor.value, depth + 1, state);
  }
  return Object.freeze(result);
}
