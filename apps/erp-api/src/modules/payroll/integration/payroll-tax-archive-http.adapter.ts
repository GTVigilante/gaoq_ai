import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import { readBoundedJson, safePayrollTaxEndpoint } from './payroll-tax-http.shared.js';
import { PayrollTaxImmutableArchive, type PayrollTaxArchiveReceipt } from './payroll-tax.ports.js';

const HASH = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_KEY = /^payroll-tax\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[A-Za-z0-9_-]{43}\.json$/;
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
    const prefix = input.bytes.toString('utf8', 0, 72);
    if (
      input.bytes.length < 2 || input.bytes.length > 8 * 1024 * 1024 ||
      ![
        '{"schema":"CN_IIT_WITHHOLDING_MANIFEST_V1"',
        '{"schema":"CN_IIT_WITHHOLDING_CORRECTION_V1"',
      ].some((schemaPrefix) => prefix.startsWith(schemaPrefix)) ||
      !HASH.test(input.sha256) ||
      createHash('sha256').update(input.bytes).digest('base64url') !== input.sha256 ||
      !OBJECT_KEY.test(input.objectKey) ||
      input.objectKey !== `payroll-tax/${input.filingId}/${input.sha256}.json`
    ) throw new Error('PAYROLL_TAX_ARCHIVE_INPUT_INVALID');
    const endpoint = this.config.get('PAYROLL_TAX_WORM_ARCHIVE_ENDPOINT', { infer: true });
    const token = this.config.get('PAYROLL_TAX_WORM_ARCHIVE_BEARER_TOKEN', { infer: true });
    const retentionDays = this.config.get('PAYROLL_TAX_WORM_RETENTION_DAYS', { infer: true });
    if (endpoint === undefined || token === undefined) throw new Error('PAYROLL_TAX_ARCHIVE_UNAVAILABLE');
    const response = await safeFetch(safePayrollTaxEndpoint(endpoint), {
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
    const parsed = receiptSchema.safeParse(await readBoundedJson(
      response, 'PAYROLL_TAX_ARCHIVE_RECEIPT_INVALID', 'PAYROLL_TAX_ARCHIVE_RECEIPT_TOO_LARGE',
    ));
    if (
      !parsed.success || parsed.data.sha256 !== input.sha256 ||
      parsed.data.objectKey !== input.objectKey || parsed.data.retentionDays < retentionDays
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
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('PAYROLL_TAX_ARCHIVE_RECEIPT_INVALID');
  }
  return response;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
