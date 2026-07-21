import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  TreasuryImmutableArchive,
  type TreasuryArchiveReceipt,
} from './treasury-evidence.ports.js';

const FILE_LIMIT_BYTES = 8 * 1024 * 1024;
const RESPONSE_LIMIT_BYTES = 16 * 1024;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OBJECT_KEY_PATTERN =
  /^treasury\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[A-Za-z0-9_-]{43}\.pain001\.xml$/;
const receiptSchema = z.object({
  objectRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/),
  receiptId: z.string().regex(SAFE_ID_PATTERN),
  immutable: z.literal(true),
  sha256: z.string().regex(HASH_PATTERN),
  objectKey: z.string().regex(OBJECT_KEY_PATTERN),
  retentionDays: z.number().int().min(1).max(36_500),
}).strict();

/** Treasury 独立 WORM HTTPS Adapter；文件不落本地磁盘，回执严格绑定摘要和保留期。 */
@Injectable()
export class HttpTreasuryImmutableArchive extends TreasuryImmutableArchive {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async put(input: {
    readonly tenantId: string;
    readonly batchId: string;
    readonly objectKey: string;
    readonly contentType: 'application/xml';
    readonly classification: 'L4';
    readonly retentionPolicy: 'payroll_disbursement';
    readonly sha256: string;
    readonly bytes: Buffer;
  }): Promise<TreasuryArchiveReceipt> {
    assertPain001(input.bytes, input.sha256);
    if (
      !OBJECT_KEY_PATTERN.test(input.objectKey) ||
      input.objectKey !== `treasury/${input.batchId}/${input.sha256}.pain001.xml`
    ) throw new Error('TREASURY_ARCHIVE_OBJECT_KEY_INVALID');
    const endpoint = this.config.get('TREASURY_WORM_ARCHIVE_ENDPOINT', { infer: true });
    const token = this.config.get('TREASURY_WORM_ARCHIVE_BEARER_TOKEN', { infer: true });
    const retentionDays = this.config.get('TREASURY_WORM_RETENTION_DAYS', { infer: true });
    if (endpoint === undefined || token === undefined) {
      throw new Error('TREASURY_IMMUTABLE_ARCHIVE_UNAVAILABLE');
    }
    const response = await safeFetch(safeEndpoint(endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json', 'cache-control': 'no-store',
        'content-type': input.contentType,
        'content-length': String(input.bytes.length),
        'x-content-sha256': input.sha256, 'x-object-key': input.objectKey,
        'x-data-classification': input.classification,
        'x-retention-policy': input.retentionPolicy,
        'x-retention-days': String(retentionDays),
        'idempotency-key': digest([
          'treasury-archive', input.tenantId, input.batchId,
          input.objectKey, input.sha256, String(retentionDays),
        ]),
      },
      body: input.bytes,
    });
    const parsed = receiptSchema.safeParse(await readJson(response));
    if (
      !parsed.success || parsed.data.sha256 !== input.sha256 ||
      parsed.data.objectKey !== input.objectKey ||
      parsed.data.retentionDays < retentionDays
    ) throw new Error('TREASURY_ARCHIVE_RECEIPT_INVALID');
    return Object.freeze({
      objectRef: parsed.data.objectRef,
      receiptId: parsed.data.receiptId,
      immutable: true,
    });
  }
}

function assertPain001(bytes: Buffer, expectedHash: string): void {
  const prefix = '<?xml version="1.0" encoding="UTF-8"?>';
  if (
    bytes.length <= prefix.length || bytes.length > FILE_LIMIT_BYTES ||
    bytes.subarray(0, prefix.length).toString('utf8') !== prefix
  ) throw new Error('TREASURY_PAIN001_FILE_INVALID');
  const actual = createHash('sha256').update(bytes).digest('base64url');
  if (!HASH_PATTERN.test(expectedHash) || actual !== expectedHash) {
    throw new Error('TREASURY_PAIN001_HASH_MISMATCH');
  }
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch {
    throw new Error('TREASURY_WORM_ARCHIVE_UNAVAILABLE');
  }
  if (!response.ok) throw new Error(`TREASURY_WORM_ARCHIVE_HTTP_${response.status}`);
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('TREASURY_ARCHIVE_RECEIPT_INVALID');
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('TREASURY_ARCHIVE_RECEIPT_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) throw new Error('TREASURY_ARCHIVE_RECEIPT_INVALID');
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) throw new Error('TREASURY_ARCHIVE_RECEIPT_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('TREASURY_ARCHIVE_RECEIPT_INVALID');
  }
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}

function safeEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443')
  ) throw new Error('TREASURY_ARCHIVE_ENDPOINT_INVALID');
  return endpoint.toString();
}
