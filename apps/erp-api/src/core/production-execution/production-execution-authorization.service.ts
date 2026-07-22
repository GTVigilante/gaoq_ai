import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[A-Za-z0-9_-]{43}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RESPONSE_LIMIT_BYTES = 16 * 1024;

export type ProductionExecutionAction =
  'payroll-tax-submission' | 'treasury-bank-submission';

export interface ProductionExecutionAuthorization {
  readonly authorizationId: string;
  readonly evidenceId: string;
  readonly expiresAt: string;
  readonly releaseCommitSha: string;
  readonly deploymentManifestHash: string;
}

export interface ProductionExecutionSubject {
  readonly action: ProductionExecutionAction;
  readonly tenantId: string;
  readonly resourceId: string;
  readonly subjectHash: string;
  readonly expectedVersion: number;
}

const authorizationSchema = z.object({
  authorizationId: z.string().regex(ID),
  evidenceId: z.string().regex(ID),
  approved: z.literal(true),
  singleUse: z.literal(true),
  action: z.enum(['payroll-tax-submission', 'treasury-bank-submission']),
  tenantId: z.string().regex(ID),
  resourceId: z.string().regex(ID),
  subjectHash: z.string().regex(HASH),
  expectedVersion: z.number().int().safe().min(1),
  releaseCommitSha: z.string().regex(COMMIT),
  deploymentManifestHash: z.string().regex(SHA256),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

/**
 * Phase 6 生产执行授权客户端。
 *
 * 授权域只返回一次性、短时、WORM 可追溯的批准引用；它不持有银行或税务凭据，
 * ERP 也不接受客户端或 MCP 提供的授权标识。
 */
@Injectable()
export class ProductionExecutionAuthorizationService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  async authorize(subject: ProductionExecutionSubject): Promise<ProductionExecutionAuthorization> {
    validateSubject(subject);
    const endpoint = this.config.get('PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT', { infer: true });
    const token = this.config.get('PHASE6_PRODUCTION_AUTHORIZATION_BEARER_TOKEN', { infer: true });
    const releaseCommitSha = this.config.get('PHASE6_RELEASE_COMMIT_SHA', { infer: true });
    const deploymentManifestHash = this.config.get(
      'PHASE6_DEPLOYMENT_MANIFEST_SHA256', { infer: true },
    );
    if (
      endpoint === undefined || token === undefined || releaseCommitSha === undefined ||
      deploymentManifestHash === undefined
    ) throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_UNAVAILABLE');
    if (!COMMIT.test(releaseCommitSha) || !SHA256.test(deploymentManifestHash)) {
      throw new Error('PHASE6_PRODUCTION_RELEASE_BINDING_INVALID');
    }
    const requestedAt = new Date().toISOString();
    const request = {
      ...subject, releaseCommitSha, deploymentManifestHash, requestedAt,
    };
    const body = JSON.stringify(request);
    const response = await safeFetch(safeEndpoint(endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), body,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'idempotency-key': digest([
          'phase6-production-authorization', subject.action, subject.tenantId,
          subject.resourceId, subject.subjectHash, String(subject.expectedVersion),
          releaseCommitSha, deploymentManifestHash,
        ]),
      },
    });
    const parsed = authorizationSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID');
    const grant = parsed.data;
    if (
      grant.action !== subject.action || grant.tenantId !== subject.tenantId ||
      grant.resourceId !== subject.resourceId || grant.subjectHash !== subject.subjectHash ||
      grant.expectedVersion !== subject.expectedVersion ||
      grant.authorizationId === grant.evidenceId ||
      grant.releaseCommitSha !== releaseCommitSha ||
      grant.deploymentManifestHash !== deploymentManifestHash
    ) throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_BINDING_MISMATCH');
    validateWindow(grant.issuedAt, grant.expiresAt, Date.now());
    return Object.freeze({
      authorizationId: grant.authorizationId,
      evidenceId: grant.evidenceId,
      expiresAt: grant.expiresAt,
      releaseCommitSha,
      deploymentManifestHash,
    });
  }
}

/** 生成不包含业务正文的授权对象摘要。 */
export function productionExecutionSubjectHash(parts: readonly (string | number)[]): string {
  if (parts.length < 2 || parts.length > 16 || parts.some((part) =>
    typeof part === 'string' ? part.length < 1 || part.length > 512 : !Number.isSafeInteger(part)
  )) throw new Error('PHASE6_PRODUCTION_SUBJECT_PARTS_INVALID');
  return digest(parts.map(String));
}

function validateSubject(subject: ProductionExecutionSubject): void {
  if (
    !['payroll-tax-submission', 'treasury-bank-submission'].includes(subject.action) ||
    !ID.test(subject.tenantId) || !ID.test(subject.resourceId) || !HASH.test(subject.subjectHash) ||
    !Number.isSafeInteger(subject.expectedVersion) || subject.expectedVersion < 1
  ) throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_SUBJECT_INVALID');
}

function validateWindow(issuedAtValue: string, expiresAtValue: string, now: number): void {
  const issuedAt = Date.parse(issuedAtValue);
  const expiresAt = Date.parse(expiresAtValue);
  if (
    !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
    issuedAt > now + 30_000 || now - issuedAt > 5 * 60_000 ||
    expiresAt <= now + 30_000 || expiresAt - issuedAt > 15 * 60_000
  ) throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_WINDOW_INVALID');
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(endpoint, init); } catch {
    throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_UNAVAILABLE');
  }
  if (!response.ok) throw new Error(`PHASE6_PRODUCTION_AUTHORIZATION_HTTP_${response.status}`);
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID');
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) {
        throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID');
      }
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; } catch {
    throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_RECEIPT_INVALID');
  }
}

function safeEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443')
  ) throw new Error('PHASE6_PRODUCTION_AUTHORIZATION_ENDPOINT_INVALID');
  return endpoint.toString();
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}
