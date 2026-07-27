import { createHash } from 'node:crypto';

import type { CareAlumniCleanupTarget } from '../../../config/care-alumni-cleanup-targets.js';
import type { AlumniConsent } from './care.js';

export type AlumniCleanupTerminationReason = 'withdrawn' | 'expired';
export type AlumniCleanupAction = 'deleted' | 'anonymized' | 'crypto_shredded';
export type AlumniCleanupProofStorage = 'immutable_worm' | 'append_only_ledger';
export type AlumniCleanupTaskStatus =
  | 'pending'
  | 'dispatching'
  | 'completed'
  | 'dead';

export interface AlumniCleanupTask {
  readonly id: string;
  readonly tenantId: string;
  readonly consentId: string;
  readonly consentVersion: number;
  readonly consentPurpose: AlumniConsent['purpose'];
  readonly terminationReason: AlumniCleanupTerminationReason;
  readonly terminatedAt: string;
  readonly sourceEventId: string;
  readonly targetCode: string;
  readonly policyVersion: string;
  readonly controlDigest: string;
  readonly maxAttempts: number;
  readonly proofRetentionDays: number;
  readonly status: AlumniCleanupTaskStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lockedAt: string | null;
  readonly lockedBy: string | null;
  readonly proofDigest: string | null;
  readonly proofAction: AlumniCleanupAction | null;
  readonly proofStorage: AlumniCleanupProofStorage | null;
  readonly proofCompletedAt: string | null;
  readonly proofRetentionUntil: string | null;
  readonly proofKeyId: string | null;
  readonly lastErrorCode: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AlumniCleanupProof {
  readonly proofDigest: string;
  readonly action: AlumniCleanupAction;
  readonly storage: AlumniCleanupProofStorage;
  readonly completedAt: string;
  readonly retentionUntil: string;
  readonly keyId: string;
}

/** 从授权终止事实和服务端目标登记表创建稳定、无个人联系方式的清理任务。 */
export function createAlumniCleanupTask(input: {
  readonly sourceEventId: string;
  readonly tenantId: string;
  readonly consentId: string;
  readonly consentVersion: number;
  readonly consentPurpose: AlumniConsent['purpose'];
  readonly terminationReason: AlumniCleanupTerminationReason;
  readonly terminatedAt: string;
  readonly target: CareAlumniCleanupTarget;
}): AlumniCleanupTask {
  assertId(input.sourceEventId, 'sourceEventId');
  assertId(input.tenantId, 'tenantId');
  assertId(input.consentId, 'consentId');
  if (!Number.isInteger(input.consentVersion) || input.consentVersion < 2) {
    invalid('CARE_ALUMNI_CLEANUP_CONSENT_VERSION_INVALID');
  }
  const terminatedAt = iso(input.terminatedAt, 'CARE_ALUMNI_CLEANUP_TERMINATED_AT_INVALID');
  const id = cleanupTaskId({
    tenantId: input.tenantId,
    consentId: input.consentId,
    consentVersion: input.consentVersion,
    consentPurpose: input.consentPurpose,
    targetCode: input.target.targetCode,
    policyVersion: input.target.policyVersion,
  });
  const controlDigest = cleanupControlDigest({
    tenantId: input.tenantId,
    consentId: input.consentId,
    consentVersion: input.consentVersion,
    consentPurpose: input.consentPurpose,
    terminationReason: input.terminationReason,
    terminatedAt,
    targetCode: input.target.targetCode,
    policyVersion: input.target.policyVersion,
  });
  return Object.freeze({
    id,
    tenantId: input.tenantId,
    consentId: input.consentId,
    consentVersion: input.consentVersion,
    consentPurpose: input.consentPurpose,
    terminationReason: input.terminationReason,
    terminatedAt,
    sourceEventId: input.sourceEventId,
    targetCode: input.target.targetCode,
    policyVersion: input.target.policyVersion,
    controlDigest,
    maxAttempts: input.target.maxAttempts,
    proofRetentionDays: input.target.proofRetentionDays,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: terminatedAt,
    lockedAt: null,
    lockedBy: null,
    proofDigest: null,
    proofAction: null,
    proofStorage: null,
    proofCompletedAt: null,
    proofRetentionUntil: null,
    proofKeyId: null,
    lastErrorCode: null,
    version: 1,
    createdAt: terminatedAt,
    updatedAt: terminatedAt,
  });
}

/** 绑定下游不可变证明；本地只保存摘要与受控元数据，不复制证明正文。 */
export function completeAlumniCleanupTask(
  task: AlumniCleanupTask,
  proof: AlumniCleanupProof,
  workerId: string,
  now: Date,
): AlumniCleanupTask {
  assertDispatchClaim(task, workerId);
  if (!/^[A-Za-z0-9_-]{43}$/.test(proof.proofDigest)) {
    invalid('CARE_ALUMNI_CLEANUP_PROOF_DIGEST_INVALID');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(proof.keyId)) {
    invalid('CARE_ALUMNI_CLEANUP_PROOF_KEY_INVALID');
  }
  const completedAt = iso(
    proof.completedAt,
    'CARE_ALUMNI_CLEANUP_PROOF_COMPLETED_AT_INVALID',
  );
  const retentionUntil = iso(
    proof.retentionUntil,
    'CARE_ALUMNI_CLEANUP_PROOF_RETENTION_INVALID',
  );
  const minimumRetention = Date.parse(completedAt) +
    task.proofRetentionDays * 24 * 60 * 60 * 1_000;
  if (
    Date.parse(completedAt) > now.getTime() + 5 * 60_000 ||
    Date.parse(retentionUntil) < minimumRetention
  ) invalid('CARE_ALUMNI_CLEANUP_PROOF_RETENTION_INVALID');
  return Object.freeze({
    ...task,
    status: 'completed',
    proofDigest: proof.proofDigest,
    proofAction: proof.action,
    proofStorage: proof.storage,
    proofCompletedAt: completedAt,
    proofRetentionUntil: retentionUntil,
    proofKeyId: proof.keyId,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    version: task.version + 1,
    updatedAt: now.toISOString(),
  });
}

/** 外部失败后按确定性退避释放锁；达到目标策略上限进入 dead。 */
export function failAlumniCleanupTask(
  task: AlumniCleanupTask,
  workerId: string,
  errorCode: string,
  now: Date,
): AlumniCleanupTask {
  assertDispatchClaim(task, workerId);
  if (!/^[A-Z][A-Z0-9_]{7,63}$/.test(errorCode)) {
    invalid('CARE_ALUMNI_CLEANUP_ERROR_CODE_INVALID');
  }
  const attempts = task.attempts + 1;
  const dead = attempts >= task.maxAttempts;
  const delay = Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(attempts - 1, 10)));
  return Object.freeze({
    ...task,
    status: dead ? 'dead' : 'pending',
    attempts,
    nextAttemptAt: dead
      ? now.toISOString()
      : new Date(now.getTime() + delay).toISOString(),
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: errorCode,
    version: task.version + 1,
    updatedAt: now.toISOString(),
  });
}

/** 审批后的受控重放只允许 dead 任务，且不改变原对象、政策或控制摘要。 */
export function replayAlumniCleanupTask(
  task: AlumniCleanupTask,
  expectedVersion: number,
  reasonCode: string,
  now: Date,
): AlumniCleanupTask {
  if (task.version !== expectedVersion) invalid('CARE_ALUMNI_CLEANUP_VERSION_CONFLICT');
  if (task.status !== 'dead') invalid('CARE_ALUMNI_CLEANUP_REPLAY_STATE_INVALID');
  if (!/^[A-Z][A-Z0-9_]{7,63}$/.test(reasonCode)) {
    invalid('CARE_ALUMNI_CLEANUP_REPLAY_REASON_INVALID');
  }
  return Object.freeze({
    ...task,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now.toISOString(),
    lastErrorCode: null,
    version: task.version + 1,
    updatedAt: now.toISOString(),
  });
}

export function cleanupTaskId(input: {
  readonly tenantId: string;
  readonly consentId: string;
  readonly consentVersion: number;
  readonly consentPurpose: AlumniConsent['purpose'];
  readonly targetCode: string;
  readonly policyVersion: string;
}): string {
  return digest([
    'care-alumni-cleanup-task-v1',
    input.tenantId,
    input.consentId,
    input.consentVersion,
    input.consentPurpose,
    input.targetCode,
    input.policyVersion,
  ]);
}

export function cleanupControlDigest(input: {
  readonly tenantId: string;
  readonly consentId: string;
  readonly consentVersion: number;
  readonly consentPurpose: AlumniConsent['purpose'];
  readonly terminationReason: AlumniCleanupTerminationReason;
  readonly terminatedAt: string;
  readonly targetCode: string;
  readonly policyVersion: string;
}): string {
  return digest([
    'care-alumni-cleanup-control-v1',
    input.tenantId,
    input.consentId,
    input.consentVersion,
    input.consentPurpose,
    input.terminationReason,
    input.terminatedAt,
    input.targetCode,
    input.policyVersion,
    'delete_or_anonymize_business_contact',
    'deny_future_processing',
    'preserve_consent_attestation_and_audit',
  ]);
}

export function cleanupIdempotencyKey(task: AlumniCleanupTask): string {
  return `care-alumni-cleanup:${digest([
    task.tenantId,
    task.consentId,
    task.consentVersion,
    task.consentPurpose,
    task.targetCode,
    task.policyVersion,
  ])}`;
}

function assertDispatchClaim(task: AlumniCleanupTask, workerId: string): void {
  assertId(workerId, 'workerId');
  if (task.status !== 'dispatching' || task.lockedBy !== workerId) {
    invalid('CARE_ALUMNI_CLEANUP_CLAIM_LOST');
  }
  if (
    task.proofDigest !== null ||
    task.proofAction !== null ||
    task.proofStorage !== null ||
    task.proofCompletedAt !== null ||
    task.proofRetentionUntil !== null ||
    task.proofKeyId !== null
  ) invalid('CARE_ALUMNI_CLEANUP_PROOF_IMMUTABLE');
}

function digest(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url');
}

function iso(value: string, code: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) invalid(code);
  return value;
}

function assertId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    invalid(`CARE_ALUMNI_CLEANUP_${field.toUpperCase()}_INVALID`);
  }
}

function invalid(code: string): never {
  throw new Error(code);
}
