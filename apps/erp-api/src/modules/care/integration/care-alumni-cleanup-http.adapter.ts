import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { CareAlumniCleanupTargetRegistry } from './care-alumni-cleanup-target-registry.js';
import {
  cleanupControlDigest,
  cleanupIdempotencyKey,
  cleanupTaskId,
  type AlumniCleanupProof,
  type AlumniCleanupTask,
} from '../domain/index.js';
import { CareAlumniCleanupPort } from './care-alumni-cleanup.port.js';

const MAX_REQUEST_BYTES = 4_096;
const MAX_PROOF_RESPONSE_BYTES = 16_384;
const EXECUTE_PATH = '/v1/alumni-consent-cleanups/execute';
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGET_CODE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const POLICY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const PROOF_REFERENCE_PATTERN =
  /^(?:worm|ledger):[A-Za-z0-9][A-Za-z0-9._:/-]{0,248}$/;

const taskSchema = z.object({
  id: z.string().regex(HASH_PATTERN),
  tenantId: z.string().regex(SAFE_ID_PATTERN),
  consentId: z.string().regex(SAFE_ID_PATTERN),
  consentVersion: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  consentPurpose: z.enum(['alumni_network', 'rehire_contact', 'alumni_events']),
  terminationReason: z.enum(['withdrawn', 'expired']),
  terminatedAt: z.string().min(24).max(30),
  sourceEventId: z.string().regex(SAFE_ID_PATTERN),
  targetCode: z.string().regex(TARGET_CODE_PATTERN),
  policyVersion: z.string().regex(POLICY_PATTERN),
  controlDigest: z.string().regex(HASH_PATTERN),
  maxAttempts: z.number().int().min(1).max(12),
  proofRetentionDays: z.number().int().min(2_555).max(36_500),
  status: z.literal('dispatching'),
  attempts: z.number().int().min(0).max(12),
  nextAttemptAt: z.string().min(24).max(30),
  lockedAt: z.string().min(24).max(30),
  lockedBy: z.string().regex(SAFE_ID_PATTERN),
  proofDigest: z.null(),
  proofAction: z.null(),
  proofStorage: z.null(),
  proofCompletedAt: z.null(),
  proofRetentionUntil: z.null(),
  proofKeyId: z.null(),
  lastErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{7,63}$/).nullable(),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().min(24).max(30),
  updatedAt: z.string().min(24).max(30),
}).strict();

const proofSchema = z.object({
  tenantId: z.string().regex(SAFE_ID_PATTERN),
  consentId: z.string().regex(SAFE_ID_PATTERN),
  consentVersion: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  consentPurpose: z.enum(['alumni_network', 'rehire_contact', 'alumni_events']),
  targetCode: z.string().regex(TARGET_CODE_PATTERN),
  policyVersion: z.string().regex(POLICY_PATTERN),
  controlDigest: z.string().regex(HASH_PATTERN),
  proofDigest: z.string().regex(HASH_PATTERN),
  action: z.enum(['deleted', 'anonymized', 'crypto_shredded']),
  processingBlocked: z.literal(true),
  retainedEvidenceClasses: z.tuple([
    z.literal('consent_attestation'),
    z.literal('audit_log'),
  ]),
  storage: z.enum(['immutable_worm', 'append_only_ledger']),
  proofReference: z.string().regex(PROOF_REFERENCE_PATTERN),
  completedAt: z.string().min(24).max(30),
  retentionUntil: z.string().min(24).max(30),
  keyId: z.string().regex(POLICY_PATTERN),
}).strict();

interface TrustedTarget {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly signingKeyId: string;
  readonly signingPublicKey: KeyObject;
}

/** 每个下游使用独立端点、凭据和 Ed25519 信任根，普通可变存储回执无法通过。 */
@Injectable()
export class CareAlumniCleanupHttpAdapter extends CareAlumniCleanupPort {
  constructor(private readonly targets: CareAlumniCleanupTargetRegistry) {
    super();
  }

  override async execute(task: AlumniCleanupTask): Promise<AlumniCleanupProof> {
    assertTask(task);
    const target = this.targets.require(task.targetCode);
    const trusted = assertTarget(target, task);
    const payload = Object.freeze({
      tenantId: task.tenantId,
      consentId: task.consentId,
      consentVersion: task.consentVersion,
      consentPurpose: task.consentPurpose,
      terminationReason: task.terminationReason,
      terminatedAt: task.terminatedAt,
      targetCode: task.targetCode,
      policyVersion: task.policyVersion,
      controlDigest: task.controlDigest,
      directives: Object.freeze([
        'delete_or_anonymize_business_contact',
        'deny_future_processing',
        'preserve_consent_attestation_and_audit',
      ]),
    });
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    if (body.length > MAX_REQUEST_BYTES) {
      throw new Error('CARE_ALUMNI_CLEANUP_REQUEST_TOO_LARGE');
    }
    const response = await safeFetch(trusted.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${trusted.bearerToken}`,
        accept: 'application/json',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'content-length': String(body.length),
        'idempotency-key': cleanupIdempotencyKey(task),
        'x-gaoq-protocol-version': 'care-alumni-cleanup-v1',
        'x-tenant-id': task.tenantId,
        'x-consent-id': task.consentId,
        'x-target-code': task.targetCode,
        'x-control-digest': task.controlDigest,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    assertResponseEnvelope(response, trusted.endpoint);
    const keyId = response.headers.get('x-gaoq-signing-key-id');
    const signatureValue = response.headers.get('x-gaoq-signature');
    if (
      keyId !== trusted.signingKeyId ||
      signatureValue === null ||
      !isCanonicalSignature(signatureValue)
    ) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_SIGNATURE_INVALID');
    const bytes = await readBoundedProof(response);
    const digest = createHash('sha256').update(bytes).digest('base64url');
    const signingInput = Buffer.from(
      `gaoq-care-alumni-cleanup-proof-v1\n${keyId}\n${digest}`,
      'utf8',
    );
    try {
      if (!verify(
        null,
        signingInput,
        trusted.signingPublicKey,
        Buffer.from(signatureValue, 'base64url'),
      )) throw new Error('SIGNATURE_INVALID');
    } catch {
      throw new Error('CARE_ALUMNI_CLEANUP_PROOF_SIGNATURE_INVALID');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new Error('CARE_ALUMNI_CLEANUP_PROOF_INVALID');
    }
    const parsed = proofSchema.safeParse(decoded);
    if (!parsed.success) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_INVALID');
    assertProof(parsed.data, task, keyId);
    return Object.freeze({
      proofDigest: parsed.data.proofDigest,
      action: parsed.data.action,
      storage: parsed.data.storage,
      completedAt: parsed.data.completedAt,
      retentionUntil: parsed.data.retentionUntil,
      keyId: parsed.data.keyId,
    });
  }
}

function assertTask(task: AlumniCleanupTask): void {
  const parsed = taskSchema.safeParse(task);
  if (
    !parsed.success ||
    parsed.data.attempts >= parsed.data.maxAttempts ||
    !isCanonicalInstant(parsed.data.terminatedAt) ||
    !isCanonicalInstant(parsed.data.nextAttemptAt) ||
    !isCanonicalInstant(parsed.data.lockedAt) ||
    !isCanonicalInstant(parsed.data.createdAt) ||
    !isCanonicalInstant(parsed.data.updatedAt)
  ) throw new Error('CARE_ALUMNI_CLEANUP_TASK_INVALID');
  const expectedId = cleanupTaskId(parsed.data);
  const expectedControlDigest = cleanupControlDigest(parsed.data);
  if (
    parsed.data.id !== expectedId ||
    parsed.data.controlDigest !== expectedControlDigest
  ) throw new Error('CARE_ALUMNI_CLEANUP_TASK_INTEGRITY_INVALID');
}

function assertTarget(
  target: ReturnType<CareAlumniCleanupTargetRegistry['require']>,
  task: AlumniCleanupTask,
): TrustedTarget {
  if (
    target.targetCode !== task.targetCode ||
    target.policyVersion !== task.policyVersion ||
    target.maxAttempts !== task.maxAttempts ||
    target.proofRetentionDays !== task.proofRetentionDays
  ) throw new Error('CARE_ALUMNI_CLEANUP_TARGET_POLICY_MISMATCH');
  if (!isCredential(target.bearerToken)) {
    throw new Error('CARE_ALUMNI_CLEANUP_TARGET_CREDENTIAL_INVALID');
  }
  if (!POLICY_PATTERN.test(target.signingKeyId)) {
    throw new Error('CARE_ALUMNI_CLEANUP_SIGNING_KEY_INVALID');
  }
  return Object.freeze({
    endpoint: safeEndpoint(target.endpoint),
    bearerToken: target.bearerToken,
    signingKeyId: target.signingKeyId,
    signingPublicKey: loadSigningKey(target.signingPublicKeyBase64),
  });
}

function safeEndpoint(value: unknown): string {
  let endpoint: URL;
  try {
    if (typeof value !== 'string') throw new Error('ENDPOINT_TYPE_INVALID');
    endpoint = new URL(value);
  } catch {
    throw new Error('CARE_ALUMNI_CLEANUP_TARGET_ENDPOINT_INVALID');
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443') ||
    hostname !== endpoint.hostname ||
    hostname.endsWith('.') ||
    !hostname.includes('.') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    isIP(hostname.replace(/^\[(.*)\]$/u, '$1')) !== 0
  ) throw new Error('CARE_ALUMNI_CLEANUP_TARGET_ENDPOINT_INVALID');
  return `${endpoint.origin}${EXECUTE_PATH}`;
}

function loadSigningKey(value: unknown): KeyObject {
  try {
    if (
      typeof value !== 'string' ||
      value.length < 40 ||
      value.length > 512 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        .test(value)
    ) throw new Error('KEY_ENCODING_INVALID');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new Error('KEY_ENCODING_INVALID');
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('KEY_TYPE_INVALID');
    return key;
  } catch {
    throw new Error('CARE_ALUMNI_CLEANUP_SIGNING_KEY_INVALID');
  }
}

async function safeFetch(endpoint: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch {
    throw new Error('CARE_ALUMNI_CLEANUP_GATEWAY_FAILED');
  }
  if (response.status !== 200) {
    throw new Error(`CARE_ALUMNI_CLEANUP_GATEWAY_HTTP_${response.status}`);
  }
  return response;
}

function assertResponseEnvelope(response: Response, endpoint: string): void {
  if (
    response.redirected ||
    (response.url !== '' && response.url !== endpoint) ||
    !JSON_CONTENT_TYPE.test(response.headers.get('content-type')?.trim() ?? '') ||
    ![null, 'identity'].includes(response.headers.get('content-encoding'))
  ) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_INVALID');
}

/** 流式限制下游响应，避免先完整缓冲超大证明导致 Worker 内存耗尽。 */
async function readBoundedProof(response: Response): Promise<Buffer> {
  const expectedLength = parseContentLength(
    response.headers.get('content-length'),
    response,
  );
  if (response.body === null) {
    throw new Error('CARE_ALUMNI_CLEANUP_PROOF_INVALID');
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new Error('CARE_ALUMNI_CLEANUP_PROOF_READ_ERROR');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let part: unknown;
      try {
        part = await reader.read();
      } catch {
        cancelReader(reader);
        throw new Error('CARE_ALUMNI_CLEANUP_PROOF_READ_ERROR');
      }
      if (!isStreamReadResult(part)) {
        cancelReader(reader);
        throw new Error('CARE_ALUMNI_CLEANUP_PROOF_READ_ERROR');
      }
      if (part.done) break;
      const value = part.value;
      if (!(value instanceof Uint8Array)) {
        cancelReader(reader);
        throw new Error('CARE_ALUMNI_CLEANUP_PROOF_READ_ERROR');
      }
      total += value.byteLength;
      if (total > MAX_PROOF_RESPONSE_BYTES) {
        cancelReader(reader);
        throw new Error('CARE_ALUMNI_CLEANUP_PROOF_TOO_LARGE');
      }
      if (expectedLength !== null && total > expectedLength) {
        cancelReader(reader);
        throw new Error('CARE_ALUMNI_CLEANUP_PROOF_LENGTH_INVALID');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 清理属于尽力操作，不得覆盖已经确定的证明读取结果。
    }
  }
  if (expectedLength !== null && total !== expectedLength) {
    throw new Error('CARE_ALUMNI_CLEANUP_PROOF_LENGTH_INVALID');
  }
  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    Buffer.from(chunk).copy(bytes, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseContentLength(value: string | null, response: Response): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error('CARE_ALUMNI_CLEANUP_PROOF_LENGTH_INVALID');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > MAX_PROOF_RESPONSE_BYTES) {
    cancelResponseBody(response);
    throw new Error('CARE_ALUMNI_CLEANUP_PROOF_TOO_LARGE');
  }
  return length;
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // 取消失败不得暴露上游异常或覆盖本域稳定错误码。
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // 取消失败不得暴露上游异常或覆盖本域稳定错误码。
  }
}

function assertProof(
  proof: z.infer<typeof proofSchema>,
  task: AlumniCleanupTask,
  keyId: string,
): void {
  if (
    proof.tenantId !== task.tenantId ||
    proof.consentId !== task.consentId ||
    proof.consentVersion !== task.consentVersion ||
    proof.consentPurpose !== task.consentPurpose ||
    proof.targetCode !== task.targetCode ||
    proof.policyVersion !== task.policyVersion ||
    proof.controlDigest !== task.controlDigest ||
    proof.keyId !== keyId ||
    proof.proofDigest === task.controlDigest
  ) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_CONTEXT_MISMATCH');
  if (
    (proof.storage === 'immutable_worm' &&
      !proof.proofReference.startsWith('worm:')) ||
    (proof.storage === 'append_only_ledger' &&
      !proof.proofReference.startsWith('ledger:'))
  ) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_STORAGE_INVALID');
  if (
    !isCanonicalInstant(proof.completedAt) ||
    !isCanonicalInstant(proof.retentionUntil)
  ) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_TIME_INVALID');
  const completedAt = Date.parse(proof.completedAt);
  const minimumRetention = completedAt +
    task.proofRetentionDays * 24 * 60 * 60 * 1_000;
  if (
    completedAt < Date.parse(task.terminatedAt) ||
    Date.parse(proof.retentionUntil) < minimumRetention
  ) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_RETENTION_INVALID');
}

function isCredential(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 32 &&
    value.length <= 512 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 33 && code <= 126;
    });
}

function isCanonicalSignature(value: string): boolean {
  if (!SIGNATURE_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 64 && bytes.toString('base64url') === value;
}

function isStreamReadResult(
  value: unknown,
): value is { readonly done: boolean; readonly value?: unknown } {
  return typeof value === 'object' &&
    value !== null &&
    'done' in value &&
    typeof value.done === 'boolean';
}

function isCanonicalInstant(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}
