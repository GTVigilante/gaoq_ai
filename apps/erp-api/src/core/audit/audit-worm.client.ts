import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';

const MAX_RESPONSE_BYTES = 16_384;
const RECEIPT_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const requestSchema = z.object({
  payloadCanonical: z.string().min(1).max(16_384),
  payloadHash: z.string().regex(HASH_PATTERN),
  signingKeyId: z.string().regex(KEY_ID_PATTERN),
  signature: z.string().regex(SIGNATURE_PATTERN),
  retainUntil: z.iso.datetime({ offset: true }),
}).strict();
const receiptSchema = z.object({
  receiptId: z.string().regex(RECEIPT_PATTERN),
  objectVersion: z.string().regex(RECEIPT_PATTERN),
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
    return this.resolveConnection() !== null;
  }

  async write(request: AuditWormWriteRequest): Promise<AuditWormReceipt> {
    const connection = this.resolveConnection();
    if (connection === null) throw new Error('AUDIT_WORM_DISABLED');
    const { endpoint: target, token } = connection;
    const parsedRequest = requestSchema.safeParse(request);
    if (
      !parsedRequest.success ||
      createHash('sha256')
        .update(request.payloadCanonical, 'utf8')
        .digest('base64url') !== request.payloadHash ||
      !isCanonicalBase64url(request.signature, 64)
    ) throw new Error('AUDIT_WORM_REQUEST_INVALID');
    const body = JSON.stringify(parsedRequest.data);
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-length': String(Buffer.byteLength(body)),
          'content-type': 'application/json',
          'idempotency-key': request.payloadHash,
        },
        body,
      });
    } catch (error) {
      throw new Error('AUDIT_WORM_NETWORK_ERROR', { cause: error });
    }
    if (!response.ok) throw new Error(`AUDIT_WORM_HTTP_${response.status}`);
    const parsed = receiptSchema.safeParse(await readLimitedJson(response));
    if (!parsed.success || parsed.data.payloadHash !== request.payloadHash) {
      throw new Error('AUDIT_WORM_RECEIPT_INVALID');
    }
    const anchoredAt = Date.parse(parsed.data.anchoredAt);
    const retainedUntil = Date.parse(parsed.data.retainedUntil);
    if (
      anchoredAt > Date.now() + MAX_CLOCK_SKEW_MS ||
      anchoredAt > retainedUntil
    ) throw new Error('AUDIT_WORM_RECEIPT_INVALID');
    if (retainedUntil < Date.parse(request.retainUntil)) {
      throw new Error('AUDIT_WORM_RETENTION_INSUFFICIENT');
    }
    return Object.freeze(parsed.data);
  }

  private resolveConnection(): Readonly<{ endpoint: URL; token: string }> | null {
    const endpoint = this.config.get('AUDIT_WORM_ENDPOINT', { infer: true });
    const token = this.config.get('AUDIT_WORM_BEARER_TOKEN', { infer: true });
    if (
      (endpoint === undefined) !== (token === undefined) ||
      (token !== undefined && !TOKEN_PATTERN.test(token))
    ) throw new Error('AUDIT_WORM_CONFIG_INVALID');
    if (endpoint === undefined || token === undefined) return null;
    return Object.freeze({ endpoint: safeWormEndpoint(endpoint), token });
  }
}

function safeWormEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new Error('AUDIT_WORM_ENDPOINT_INVALID', { cause: error });
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443')
  ) throw new Error('AUDIT_WORM_ENDPOINT_INVALID');
  return endpoint;
}

function isCanonicalBase64url(value: string, expectedBytes: number): boolean {
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === expectedBytes && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') throw new Error('AUDIT_WORM_RECEIPT_INVALID');
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (
      !/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES
    )
  ) throw new Error('AUDIT_WORM_RECEIPT_TOO_LARGE');
  if (response.body === null) throw new Error('AUDIT_WORM_RECEIPT_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
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
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(combined);
    return JSON.parse(decoded) as unknown;
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.message === 'AUDIT_WORM_RECEIPT_INVALID' ||
        error.message === 'AUDIT_WORM_RECEIPT_TOO_LARGE'
      )
    ) throw error;
    throw new Error('AUDIT_WORM_RECEIPT_INVALID', { cause: error });
  } finally {
    reader.releaseLock();
  }
}
