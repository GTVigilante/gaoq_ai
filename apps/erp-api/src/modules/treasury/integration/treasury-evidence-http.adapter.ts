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
const ARCHIVE_PATH = '/v1/objects';
const JSON_CONTENT_TYPE =
  /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/iu;
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OBJECT_KEY_PATTERN =
  /^treasury\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[A-Za-z0-9_-]{43}\.pain001\.xml$/;
const receiptSchema = z.object({
  tenantId: z.string().regex(TENANT_ID_PATTERN),
  batchId: z.string().regex(ULID_PATTERN),
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
    if (
      typeof input.tenantId !== 'string' ||
      !TENANT_ID_PATTERN.test(input.tenantId) ||
      typeof input.batchId !== 'string' ||
      !ULID_PATTERN.test(input.batchId) ||
      !Buffer.isBuffer(input.bytes) ||
      input.contentType !== 'application/xml' ||
      input.classification !== 'L4' ||
      input.retentionPolicy !== 'payroll_disbursement'
    ) throw new Error('TREASURY_ARCHIVE_INPUT_INVALID');
    assertPain001(input.bytes, input.sha256, input.batchId);
    if (
      typeof input.objectKey !== 'string' ||
      !OBJECT_KEY_PATTERN.test(input.objectKey) ||
      input.objectKey !== `treasury/${input.batchId}/${input.sha256}.pain001.xml`
    ) throw new Error('TREASURY_ARCHIVE_OBJECT_KEY_INVALID');
    const endpoint = this.config.get('TREASURY_WORM_ARCHIVE_ENDPOINT', { infer: true });
    const token = this.config.get('TREASURY_WORM_ARCHIVE_BEARER_TOKEN', { infer: true });
    const retentionDays = this.config.get('TREASURY_WORM_RETENTION_DAYS', { infer: true });
    if (endpoint === undefined || token === undefined) {
      throw new Error('TREASURY_IMMUTABLE_ARCHIVE_UNAVAILABLE');
    }
    if (!isCredential(token)) throw new Error('TREASURY_ARCHIVE_CREDENTIAL_INVALID');
    if (
      !Number.isSafeInteger(retentionDays) ||
      retentionDays < 3_650 ||
      retentionDays > 36_500
    ) throw new Error('TREASURY_ARCHIVE_RETENTION_INVALID');
    const response = await safeFetch(safeEndpoint(endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json', 'cache-control': 'no-store',
        'content-type': input.contentType,
        'content-length': String(input.bytes.length),
        'x-content-sha256': input.sha256, 'x-object-key': input.objectKey,
        'x-tenant-id': input.tenantId, 'x-batch-id': input.batchId,
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
      !parsed.success ||
      parsed.data.tenantId !== input.tenantId ||
      parsed.data.batchId !== input.batchId ||
      parsed.data.sha256 !== input.sha256 ||
      parsed.data.objectKey !== input.objectKey ||
      parsed.data.retentionDays < retentionDays ||
      parsed.data.objectRef === parsed.data.receiptId
    ) throw new Error('TREASURY_ARCHIVE_RECEIPT_INVALID');
    return Object.freeze({
      objectRef: parsed.data.objectRef,
      receiptId: parsed.data.receiptId,
      immutable: true,
    });
  }
}

function assertPain001(bytes: Buffer, expectedHash: string, batchId: string): void {
  const prefix = '<?xml version="1.0" encoding="UTF-8"?>';
  let document: string;
  try {
    document = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('TREASURY_PAIN001_FILE_INVALID');
  }
  if (
    bytes.length <= prefix.length || bytes.length > FILE_LIMIT_BYTES ||
    !document.startsWith(prefix) ||
    !document.startsWith(
      `${prefix}<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">`,
    ) ||
    !document.endsWith('</PmtInf></CstmrCdtTrfInitn></Document>') ||
    occurrenceCount(document, `<MsgId>${batchId}</MsgId>`) !== 1 ||
    occurrenceCount(document, `<PmtInfId>${batchId}</PmtInfId>`) !== 1 ||
    occurrenceCount(document, `<GrpHdr><MsgId>${batchId}</MsgId>`) !== 1 ||
    occurrenceCount(document, `</GrpHdr><PmtInf><PmtInfId>${batchId}</PmtInfId>`) !== 1 ||
    document.includes('<!') ||
    document.indexOf('<?', prefix.length) !== -1
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
  if (!JSON_CONTENT_TYPE.test(response.headers.get('content-type')?.trim() ?? '')) {
    throw new Error('TREASURY_ARCHIVE_RECEIPT_INVALID');
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  assertContentLength(response.headers.get('content-length'));
  if (response.body === null) throw new Error('TREASURY_ARCHIVE_RECEIPT_INVALID');
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new Error('TREASURY_ARCHIVE_RESPONSE_READ_ERROR');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let part: Awaited<ReturnType<typeof reader.read>>;
      try {
        part = await reader.read();
      } catch {
        cancelReader(reader);
        throw new Error('TREASURY_ARCHIVE_RESPONSE_READ_ERROR');
      }
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) {
        cancelReader(reader);
        throw new Error('TREASURY_ARCHIVE_RESPONSE_READ_ERROR');
      }
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        cancelReader(reader);
        throw new Error('TREASURY_ARCHIVE_RECEIPT_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 清理属于尽力操作，不得覆盖已经确定的资金证据出口结果。
    }
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
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('TREASURY_ARCHIVE_ENDPOINT_INVALID');
  }
  if (
    endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443') ||
    endpoint.pathname !== ARCHIVE_PATH
  ) throw new Error('TREASURY_ARCHIVE_ENDPOINT_INVALID');
  return endpoint.toString();
}

function assertContentLength(value: string | null): void {
  if (value === null) return;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error('TREASURY_ARCHIVE_RESPONSE_LENGTH_INVALID');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > RESPONSE_LIMIT_BYTES) {
    throw new Error('TREASURY_ARCHIVE_RECEIPT_TOO_LARGE');
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // 取消失败不得暴露上游异常或覆盖本域稳定错误码。
  }
}

function isCredential(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 32 && value.length <= 512 && [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 33 && code <= 126;
  });
}

function occurrenceCount(value: string, target: string): number {
  return value.split(target).length - 1;
}
