import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import {
  ESignImmutableArchive,
  type ESignArchiveReceipt,
  ESignMalwareScanner,
  type ESignMalwareScanResult,
} from './esign-evidence.ports.js';

const PDF_LIMIT_BYTES = 50 * 1024 * 1024;
const RESPONSE_LIMIT_BYTES = 16 * 1024;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OBJECT_KEY_PATTERN = /^esign\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[A-Za-z0-9_-]{43}\.pdf$/;
const scanReceiptSchema = z.object({
  clean: z.boolean(),
  evidenceId: z.string().regex(SAFE_ID_PATTERN),
  sha256: z.string().regex(HASH_PATTERN),
}).strict();
const archiveReceiptSchema = z.object({
  objectRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/),
  receiptId: z.string().regex(SAFE_ID_PATTERN),
  immutable: z.boolean(),
  sha256: z.string().regex(HASH_PATTERN),
  objectKey: z.string().regex(OBJECT_KEY_PATTERN),
  retentionDays: z.number().int().min(1).max(36_500),
}).strict();

/** 生产病毒扫描 HTTPS Adapter；PDF 原文不写磁盘、不进日志，回执必须绑定内容摘要。 */
@Injectable()
export class HttpESignMalwareScanner extends ESignMalwareScanner {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async scan(input: {
    readonly tenantId: string;
    readonly flowId: string;
    readonly sha256: string;
    readonly bytes: Buffer;
  }): Promise<ESignMalwareScanResult> {
    assertPdf(input.bytes, input.sha256);
    const endpoint = this.config.get('ESIGN_MALWARE_SCAN_ENDPOINT', { infer: true });
    const token = this.config.get('ESIGN_MALWARE_SCAN_BEARER_TOKEN', { infer: true });
    if (endpoint === undefined || token === undefined) {
      throw new Error('ESIGN_MALWARE_SCANNER_UNAVAILABLE');
    }
    const response = await safeFetch('ESIGN_MALWARE_SCANNER', safeEndpoint(endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json', 'cache-control': 'no-store',
        'content-type': 'application/pdf',
        'content-length': String(input.bytes.length),
        'x-content-sha256': input.sha256,
        'idempotency-key': digest(['scan', input.tenantId, input.flowId, input.sha256]),
      },
      body: input.bytes,
    });
    const parsed = scanReceiptSchema.safeParse(await readJson(response, 'ESIGN_MALWARE_SCAN'));
    if (!parsed.success || parsed.data.sha256 !== input.sha256) {
      throw new Error('ESIGN_MALWARE_SCAN_RECEIPT_INVALID');
    }
    return Object.freeze({ clean: parsed.data.clean, evidenceId: parsed.data.evidenceId });
  }
}

/** 独立 WORM HTTPS Adapter；对象键与内容摘要双重幂等，回执必须证明不可变与保留期。 */
@Injectable()
export class HttpESignImmutableArchive extends ESignImmutableArchive {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async put(input: {
    readonly tenantId: string;
    readonly objectKey: string;
    readonly contentType: 'application/pdf';
    readonly classification: 'L4';
    readonly retentionPolicy: 'employment_contract';
    readonly sha256: string;
    readonly bytes: Buffer;
  }): Promise<ESignArchiveReceipt> {
    assertPdf(input.bytes, input.sha256);
    if (!OBJECT_KEY_PATTERN.test(input.objectKey) || !input.objectKey.endsWith(`/${input.sha256}.pdf`)) {
      throw new Error('ESIGN_ARCHIVE_OBJECT_KEY_INVALID');
    }
    const endpoint = this.config.get('ESIGN_WORM_ARCHIVE_ENDPOINT', { infer: true });
    const token = this.config.get('ESIGN_WORM_ARCHIVE_BEARER_TOKEN', { infer: true });
    const retentionDays = this.config.get('ESIGN_WORM_RETENTION_DAYS', { infer: true });
    if (endpoint === undefined || token === undefined) {
      throw new Error('ESIGN_IMMUTABLE_ARCHIVE_UNAVAILABLE');
    }
    const response = await safeFetch('ESIGN_WORM_ARCHIVE', safeEndpoint(endpoint), {
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
          'archive', input.tenantId, input.objectKey, input.sha256, String(retentionDays),
        ]),
      },
      body: input.bytes,
    });
    const parsed = archiveReceiptSchema.safeParse(await readJson(response, 'ESIGN_WORM_ARCHIVE'));
    if (
      !parsed.success || parsed.data.sha256 !== input.sha256 ||
      parsed.data.objectKey !== input.objectKey || !parsed.data.immutable ||
      parsed.data.retentionDays < retentionDays
    ) throw new Error('ESIGN_ARCHIVE_RECEIPT_INVALID');
    return Object.freeze({
      objectRef: parsed.data.objectRef,
      receiptId: parsed.data.receiptId,
      immutable: true,
    });
  }
}

function assertPdf(bytes: Buffer, expectedHash: string): void {
  if (
    bytes.length < 5 || bytes.length > PDF_LIMIT_BYTES ||
    bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
  ) throw new Error('ESIGN_EVIDENCE_PDF_INVALID');
  const actual = createHash('sha256').update(bytes).digest('base64url');
  if (!HASH_PATTERN.test(expectedHash) || actual !== expectedHash) {
    throw new Error('ESIGN_EVIDENCE_HASH_MISMATCH');
  }
}

async function safeFetch(prefix: string, endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch {
    throw new Error(`${prefix}_UNAVAILABLE`);
  }
  if (!response.ok) throw new Error(`${prefix}_HTTP_${response.status}`);
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error(`${prefix}_RECEIPT_INVALID`);
  }
  return response;
}

async function readJson(response: Response, prefix: string): Promise<unknown> {
  if (response.body === null) throw new Error(`${prefix}_RECEIPT_INVALID`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) throw new Error(`${prefix}_RECEIPT_INVALID`);
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) throw new Error(`${prefix}_RECEIPT_TOO_LARGE`);
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
    throw new Error(`${prefix}_RECEIPT_INVALID`);
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
  ) throw new Error('ESIGN_EVIDENCE_ENDPOINT_INVALID');
  return endpoint.toString();
}
