import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import type { ProductionExecutionAuthorization } from '../../../core/production-execution/production-execution-authorization.service.js';
import {
  isPayrollTaxJsonContentType,
  readBoundedJson,
  safePayrollTaxEndpoint,
} from './payroll-tax-http.shared.js';
import { PayrollTaxGateway, type PayrollTaxSubmissionReceipt } from './payroll-tax.ports.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_REF = /^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/;
const SUBMISSION_PATH = '/v1/submissions';
const REQUEST_LIMIT_BYTES = 4 * 1024;
const authorizationTimeSchema = z.iso.datetime({ offset: true });
const receiptBase = {
  submissionId: z.string().regex(ID), evidenceId: z.string().regex(ID), accepted: z.literal(true),
  tenantId: z.string().regex(ID), filingId: z.string().regex(ULID),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  objectRef: z.string().regex(OBJECT_REF),
  contentHash: z.string().regex(HASH), employeeCount: z.number().int().min(1).max(5_000),
  totalTaxableEarningsMinor: z.number().int().safe().nonnegative(),
  totalWithholdingTaxMinor: z.number().int().safe(),
};
const receiptSchema = z.discriminatedUnion('submissionMode', [
  z.object({ ...receiptBase, submissionMode: z.literal('sandbox') }).strict(),
  z.object({
    ...receiptBase,
    submissionMode: z.literal('production'),
    productionAuthorizationId: z.string().regex(ID),
    productionAuthorizationEvidenceId: z.string().regex(ID),
    releaseCommitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    deploymentManifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  }).strict(),
]);

@Injectable()
export class HttpPayrollTaxGateway extends PayrollTaxGateway {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async submit(input: {
    readonly tenantId: string; readonly filingId: string; readonly period: string;
    readonly objectRef: string; readonly contentHash: string; readonly employeeCount: number;
    readonly totalTaxableEarningsMinor: number; readonly totalWithholdingTaxMinor: number;
    readonly productionAuthorization: ProductionExecutionAuthorization | null;
  }): Promise<PayrollTaxSubmissionReceipt> {
    if (
      !ID.test(input.tenantId) || !ULID.test(input.filingId) ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period) ||
      !OBJECT_REF.test(input.objectRef) ||
      !HASH.test(input.contentHash) || !Number.isSafeInteger(input.employeeCount) ||
      input.employeeCount < 1 || input.employeeCount > 5_000 ||
      !Number.isSafeInteger(input.totalTaxableEarningsMinor) ||
      input.totalTaxableEarningsMinor < 0 || !Number.isSafeInteger(input.totalWithholdingTaxMinor)
    ) throw new Error('PAYROLL_TAX_GATEWAY_INPUT_INVALID');
    const endpoint = this.config.get('PAYROLL_TAX_GATEWAY_ENDPOINT', { infer: true });
    const token = this.config.get('PAYROLL_TAX_GATEWAY_BEARER_TOKEN', { infer: true });
    const submissionMode = this.config.get('PAYROLL_TAX_GATEWAY_MODE', { infer: true });
    if (endpoint === undefined || token === undefined) throw new Error('PAYROLL_TAX_GATEWAY_UNAVAILABLE');
    if (!isCredential(token)) throw new Error('PAYROLL_TAX_GATEWAY_CREDENTIAL_INVALID');
    if (submissionMode !== 'sandbox' && submissionMode !== 'production') {
      throw new Error('PAYROLL_TAX_GATEWAY_MODE_INVALID');
    }
    assertAuthorization(input.productionAuthorization, submissionMode);
    const { productionAuthorization, ...submission } = input;
    const body = JSON.stringify(submissionMode === 'sandbox'
      ? { ...submission, submissionMode }
      : { ...submission, submissionMode, productionAuthorization });
    if (Buffer.byteLength(body) > REQUEST_LIMIT_BYTES) {
      throw new Error('PAYROLL_TAX_GATEWAY_REQUEST_TOO_LARGE');
    }
    const response = await safeFetch(safePayrollTaxEndpoint(
      endpoint, SUBMISSION_PATH, 'PAYROLL_TAX_GATEWAY_ENDPOINT_INVALID',
    ), {
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
    const parsed = receiptSchema.safeParse(await readBoundedJson(response, {
      invalidCode: 'PAYROLL_TAX_GATEWAY_RECEIPT_INVALID',
      tooLargeCode: 'PAYROLL_TAX_GATEWAY_RECEIPT_TOO_LARGE',
      lengthInvalidCode: 'PAYROLL_TAX_GATEWAY_RESPONSE_LENGTH_INVALID',
      readErrorCode: 'PAYROLL_TAX_GATEWAY_RESPONSE_READ_ERROR',
    }));
    if (
      !parsed.success || parsed.data.submissionMode !== submissionMode ||
      parsed.data.submissionId === parsed.data.evidenceId ||
      Object.entries(submission).some(([key, value]) =>
        parsed.data[key as keyof typeof parsed.data] !== value) ||
      (parsed.data.submissionMode === 'production' && (
        input.productionAuthorization === null ||
        parsed.data.productionAuthorizationId !== input.productionAuthorization.authorizationId ||
        parsed.data.productionAuthorizationEvidenceId !== input.productionAuthorization.evidenceId ||
        parsed.data.releaseCommitSha !== input.productionAuthorization.releaseCommitSha ||
        parsed.data.deploymentManifestHash !==
          input.productionAuthorization.deploymentManifestHash
      ))
    ) {
      throw new Error('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');
    }
    return Object.freeze({
      submissionId: parsed.data.submissionId, evidenceId: parsed.data.evidenceId, accepted: true,
      productionAuthorizationEvidenceId: parsed.data.submissionMode === 'production'
        ? parsed.data.productionAuthorizationEvidenceId : null,
    });
  }
}

function assertAuthorization(
  authorization: ProductionExecutionAuthorization | null,
  mode: 'sandbox' | 'production',
): void {
  if (mode === 'sandbox') {
    if (authorization !== null) throw new Error('PAYROLL_TAX_SANDBOX_AUTHORIZATION_FORBIDDEN');
    return;
  }
  const expiresAt = authorization === null ? Number.NaN : Date.parse(authorization.expiresAt);
  const now = Date.now();
  if (
    authorization === null || !ID.test(authorization.authorizationId) ||
    !ID.test(authorization.evidenceId) ||
    authorization.authorizationId === authorization.evidenceId ||
    !/^[a-f0-9]{40}$/u.test(authorization.releaseCommitSha) ||
    !/^sha256:[a-f0-9]{64}$/u.test(authorization.deploymentManifestHash) ||
    !authorizationTimeSchema.safeParse(authorization.expiresAt).success ||
    !Number.isFinite(expiresAt) || expiresAt <= now + 30_000 ||
    expiresAt > now + 15 * 60_000
  ) throw new Error('PAYROLL_TAX_PRODUCTION_AUTHORIZATION_INVALID');
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(endpoint, init); } catch { throw new Error('PAYROLL_TAX_GATEWAY_UNAVAILABLE'); }
  if (!response.ok) throw new Error(`PAYROLL_TAX_GATEWAY_HTTP_${response.status}`);
  if (!isPayrollTaxJsonContentType(response.headers.get('content-type'))) {
    throw new Error('PAYROLL_TAX_GATEWAY_RECEIPT_INVALID');
  }
  return response;
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
