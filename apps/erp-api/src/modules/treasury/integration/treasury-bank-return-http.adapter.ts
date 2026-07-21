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
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const lineSchema = z.object({
  instructionId: z.string().regex(ID), outcome: z.enum(['succeeded', 'failed']),
  amountMinor: z.number().int().safe().positive(), bankLineReference: z.string().regex(ID),
}).strict();
const manifestSchema = z.object({
  returnId: z.string().regex(ULID_PATTERN), tenantId: z.string().regex(ID),
  batchId: z.string().regex(ULID_PATTERN),
  bankSubmissionId: z.string().regex(ID), sequence: z.number().int().positive(),
  returnHash: z.string().regex(HASH),
  objectRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/),
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
    if (!ID.test(input.tenantId) || !ID.test(input.batchId) || !ID.test(input.bankSubmissionId)) {
      throw new Error('TREASURY_BANK_RETURN_CLAIM_INVALID');
    }
    const endpoint = this.config.get('TREASURY_BANK_RETURN_INBOX_ENDPOINT', { infer: true });
    const token = this.config.get('TREASURY_BANK_RETURN_INBOX_BEARER_TOKEN', { infer: true });
    if (endpoint === undefined || token === undefined) throw new Error('TREASURY_BANK_RETURN_INBOX_UNAVAILABLE');
    const body = JSON.stringify(input);
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
      parsed.data.bankSubmissionId !== input.bankSubmissionId
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
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('TREASURY_BANK_RETURN_MANIFEST_INVALID');
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('TREASURY_BANK_RETURN_MANIFEST_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) throw new Error('TREASURY_BANK_RETURN_MANIFEST_INVALID');
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) throw new Error('TREASURY_BANK_RETURN_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; } catch {
    throw new Error('TREASURY_BANK_RETURN_MANIFEST_INVALID');
  }
}

function safeEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443')
  ) throw new Error('TREASURY_BANK_RETURN_ENDPOINT_INVALID');
  return endpoint.toString();
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
