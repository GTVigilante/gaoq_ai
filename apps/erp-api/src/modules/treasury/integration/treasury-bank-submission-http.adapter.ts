import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import type { ProductionExecutionAuthorization } from '../../../core/production-execution/production-execution-authorization.service.js';
import {
  TreasuryBankSubmissionGateway,
  type TreasuryBankSubmissionReceipt,
} from './treasury-bank-submission.ports.js';

const RESPONSE_LIMIT_BYTES = 16 * 1024;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OBJECT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/;
const receiptBase = {
  submissionId: z.string().regex(ID_PATTERN), evidenceId: z.string().regex(ID_PATTERN),
  accepted: z.literal(true), batchId: z.string().regex(ID_PATTERN),
  objectRef: z.string().regex(OBJECT_REF_PATTERN), fileHash: z.string().regex(HASH_PATTERN),
  lineCount: z.number().int().min(1).max(5_000),
  totalMinor: z.number().int().safe().positive(),
};
const receiptSchema = z.discriminatedUnion('submissionMode', [
  z.object({ ...receiptBase, submissionMode: z.literal('sandbox') }).strict(),
  z.object({
    ...receiptBase,
    submissionMode: z.literal('production'),
    productionAuthorizationId: z.string().regex(ID_PATTERN),
    productionAuthorizationEvidenceId: z.string().regex(ID_PATTERN),
    releaseCommitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    deploymentManifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  }).strict(),
]);

/** 独立银行提交 HTTPS Adapter；只传 WORM 引用和批次控制量，不处理账户或文件正文。 */
@Injectable()
export class HttpTreasuryBankSubmissionGateway extends TreasuryBankSubmissionGateway {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) { super(); }

  override async submit(input: {
    readonly tenantId: string; readonly batchId: string; readonly objectRef: string;
    readonly fileHash: string; readonly lineCount: number; readonly totalMinor: number;
    readonly productionAuthorization: ProductionExecutionAuthorization | null;
  }): Promise<TreasuryBankSubmissionReceipt> {
    assertInput(input);
    const endpoint = this.config.get('TREASURY_BANK_SUBMISSION_ENDPOINT', { infer: true });
    const token = this.config.get('TREASURY_BANK_SUBMISSION_BEARER_TOKEN', { infer: true });
    const submissionMode = this.config.get('TREASURY_BANK_SUBMISSION_MODE', { infer: true });
    if (endpoint === undefined || token === undefined) {
      throw new Error('TREASURY_BANK_SUBMISSION_UNAVAILABLE');
    }
    if (submissionMode !== 'sandbox' && submissionMode !== 'production') {
      throw new Error('TREASURY_BANK_SUBMISSION_MODE_INVALID');
    }
    assertAuthorization(input.productionAuthorization, submissionMode);
    const { productionAuthorization, ...submission } = input;
    const body = JSON.stringify(submissionMode === 'sandbox'
      ? { ...submission, submissionMode }
      : { ...submission, submissionMode, productionAuthorization });
    const response = await safeFetch(safeEndpoint(endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/json',
        'cache-control': 'no-store', 'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'idempotency-key': digest([
          'treasury-bank-submit', input.tenantId, input.batchId, input.objectRef,
          input.fileHash, String(input.lineCount), String(input.totalMinor), submissionMode,
        ]),
      },
      body,
    });
    const parsed = receiptSchema.safeParse(await readJson(response));
    if (
      !parsed.success || parsed.data.batchId !== input.batchId ||
      parsed.data.objectRef !== input.objectRef || parsed.data.fileHash !== input.fileHash ||
      parsed.data.lineCount !== input.lineCount || parsed.data.totalMinor !== input.totalMinor ||
      parsed.data.submissionMode !== submissionMode ||
      (parsed.data.submissionMode === 'production' && (
        input.productionAuthorization === null ||
        parsed.data.productionAuthorizationId !== input.productionAuthorization.authorizationId ||
        parsed.data.productionAuthorizationEvidenceId !== input.productionAuthorization.evidenceId ||
        parsed.data.releaseCommitSha !== input.productionAuthorization.releaseCommitSha ||
        parsed.data.deploymentManifestHash !==
          input.productionAuthorization.deploymentManifestHash
      ))
    ) throw new Error('TREASURY_BANK_SUBMISSION_RECEIPT_INVALID');
    return Object.freeze({
      submissionId: parsed.data.submissionId,
      evidenceId: parsed.data.evidenceId,
      accepted: true,
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
    if (authorization !== null) throw new Error('TREASURY_BANK_SANDBOX_AUTHORIZATION_FORBIDDEN');
    return;
  }
  const expiresAt = authorization === null ? Number.NaN : Date.parse(authorization.expiresAt);
  if (
    authorization === null || !ID_PATTERN.test(authorization.authorizationId) ||
    !ID_PATTERN.test(authorization.evidenceId) ||
    !/^[a-f0-9]{40}$/u.test(authorization.releaseCommitSha) ||
    !/^sha256:[a-f0-9]{64}$/u.test(authorization.deploymentManifestHash) ||
    !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 10_000
  ) throw new Error('TREASURY_BANK_PRODUCTION_AUTHORIZATION_INVALID');
}

function assertInput(input: {
  readonly tenantId: string; readonly batchId: string; readonly objectRef: string;
  readonly fileHash: string; readonly lineCount: number; readonly totalMinor: number;
}): void {
  if (
    !ID_PATTERN.test(input.tenantId) || !ID_PATTERN.test(input.batchId) ||
    !OBJECT_REF_PATTERN.test(input.objectRef) || !HASH_PATTERN.test(input.fileHash) ||
    !Number.isSafeInteger(input.lineCount) || input.lineCount < 1 || input.lineCount > 5_000 ||
    !Number.isSafeInteger(input.totalMinor) || input.totalMinor < 1
  ) throw new Error('TREASURY_BANK_SUBMISSION_INPUT_INVALID');
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(endpoint, init); } catch {
    throw new Error('TREASURY_BANK_SUBMISSION_UNAVAILABLE');
  }
  if (!response.ok) throw new Error(`TREASURY_BANK_SUBMISSION_HTTP_${response.status}`);
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('TREASURY_BANK_SUBMISSION_RECEIPT_INVALID');
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('TREASURY_BANK_SUBMISSION_RECEIPT_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) {
        throw new Error('TREASURY_BANK_SUBMISSION_RECEIPT_INVALID');
      }
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) throw new Error('TREASURY_BANK_SUBMISSION_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; } catch {
    throw new Error('TREASURY_BANK_SUBMISSION_RECEIPT_INVALID');
  }
}

function safeEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443')
  ) throw new Error('TREASURY_BANK_SUBMISSION_ENDPOINT_INVALID');
  return endpoint.toString();
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
