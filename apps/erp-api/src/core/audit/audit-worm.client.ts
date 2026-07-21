import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';

const MAX_RESPONSE_BYTES = 16_384;
const RECEIPT_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const receiptSchema = z.object({
  receiptId: z.string().regex(RECEIPT_PATTERN),
  objectVersion: z.string().min(1).max(256),
  payloadHash: z.string().regex(HASH_PATTERN),
  retainedUntil: z.iso.datetime({ offset: true }),
  anchoredAt: z.iso.datetime({ offset: true }),
}).strict();

export interface AuditWormWriteRequest {
  readonly payloadCanonical: string;
  readonly payloadHash: string;
  readonly signingKeyId: string;
  readonly signature: string;
  readonly retainUntil: string;
}

export interface AuditWormReceipt {
  readonly receiptId: string;
  readonly objectVersion: string;
  readonly payloadHash: string;
  readonly retainedUntil: string;
  readonly anchoredAt: string;
}

/** 外部 WORM 平台端口；实现必须支持以 payloadHash 为幂等键重复提交。 */
export abstract class AuditWormClient {
  abstract isEnabled(): boolean;
  abstract write(request: AuditWormWriteRequest): Promise<AuditWormReceipt>;
}

/** HTTPS WORM 适配器；禁止重定向，限制回执体积并严格校验外部回执。 */
@Injectable()
export class HttpAuditWormClient extends AuditWormClient {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  isEnabled(): boolean {
    return this.config.get('AUDIT_WORM_ENDPOINT', { infer: true }) !== undefined;
  }

  async write(request: AuditWormWriteRequest): Promise<AuditWormReceipt> {
    const endpoint = this.config.get('AUDIT_WORM_ENDPOINT', { infer: true });
    const token = this.config.get('AUDIT_WORM_BEARER_TOKEN', { infer: true });
    if (endpoint === undefined || token === undefined) throw new Error('AUDIT_WORM_DISABLED');
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': request.payloadHash,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`AUDIT_WORM_HTTP_${response.status}`);
    const body = await readLimitedBody(response);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      throw new Error('AUDIT_WORM_RECEIPT_INVALID');
    }
    const parsed = receiptSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.payloadHash !== request.payloadHash) {
      throw new Error('AUDIT_WORM_RECEIPT_INVALID');
    }
    if (Date.parse(parsed.data.retainedUntil) < Date.parse(request.retainUntil)) {
      throw new Error('AUDIT_WORM_RETENTION_INSUFFICIENT');
    }
    return Object.freeze(parsed.data);
  }
}

async function readLimitedBody(response: Response): Promise<string> {
  if (response.body === null) throw new Error('AUDIT_WORM_RECEIPT_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    const value: unknown = part.value;
    if (!(value instanceof Uint8Array)) throw new Error('AUDIT_WORM_RECEIPT_INVALID');
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('AUDIT_WORM_RECEIPT_TOO_LARGE');
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}
