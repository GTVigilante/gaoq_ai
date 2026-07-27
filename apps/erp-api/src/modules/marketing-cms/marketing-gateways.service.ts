import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AppEnvironment } from '../../config/environment.js';

const uploadResponse = z.object({
  objectRef: z.string().min(8).max(512),
  uploadUrl: z.string().url(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();
const scanResponse = z.object({
  objectRef: z.string().min(8).max(512),
  checksum: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scanEvidenceId: z.string().min(1).max(128),
  malwareClean: z.literal(true),
  variants: z.record(z.string(), z.string().url()).refine(
    (value) => Object.keys(value).length <= 12,
    '图片衍生规格不得超过 12 个',
  ),
}).strict();
const aiResponse = z.object({
  modelId: z.string().min(1).max(128),
  promptVersion: z.string().min(1).max(128),
  output: z.record(z.string(), z.unknown()),
}).strict();

export type MarketingUploadTicket = z.infer<typeof uploadResponse>;
export type MarketingScanReceipt = z.infer<typeof scanResponse>;
export type MarketingAiResult = z.infer<typeof aiResponse>;

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
