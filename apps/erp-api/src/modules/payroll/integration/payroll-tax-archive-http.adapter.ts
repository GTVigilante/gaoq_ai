import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  isPayrollTaxJsonContentType,
  readBoundedJson,
  safePayrollTaxEndpoint,
} from './payroll-tax-http.shared.js';
import { PayrollTaxImmutableArchive, type PayrollTaxArchiveReceipt } from './payroll-tax.ports.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_KEY = /^payroll-tax\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[A-Za-z0-9_-]{43}\.json$/;
const ARCHIVE_PATH = '/v1/objects';
const FILE_LIMIT_BYTES = 8 * 1024 * 1024;
const manifestRootSchema = z.object({
  schema: z.literal('CN_IIT_WITHHOLDING_MANIFEST_V1'),
  filingId: z.string().regex(ULID),
  tenantId: z.string().regex(ID),
}).passthrough();
const correctionRootSchema = z.object({
  schema: z.literal('CN_IIT_WITHHOLDING_CORRECTION_V1'),
  correctionFilingId: z.string().regex(ULID),
  tenantId: z.string().regex(ID),
}).passthrough();
const archiveRootSchema = z.discriminatedUnion('schema', [
  manifestRootSchema,
  correctionRootSchema,
]);
const receiptSchema = z.object({
  objectRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/),
  evidenceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  immutable: z.literal(true), sha256: z.string().regex(HASH),
  objectKey: z.string().regex(OBJECT_KEY), retentionDays: z.number().int().min(3_650).max(36_500),
}).strict();

/** Payroll Tax 独立 WORM；税务正文不落本地磁盘。 */
@Injectable()
export class HttpPayrollTaxImmutableArchive extends PayrollTaxImmutableArchive {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async put(input: {
    readonly tenantId: string; readonly filingId: string; readonly objectKey: string;
    readonly sha256: string; readonly bytes: Buffer;
  }): Promise<PayrollTaxArchiveReceipt> {
    if (
      !ID.test(input.tenantId) || !ULID.test(input.filingId) ||
      input.bytes.length < 2 || input.bytes.length > FILE_LIMIT_BYTES ||
      !HASH.test(input.sha256) ||
      createHash('sha256').update(input.bytes).digest('base64url') !== input.sha256 ||
      !OBJECT_KEY.test(input.objectKey) ||
      input.objectKey !== `payroll-tax/${input.filingId}/${input.sha256}.json`
    ) throw new Error('PAYROLL_TAX_ARCHIVE_INPUT_INVALID');
    assertManifestBinding(input.bytes, input.tenantId, input.filingId);
    const endpoint = this.config.get('PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT', { infer: true });
    const token = this.config.get('PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN', { infer: true });
    const retentionDays = this.config.get('PAYROLL_TAX_WORM_RETENTION_DAYS', { infer: true });
    if (endpoint === undefined || token === undefined) throw new Error('PAYROLL_TAX_ARCHIVE_UNAVAILABLE');
    if (!isCredential(token)) throw new Error('PAYROLL_TAX_ARCHIVE_CREDENTIAL_INVALID');
    if (
      !Number.isSafeInteger(retentionDays) ||
      retentionDays < 3_650 ||
      retentionDays > 36_500
    ) throw new Error('PAYROLL_TAX_ARCHIVE_RETENTION_INVALID');
    const response = await safeFetch(safePayrollTaxEndpoint(
      endpoint, ARCHIVE_PATH, 'PAYROLL_TAX_ARCHIVE_ENDPOINT_INVALID',
    ), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), body: input.bytes,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/json',
        'cache-control': 'no-store', 'content-type': 'application/json',
        'content-length': String(input.bytes.length), 'x-content-sha256': input.sha256,
        'x-object-key': input.objectKey, 'x-data-classification': 'L4',
        'x-retention-policy': 'payroll_tax_filing', 'x-retention-days': String(retentionDays),
        'idempotency-key': digest([
          'payroll-tax-archive', input.tenantId, input.filingId,
          input.objectKey, input.sha256, String(retentionDays),
        ]),
      },
    });
    const parsed = receiptSchema.safeParse(await readBoundedJson(response, {
      invalidCode: 'PAYROLL_TAX_ARCHIVE_RECEIPT_INVALID',
      tooLargeCode: 'PAYROLL_TAX_ARCHIVE_RECEIPT_TOO_LARGE',
      lengthInvalidCode: 'PAYROLL_TAX_ARCHIVE_RESPONSE_LENGTH_INVALID',
      readErrorCode: 'PAYROLL_TAX_ARCHIVE_RESPONSE_READ_ERROR',
    }));
    if (
      !parsed.success || parsed.data.sha256 !== input.sha256 ||
      parsed.data.objectKey !== input.objectKey || parsed.data.retentionDays < retentionDays ||
      parsed.data.objectRef === parsed.data.evidenceId
    ) throw new Error('PAYROLL_TAX_ARCHIVE_RECEIPT_INVALID');
    return Object.freeze({
      objectRef: parsed.data.objectRef, evidenceId: parsed.data.evidenceId, immutable: true,
    });
  }
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(endpoint, init); } catch { throw new Error('PAYROLL_TAX_ARCHIVE_UNAVAILABLE'); }
  if (!response.ok) throw new Error(`PAYROLL_TAX_ARCHIVE_HTTP_${response.status}`);
  if (!isPayrollTaxJsonContentType(response.headers.get('content-type'))) {
    throw new Error('PAYROLL_TAX_ARCHIVE_RECEIPT_INVALID');
  }
  return response;
}

function assertManifestBinding(bytes: Buffer, tenantId: string, filingId: string): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('PAYROLL_TAX_ARCHIVE_MANIFEST_INVALID');
  }
  const parsed = archiveRootSchema.safeParse(manifest);
  const parsedFilingId = parsed.success
    ? parsed.data.schema === 'CN_IIT_WITHHOLDING_MANIFEST_V1'
      ? parsed.data.filingId
      : parsed.data.correctionFilingId
    : null;
  if (
    !parsed.success ||
    parsed.data.tenantId !== tenantId ||
    parsedFilingId !== filingId
  ) throw new Error('PAYROLL_TAX_ARCHIVE_MANIFEST_INVALID');
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}

function isCredential(value: string): boolean {
  return value.length >= 32 && value.length <= 512 && [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 33 && code <= 126;
  });
}
