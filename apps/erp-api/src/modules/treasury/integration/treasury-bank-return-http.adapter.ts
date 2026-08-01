import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  TreasuryBankReturnInbox,
  type TreasuryBankReturnManifest,
} from './treasury-bank-return.ports.js';

const RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const REQUEST_LIMIT_BYTES = 4 * 1024;
const RETURN_CLAIM_PATH = '/v1/returns/claim';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_REF = /^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/;
const TOKEN = /^[\x21-\x7e]{32,512}$/;
const JSON_CONTENT_TYPE =
  /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/iu;
const lineSchema = z.object({
  instructionId: z.string().regex(ID), outcome: z.enum(['succeeded', 'failed']),
  amountMinor: z.number().int().safe().positive(), bankLineReference: z.string().regex(ID),
}).strict();
const manifestSchema = z.object({
  returnId: z.string().regex(ULID_PATTERN), tenantId: z.string().regex(ID),
  batchId: z.string().regex(ULID_PATTERN),
  bankSubmissionId: z.string().regex(ID), sequence: z.number().int().positive(),
  returnHash: z.string().regex(HASH),
  objectRef: z.string().regex(OBJECT_REF),
  objectEvidenceId: z.string().regex(ID), signatureEvidenceId: z.string().regex(ID),
  signatureVerified: z.boolean(), malwareScanEvidenceId: z.string().regex(ID),
  malwareClean: z.boolean(), receivedAt: z.iso.datetime({ offset: true }),
  lines: z.array(lineSchema).max(5_000),
}).strict();

/** 回盘隔离 Inbox Adapter；上游完成验签、扫描、解压限制、规范化与 WORM 留档。 */
@Injectable()
export class HttpTreasuryBankReturnInbox extends TreasuryBankReturnInbox {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async claim(input: {
    readonly tenantId: string; readonly batchId: string; readonly bankSubmissionId: string;
  }): Promise<TreasuryBankReturnManifest> {
    if (
      !ID.test(input.tenantId) || !ULID_PATTERN.test(input.batchId) ||
      !ID.test(input.bankSubmissionId)
    ) {
      throw new Error('TREASURY_BANK_RETURN_CLAIM_INVALID');
    }
    const endpoint = this.config.get('TREASURY_BANK_RETURN_INBOX_ENDPOINT', { infer: true });
    const token = this.config.get('TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN', { infer: true });
    if (endpoint === undefined || token === undefined) throw new Error('TREASURY_BANK_RETURN_INBOX_UNAVAILABLE');
    if (!TOKEN.test(token)) throw new Error('TREASURY_BANK_RETURN_CREDENTIAL_INVALID');
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > REQUEST_LIMIT_BYTES) {
      throw new Error('TREASURY_BANK_RETURN_REQUEST_TOO_LARGE');
    }
    const response = await safeFetch(safeEndpoint(endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), body,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/json',
        'cache-control': 'no-store', 'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'idempotency-key': digest(['treasury-return-claim', input.tenantId, input.batchId,
          input.bankSubmissionId]),
      },
    });
    const parsed = manifestSchema.safeParse(await readJson(response));
    if (
      !parsed.success || parsed.data.tenantId !== input.tenantId ||
      parsed.data.batchId !== input.batchId ||
      parsed.data.bankSubmissionId !== input.bankSubmissionId ||
      new Set([
        parsed.data.objectEvidenceId,
        parsed.data.signatureEvidenceId,
        parsed.data.malwareScanEvidenceId,
      ]).size !== 3
    ) throw new Error('TREASURY_BANK_RETURN_MANIFEST_INVALID');
    return Object.freeze({
      ...parsed.data,
      lines: Object.freeze(parsed.data.lines.map((line) => Object.freeze(line))),
    });
  }
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(endpoint, init); } catch {
    throw new Error('TREASURY_BANK_RETURN_INBOX_UNAVAILABLE');
  }
  if (!response.ok) throw new Error(`TREASURY_BANK_RETURN_INBOX_HTTP_${response.status}`);
  if (!JSON_CONTENT_TYPE.test(response.headers.get('content-type')?.trim() ?? '')) {
    throw new Error('TREASURY_BANK_RETURN_MANIFEST_INVALID');
  }
  assertResponseLength(response.headers.get('content-length'));
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('TREASURY_BANK_RETURN_MANIFEST_INVALID');
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new Error('TREASURY_BANK_RETURN_RESPONSE_READ_ERROR');
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
        throw new Error('TREASURY_BANK_RETURN_RESPONSE_READ_ERROR');
      }
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) {
        cancelReader(reader);
        throw new Error('TREASURY_BANK_RETURN_RESPONSE_READ_ERROR');
      }
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        cancelReader(reader);
        throw new Error('TREASURY_BANK_RETURN_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {
      // 读取器清理为尽力操作，不得覆盖已经确定的回盘处理结果。
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; } catch {
    throw new Error('TREASURY_BANK_RETURN_MANIFEST_INVALID');
  }
}

function safeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('TREASURY_BANK_RETURN_ENDPOINT_INVALID');
  }
  if (
    endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443') ||
    endpoint.pathname !== RETURN_CLAIM_PATH
  ) throw new Error('TREASURY_BANK_RETURN_ENDPOINT_INVALID');
  return endpoint.toString();
}

function assertResponseLength(value: string | null): void {
  if (value === null) return;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error('TREASURY_BANK_RETURN_RESPONSE_LENGTH_INVALID');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > RESPONSE_LIMIT_BYTES) {
    throw new Error('TREASURY_BANK_RETURN_RESPONSE_TOO_LARGE');
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // 取消为尽力操作，禁止上游异常覆盖本域稳定错误码。
  }
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
