import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import { readBoundedJson, safePayrollTaxEndpoint } from './payroll-tax-http.shared.js';
import { PayrollTaxGateway, type PayrollTaxSubmissionReceipt } from './payroll-tax.ports.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const receiptSchema = z.object({
  submissionId: z.string().regex(ID), evidenceId: z.string().regex(ID), accepted: z.literal(true),
  tenantId: z.string().regex(ID), filingId: z.string().regex(ID),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  objectRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/),
  contentHash: z.string().regex(HASH), employeeCount: z.number().int().min(1).max(5_000),
  totalTaxableEarningsMinor: z.number().int().safe().nonnegative(),
  totalWithholdingTaxMinor: z.number().int().safe(),
  submissionMode: z.literal('sandbox'),
}).strict();

@Injectable()
export class HttpPayrollTaxGateway extends PayrollTaxGateway {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async submit(input: {
    readonly tenantId: string; readonly filingId: string; readonly period: string;
    readonly objectRef: string; readonly contentHash: string; readonly employeeCount: number;
    readonly totalTaxableEarningsMinor: number; readonly totalWithholdingTaxMinor: number;
  }): Promise<PayrollTaxSubmissionReceipt> {
    if (
      !ID.test(input.tenantId) || !ID.test(input.filingId) ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period) ||
      !/^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/.test(input.objectRef) ||
      !HASH.test(input.contentHash) || !Number.isSafeInteger(input.employeeCount) ||
      input.employeeCount < 1 || input.employeeCount > 5_000 ||
      !Number.isSafeInteger(input.totalTaxableEarningsMinor) ||
      input.totalTaxableEarningsMinor < 0 || !Number.isSafeInteger(input.totalWithholdingTaxMinor)
    ) throw new Error('PAYROLL_TAX_GATEWAY_INPUT_INVALID');
    const endpoint = this.config.get('PAYROLL_TAX_GATEWAY_ENDPOINT', { infer: true });
    const token = this.config.get('PAYROLL_TAX_GATEWAY_BEARER_TOKEN', { infer: true });
    const submissionMode = this.config.get('PAYROLL_TAX_GATEWAY_MODE', { infer: true });
    if (endpoint === undefined || token === undefined) throw new Error('PAYROLL_TAX_GATEWAY_UNAVAILABLE');
    if (submissionMode !== 'sandbox') throw new Error('PAYROLL_TAX_PRODUCTION_SUBMISSION_NOT_AUTHORIZED');
    const body = JSON.stringify({ ...input, submissionMode });
    const response = await safeFetch(safePayrollTaxEndpoint(endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), body,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/json',
        'cache-control': 'no-store', 'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'idempotency-key': digest([
          'payroll-tax-submit', input.tenantId, input.filingId, input.period, input.objectRef,
          input.contentHash, String(input.employeeCount),
          String(input.totalTaxableEarningsMinor), String(input.totalWithholdingTaxMinor),
          submissionMode,
        ]),
      },
    });
    const parsed = receiptSchema.safeParse(await readBoundedJson(
      response, 'PAYROLL_TAX_GATEWAY_RECEIPT_INVALID', 'PAYROLL_TAX_GATEWAY_RECEIPT_TOO_LARGE',
    ));
    if (
      !parsed.success || parsed.data.submissionMode !== submissionMode ||
      Object.entries(input).some(([key, value]) =>
        parsed.data[key as keyof typeof parsed.data] !== value)
    ) {
      throw new Error('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');
    }
    return Object.freeze({
      submissionId: parsed.data.submissionId, evidenceId: parsed.data.evidenceId, accepted: true,
    });
  }
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(endpoint, init); } catch { throw new Error('PAYROLL_TAX_GATEWAY_UNAVAILABLE'); }
  if (!response.ok) throw new Error(`PAYROLL_TAX_GATEWAY_HTTP_${response.status}`);
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');
  }
  return response;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
