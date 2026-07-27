import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { CareAlumniCleanupTargetRegistry } from './care-alumni-cleanup-target-registry.js';
import {
  cleanupIdempotencyKey,
  type AlumniCleanupProof,
  type AlumniCleanupTask,
} from '../domain/index.js';
import { CareAlumniCleanupPort } from './care-alumni-cleanup.port.js';

const MAX_PROOF_RESPONSE_BYTES = 16_384;

const proofSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  consentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  consentVersion: z.number().int().min(2),
  consentPurpose: z.enum(['alumni_network', 'rehire_contact', 'alumni_events']),
  targetCode: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  policyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  controlDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  proofDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  action: z.enum(['deleted', 'anonymized', 'crypto_shredded']),
  processingBlocked: z.literal(true),
  retainedEvidenceClasses: z.tuple([
    z.literal('consent_attestation'),
    z.literal('audit_log'),
  ]),
  storage: z.enum(['immutable_worm', 'append_only_ledger']),
  proofReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
  completedAt: z.iso.datetime({ offset: true }),
  retentionUntil: z.iso.datetime({ offset: true }),
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
}).strict();

/** 每个下游使用独立端点、凭据和 Ed25519 信任根，普通可变存储回执无法通过。 */
@Injectable()
export class CareAlumniCleanupHttpAdapter extends CareAlumniCleanupPort {
  constructor(private readonly targets: CareAlumniCleanupTargetRegistry) {
    super();
  }

  override async execute(task: AlumniCleanupTask): Promise<AlumniCleanupProof> {
    const target = this.targets.require(task.targetCode);
    if (target.policyVersion !== task.policyVersion) {
      throw new Error('CARE_ALUMNI_CLEANUP_TARGET_POLICY_MISMATCH');
    }
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
    const response = await fetch(
      new URL('/v1/alumni-consent-cleanups/execute', target.endpoint),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.bearerToken}`,
          'content-type': 'application/json',
          'idempotency-key': cleanupIdempotencyKey(task),
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    ).catch(() => null);
    if (response?.ok !== true) throw new Error('CARE_ALUMNI_CLEANUP_GATEWAY_FAILED');
    if (response.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
      throw new Error('CARE_ALUMNI_CLEANUP_PROOF_INVALID');
    }
    const bytes = await readBoundedProof(response);
    if (bytes.length < 2) {
      throw new Error('CARE_ALUMNI_CLEANUP_PROOF_INVALID');
    }
    const keyId = response.headers.get('x-gaoq-signing-key-id');
    const signatureValue = response.headers.get('x-gaoq-signature');
    if (
      keyId !== target.signingKeyId ||
      signatureValue === null ||
      !/^[A-Za-z0-9_-]{86}$/.test(signatureValue)
    ) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_SIGNATURE_INVALID');
    const digest = createHash('sha256').update(bytes).digest('base64url');
    const signingInput = Buffer.from(
      `gaoq-care-alumni-cleanup-proof-v1\n${keyId}\n${digest}`,
      'utf8',
    );
    let publicKey;
    try {
      publicKey = createPublicKey({
        key: Buffer.from(target.signingPublicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });
    } catch {
      throw new Error('CARE_ALUMNI_CLEANUP_SIGNING_KEY_INVALID');
    }
    if (!verify(
      null,
      signingInput,
      publicKey,
      Buffer.from(signatureValue, 'base64url'),
    )) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_SIGNATURE_INVALID');
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error('CARE_ALUMNI_CLEANUP_PROOF_INVALID');
    }
    const proof = proofSchema.parse(decoded);
    if (
      proof.tenantId !== task.tenantId ||
      proof.consentId !== task.consentId ||
      proof.consentVersion !== task.consentVersion ||
      proof.consentPurpose !== task.consentPurpose ||
      proof.targetCode !== task.targetCode ||
      proof.policyVersion !== task.policyVersion ||
      proof.controlDigest !== task.controlDigest ||
      proof.keyId !== keyId
    ) throw new Error('CARE_ALUMNI_CLEANUP_PROOF_CONTEXT_MISMATCH');
    return Object.freeze({
      proofDigest: proof.proofDigest,
      action: proof.action,
      storage: proof.storage,
      completedAt: new Date(proof.completedAt).toISOString(),
      retentionUntil: new Date(proof.retentionUntil).toISOString(),
      keyId: proof.keyId,
    });
  }
}

/** 流式限制下游响应，避免先完整缓冲超大证明导致 Worker 内存耗尽。 */
async function readBoundedProof(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    /^\d{1,16}$/u.test(contentLength) &&
    Number(contentLength) > MAX_PROOF_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('CARE_ALUMNI_CLEANUP_PROOF_TOO_LARGE');
  }
  if (response.body === null) {
    throw new Error('CARE_ALUMNI_CLEANUP_PROOF_INVALID');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) {
        throw new Error('CARE_ALUMNI_CLEANUP_PROOF_INVALID');
      }
      total += value.byteLength;
      if (total > MAX_PROOF_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('CARE_ALUMNI_CLEANUP_PROOF_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}
