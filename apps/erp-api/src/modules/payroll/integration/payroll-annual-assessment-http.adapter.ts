import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import {
  isPayrollTaxJsonContentType,
  readBoundedJsonDocument,
  safePayrollTaxEndpoint,
} from './payroll-tax-http.shared.js';
import {
  PayrollAnnualAssessmentGateway,
  type PayrollAnnualSettlementLink,
  type PayrollOfficialAnnualAssessment,
} from './payroll-tax.ports.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const RESOLVE_PATH = '/v1/annual-assessments/resolve';
const SETTLEMENT_PATH = '/v1/annual-settlement-links';
const REQUEST_LIMIT_BYTES = 4 * 1024;
const TIME = z.iso.datetime({ offset: true });

const assessmentReceiptSchema = z.object({
  tenantId: z.string().regex(ID),
  employeeId: z.string().regex(ID),
  taxYear: z.string().regex(/^\d{4}$/),
  controlDigest: z.string().regex(HASH),
  assessmentId: z.string().regex(ID),
  assessmentEvidenceId: z.string().regex(ID),
  assessedTaxMinor: z.number().int().safe().nonnegative(),
  sourceDigest: z.string().regex(HASH),
  issuedAt: TIME,
}).strict();

const settlementReceiptSchema = z.object({
  tenantId: z.string().regex(ID),
  employeeId: z.string().regex(ID),
  annualReconciliationId: z.string().regex(ULID),
  taxYear: z.string().regex(/^\d{4}$/),
  evidenceHash: z.string().regex(HASH),
  controlDigest: z.string().regex(HASH),
  settlementUrl: z.string().url().max(2_048),
  expiresAt: TIME,
  issuedAt: TIME,
}).strict();

/** 年度个税适配器只做最小字段传输、官方回执验签与办理链接同源校验。 */
@Injectable()
export class HttpPayrollAnnualAssessmentGateway
  extends PayrollAnnualAssessmentGateway {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    super();
  }

  override async resolve(input: {
    readonly tenantId: string;
    readonly employeeId: string;
    readonly taxYear: string;
    readonly idempotencyKey: string;
  }): Promise<PayrollOfficialAnnualAssessment> {
    assertResolveInput(input);
    const payload = {
      tenantId: input.tenantId,
      employeeId: input.employeeId,
      taxYear: input.taxYear,
    };
    const parsedReceipt = assessmentReceiptSchema.safeParse(await this.request(
      RESOLVE_PATH,
      payload,
      input.idempotencyKey,
    ));
    if (!parsedReceipt.success) {
      throw new Error('PAYROLL_ANNUAL_ASSESSMENT_RECEIPT_INVALID');
    }
    const receipt = parsedReceipt.data;
    const controlDigest = digest(payload);
    if (
      receipt.tenantId !== input.tenantId ||
      receipt.employeeId !== input.employeeId ||
      receipt.taxYear !== input.taxYear ||
      receipt.controlDigest !== controlDigest ||
      receipt.assessmentId === receipt.assessmentEvidenceId ||
      !isFresh(receipt.issuedAt)
    ) throw new Error('PAYROLL_ANNUAL_ASSESSMENT_RECEIPT_INVALID');
    return Object.freeze({
      assessmentId: receipt.assessmentId,
      assessmentEvidenceId: receipt.assessmentEvidenceId,
      assessedTaxMinor: receipt.assessedTaxMinor,
      sourceDigest: receipt.sourceDigest,
    });
  }

  override async createSettlementLink(input: {
    readonly tenantId: string;
    readonly employeeId: string;
    readonly annualReconciliationId: string;
    readonly taxYear: string;
    readonly evidenceHash: string;
    readonly idempotencyKey: string;
  }): Promise<PayrollAnnualSettlementLink> {
    assertSettlementInput(input);
    const payload = {
      tenantId: input.tenantId,
      employeeId: input.employeeId,
      annualReconciliationId: input.annualReconciliationId,
      taxYear: input.taxYear,
      evidenceHash: input.evidenceHash,
    };
    const parsedReceipt = settlementReceiptSchema.safeParse(await this.request(
      SETTLEMENT_PATH,
      payload,
      input.idempotencyKey,
    ));
    if (!parsedReceipt.success) {
      throw new Error('PAYROLL_ANNUAL_SETTLEMENT_RECEIPT_INVALID');
    }
    const receipt = parsedReceipt.data;
    const controlDigest = digest(payload);
    if (
      receipt.tenantId !== input.tenantId ||
      receipt.employeeId !== input.employeeId ||
      receipt.annualReconciliationId !== input.annualReconciliationId ||
      receipt.taxYear !== input.taxYear ||
      receipt.evidenceHash !== input.evidenceHash ||
      receipt.controlDigest !== controlDigest ||
      !isFresh(receipt.issuedAt)
    ) throw new Error('PAYROLL_ANNUAL_SETTLEMENT_RECEIPT_INVALID');
    const expectedOrigin = this.required('PAYROLL_TAX_OFFICIAL_PORTAL_ORIGIN');
    const settlementUrl = safeSettlementUrl(receipt.settlementUrl, expectedOrigin);
    const expiresAt = Date.parse(receipt.expiresAt);
    const now = Date.now();
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now + 30_000 ||
      expiresAt > now + 5 * 60_000
    ) throw new Error('PAYROLL_ANNUAL_SETTLEMENT_RECEIPT_INVALID');
    return Object.freeze({
      settlementUrl,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  private async request(
    path: string,
    payload: Readonly<Record<string, string>>,
    idempotencyKey: string,
  ): Promise<unknown> {
    const endpoint = this.required('PAYROLL_TAX_GATEWAY_ENDPOINT');
    const token = this.required('PAYROLL_TAX_GATEWAY_BEARER_TOKEN');
    const keyId = this.required('PAYROLL_TAX_GATEWAY_SIGNING_KEY_ID');
    const publicKey = this.publicKey(this.required(
      'PAYROLL_TAX_GATEWAY_SIGNING_PUBLIC_KEY_BASE64',
    ));
    if (!/^[\x21-\x7e]{32,512}$/u.test(token)) {
      throw new Error('PAYROLL_ANNUAL_GATEWAY_CREDENTIAL_INVALID');
    }
    if (!KEY_ID.test(keyId)) throw new Error('PAYROLL_ANNUAL_SIGNING_KEY_INVALID');
    const body = JSON.stringify({ ...payload, controlDigest: digest(payload) });
    if (Buffer.byteLength(body, 'utf8') > REQUEST_LIMIT_BYTES) {
      throw new Error('PAYROLL_ANNUAL_GATEWAY_REQUEST_TOO_LARGE');
    }
    const gatewayOrigin = safePayrollTaxEndpoint(
      endpoint,
      '/v1/submissions',
      'PAYROLL_ANNUAL_GATEWAY_ENDPOINT_INVALID',
    );
    const response = await safeFetch(new URL(path, gatewayOrigin).toString(), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      body,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'accept-encoding': 'identity',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body, 'utf8')),
        'idempotency-key': idempotencyKey,
      },
    });
    const document = await readBoundedJsonDocument(response, {
      invalidCode: 'PAYROLL_ANNUAL_GATEWAY_RECEIPT_INVALID',
      tooLargeCode: 'PAYROLL_ANNUAL_GATEWAY_RECEIPT_TOO_LARGE',
      lengthInvalidCode: 'PAYROLL_ANNUAL_GATEWAY_RESPONSE_LENGTH_INVALID',
      readErrorCode: 'PAYROLL_ANNUAL_GATEWAY_RESPONSE_READ_ERROR',
    });
    this.verifyReceipt(response, document.bytes, keyId, publicKey);
    return document.value;
  }

  private verifyReceipt(
    response: Response,
    receiptBytes: Uint8Array,
    expectedKeyId: string,
    publicKey: KeyObject,
  ): void {
    const keyId = response.headers.get('x-gaoq-signing-key-id');
    const signatureValue = response.headers.get('x-gaoq-signature');
    if (
      keyId !== expectedKeyId ||
      signatureValue === null ||
      !SIGNATURE.test(signatureValue)
    ) throw new Error('PAYROLL_ANNUAL_GATEWAY_RECEIPT_SIGNATURE_INVALID');
    let signature: Buffer;
    try {
      signature = canonicalBase64Url(signatureValue);
    } catch {
      throw new Error('PAYROLL_ANNUAL_GATEWAY_RECEIPT_SIGNATURE_INVALID');
    }
    const signingInput = Buffer.from(
      `gaoq-payroll-annual-receipt-v1\n${keyId}\n${
        createHash('sha256').update(receiptBytes).digest('base64url')
      }`,
      'utf8',
    );
    if (
      signature.byteLength !== 64 ||
      !verify(null, signingInput, publicKey, signature)
    ) throw new Error('PAYROLL_ANNUAL_GATEWAY_RECEIPT_SIGNATURE_INVALID');
  }

  private publicKey(value: string): KeyObject {
    try {
      const decoded = canonicalBase64(value);
      const key = createPublicKey({ key: decoded, format: 'der', type: 'spki' });
      const exported = key.export({ format: 'der', type: 'spki' });
      if (
        key.asymmetricKeyType !== 'ed25519' ||
        !Buffer.isBuffer(exported) ||
        !exported.equals(decoded)
      ) throw new Error('INVALID');
      return key;
    } catch {
      throw new Error('PAYROLL_ANNUAL_SIGNING_KEY_INVALID');
    }
  }

  private required<Key extends keyof AppEnvironment>(key: Key): string {
    const value = this.config.get(key, { infer: true });
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('PAYROLL_ANNUAL_GATEWAY_UNAVAILABLE');
    }
    return value;
  }
}

function assertResolveInput(input: Readonly<Record<string, unknown>>): void {
  if (
    Object.keys(input).sort().join(',') !==
      'employeeId,idempotencyKey,taxYear,tenantId' ||
    typeof input.tenantId !== 'string' || !ID.test(input.tenantId) ||
    typeof input.employeeId !== 'string' || !ID.test(input.employeeId) ||
    typeof input.taxYear !== 'string' || !/^\d{4}$/u.test(input.taxYear) ||
    typeof input.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) throw new Error('PAYROLL_ANNUAL_ASSESSMENT_INPUT_INVALID');
}

function assertSettlementInput(input: Readonly<Record<string, unknown>>): void {
  if (
    Object.keys(input).sort().join(',') !==
      'annualReconciliationId,employeeId,evidenceHash,idempotencyKey,taxYear,tenantId' ||
    typeof input.tenantId !== 'string' || !ID.test(input.tenantId) ||
    typeof input.employeeId !== 'string' || !ID.test(input.employeeId) ||
    typeof input.annualReconciliationId !== 'string' ||
    !ULID.test(input.annualReconciliationId) ||
    typeof input.taxYear !== 'string' || !/^\d{4}$/u.test(input.taxYear) ||
    typeof input.evidenceHash !== 'string' || !HASH.test(input.evidenceHash) ||
    typeof input.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) throw new Error('PAYROLL_ANNUAL_SETTLEMENT_INPUT_INVALID');
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch {
    throw new Error('PAYROLL_ANNUAL_GATEWAY_UNAVAILABLE');
  }
  if (!response.ok) throw new Error(`PAYROLL_ANNUAL_GATEWAY_HTTP_${response.status}`);
  if (
    !isPayrollTaxJsonContentType(response.headers.get('content-type')) ||
    response.headers.get('content-encoding') !== null
  ) throw new Error('PAYROLL_ANNUAL_GATEWAY_RECEIPT_INVALID');
  return response;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('base64url');
}

function isFresh(value: string): boolean {
  const issuedAt = Date.parse(value);
  return Number.isFinite(issuedAt) &&
    issuedAt >= Date.now() - 5 * 60_000 &&
    issuedAt <= Date.now() + 60_000;
}

function safeSettlementUrl(value: string, expectedOrigin: string): string {
  let url: URL;
  let origin: URL;
  try {
    url = new URL(value);
    origin = new URL(expectedOrigin);
  } catch {
    throw new Error('PAYROLL_ANNUAL_SETTLEMENT_URL_INVALID');
  }
  if (
    origin.pathname !== '/' || origin.search !== '' || origin.hash !== '' ||
    origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' ||
    (origin.port !== '' && origin.port !== '443') ||
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.hash !== '' || (url.port !== '' && url.port !== '443') ||
    url.origin !== origin.origin
  ) throw new Error('PAYROLL_ANNUAL_SETTLEMENT_URL_INVALID');
  return url.toString();
}

function canonicalBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error('INVALID');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('INVALID');
  return decoded;
}

function canonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('INVALID');
  return decoded;
}
