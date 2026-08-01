import { isDeepStrictEqual } from 'node:util';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OnboardingInstance, OnboardingTaskEvidence } from '../domain/index.js';
import {
  OnboardingInstanceRecord,
  type OnboardingInstanceDocument,
  OnboardingTaskEvidenceRecord,
  type OnboardingTaskEvidenceDocument,
} from './onboarding.schemas.js';

const MAX_CANDIDATE_INSTANCES = 100;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const safeIdSchema = z.string().regex(SAFE_ID_PATTERN);
const validDateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));
const businessDateSchema = z.string().regex(DATE_PATTERN).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const canonicalInstantSchema = z.string().regex(INSTANT_PATTERN).refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
});
const nullableIdSchema = safeIdSchema.nullable();
const statusSchema = z.enum([
  'in_progress',
  'ready',
  'provisioning',
  'completed',
  'cancelled',
]);
const taskCodeSchema = z.enum([
  'contract_archived',
  'identity_verified',
  'materials_verified',
  'org_assignment_verified',
  'mandatory_training_completed',
]);

const instanceScalarSchemas = {
  id: safeIdSchema,
  tenantId: safeIdSchema,
  offerId: safeIdSchema,
  applicationId: safeIdSchema,
  candidateId: safeIdSchema,
  acceptanceEvidenceId: safeIdSchema,
  signedEvidenceId: nullableIdSchema,
  identityEvidenceId: nullableIdSchema,
  materialsEvidenceId: nullableIdSchema,
  orgAssignmentEvidenceId: nullableIdSchema,
  trainingEvidenceId: nullableIdSchema,
  departmentId: safeIdSchema,
  jobLevelId: safeIdSchema,
  orgPositionId: nullableIdSchema,
  proposedStartDate: businessDateSchema,
  status: statusSchema,
  completionEvidenceId: nullableIdSchema,
  employmentId: nullableIdSchema,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};

const domainInstanceSchema = z.object({
  ...instanceScalarSchemas,
  createdAt: canonicalInstantSchema,
  updatedAt: canonicalInstantSchema,
}).strict().superRefine((value, context) => {
  validateInstanceState(value, (message) => {
    context.addIssue({ code: 'custom', message });
  });
});

const recordInstanceSchema = z.object({
  ...instanceScalarSchemas,
  createdAt: validDateSchema,
  updatedAt: validDateSchema,
}).strict().superRefine((value, context) => {
  validateInstanceState(value, (message) => {
    context.addIssue({ code: 'custom', message });
  });
});

const taskEvidenceDomainSchema = z.object({
  id: safeIdSchema,
  tenantId: safeIdSchema,
  onboardingInstanceId: safeIdSchema,
  taskCode: taskCodeSchema,
  evidenceId: safeIdSchema,
  actorId: safeIdSchema,
  occurredAt: canonicalInstantSchema,
}).strict();

const taskEvidenceRecordSchema = z.object({
  id: safeIdSchema,
  tenantId: safeIdSchema,
  onboardingInstanceId: safeIdSchema,
  taskCode: taskCodeSchema,
  evidenceId: safeIdSchema,
  actorId: safeIdSchema,
  occurredAt: validDateSchema,
}).strict();

const INSTANCE_PROJECTION = Object.freeze({
  _id: 0,
  id: 1,
  tenantId: 1,
  offerId: 1,
  applicationId: 1,
  candidateId: 1,
  acceptanceEvidenceId: 1,
  signedEvidenceId: 1,
  identityEvidenceId: 1,
  materialsEvidenceId: 1,
  orgAssignmentEvidenceId: 1,
  trainingEvidenceId: 1,
  departmentId: 1,
  jobLevelId: 1,
  orgPositionId: 1,
  proposedStartDate: 1,
  status: 1,
  completionEvidenceId: 1,
  employmentId: 1,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
});

type DomainInstance = z.infer<typeof domainInstanceSchema>;
type RecordInstance = z.infer<typeof recordInstanceSchema>;
type DomainTaskEvidence = z.infer<typeof taskEvidenceDomainSchema>;

export class OnboardingWriteConflictError extends Error {
  constructor() {
    super('入职实例版本冲突');
    this.name = 'OnboardingWriteConflictError';
  }
}

/** 入职聚合仓储；所有读取与事务写入均在运行时闭合租户、引用和状态证据。 */
@Injectable()
export class OnboardingInstanceRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OnboardingInstanceRecord.name)
    private readonly records: Model<OnboardingInstanceDocument>,
  ) {}

  async findById(id: string, session?: ClientSession): Promise<OnboardingInstance | null> {
    const tenantId = this.tenantId();
    const canonicalId = requireSafeId(id);
    return this.findOne({ tenantId, id: canonicalId }, { tenantId, id: canonicalId }, session);
  }

  async findByOfferId(
    offerId: string,
    session?: ClientSession,
  ): Promise<OnboardingInstance | null> {
    const tenantId = this.tenantId();
    const canonicalOfferId = requireSafeId(offerId);
    return this.findOne(
      { tenantId, offerId: canonicalOfferId },
      { tenantId, offerId: canonicalOfferId },
      session,
    );
  }

  async findByCandidateId(candidateId: string): Promise<readonly OnboardingInstance[]> {
    const tenantId = this.tenantId();
    const canonicalCandidateId = requireSafeId(candidateId);
    const values = await this.records
      .find({ tenantId, candidateId: canonicalCandidateId })
      .select(INSTANCE_PROJECTION)
      .sort({ createdAt: -1, id: 1 })
      .limit(MAX_CANDIDATE_INSTANCES)
      .lean()
      .exec();
    if (!Array.isArray(values) || values.length > MAX_CANDIDATE_INSTANCES) {
      throw repositoryError('ONBOARDING_REPOSITORY_RECORD_INVALID');
    }
    const records = values.map((value) => {
      const record = parseRecord(value);
      assertRecordBinding(record, { tenantId, candidateId: canonicalCandidateId });
      return record;
    });
    assertStableCandidateOrder(records);
    return Object.freeze(records.map((record) => toDomain(record)));
  }

  async insert(instance: OnboardingInstance, sessionValue: ClientSession): Promise<void> {
    const tenantId = this.tenantId();
    const canonical = parseDomainInstance(instance);
    if (canonical.tenantId !== tenantId) {
      throw repositoryError('ONBOARDING_REPOSITORY_TENANT_MISMATCH');
    }
    const session = requireActiveTransaction(sessionValue);
    const row = toRecord(canonical);
    const created = await this.records.create([row], { session });
    if (!Array.isArray(created) || created.length !== 1) {
      throw repositoryError('ONBOARDING_REPOSITORY_WRITE_UNAVAILABLE');
    }
    const stored = parseWrittenRecord(instanceSnapshot(created[0]));
    if (!isDeepStrictEqual(toDomain(stored), canonical)) {
      throw repositoryError('ONBOARDING_REPOSITORY_WRITE_UNAVAILABLE');
    }
  }

  async replace(
    instance: OnboardingInstance,
    expectedVersionValue: number,
    sessionValue: ClientSession,
  ): Promise<void> {
    const tenantId = this.tenantId();
    const canonical = parseDomainInstance(instance);
    const expectedVersion = requireExpectedVersion(expectedVersionValue);
    if (canonical.tenantId !== tenantId) {
      throw repositoryError('ONBOARDING_REPOSITORY_TENANT_MISMATCH');
    }
    if (canonical.version !== expectedVersion + 1) {
      throw repositoryError('ONBOARDING_REPOSITORY_INPUT_INVALID');
    }
    const session = requireActiveTransaction(sessionValue);
    const createdAt = new Date(canonical.createdAt);
    const updatedAt = new Date(canonical.updatedAt);
    const result = await this.records.updateOne(
      {
        tenantId,
        id: canonical.id,
        version: expectedVersion,
        offerId: canonical.offerId,
        applicationId: canonical.applicationId,
        candidateId: canonical.candidateId,
        acceptanceEvidenceId: canonical.acceptanceEvidenceId,
        departmentId: canonical.departmentId,
        jobLevelId: canonical.jobLevelId,
        proposedStartDate: canonical.proposedStartDate,
        createdAt,
      },
      { $set: {
        signedEvidenceId: canonical.signedEvidenceId,
        identityEvidenceId: canonical.identityEvidenceId,
        materialsEvidenceId: canonical.materialsEvidenceId,
        orgAssignmentEvidenceId: canonical.orgAssignmentEvidenceId,
        trainingEvidenceId: canonical.trainingEvidenceId,
        orgPositionId: canonical.orgPositionId,
        status: canonical.status,
        completionEvidenceId: canonical.completionEvidenceId,
        employmentId: canonical.employmentId,
        version: canonical.version,
        updatedAt,
      } },
      { session, timestamps: false, runValidators: true },
    );
    assertUpdateResult(result);
  }

  private async findOne(
    filter: Readonly<Record<string, string>>,
    binding: Readonly<Partial<Pick<RecordInstance, 'tenantId' | 'id' | 'offerId'>>>,
    session?: ClientSession,
  ): Promise<OnboardingInstance | null> {
    const query = this.records.findOne(filter).select(INSTANCE_PROJECTION);
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    if (value === null) return null;
    const record = parseRecord(value);
    assertRecordBinding(record, binding);
    return toDomain(record);
  }

  private tenantId(): string {
    let trusted: unknown;
    try {
      trusted = this.context.getTenantRequired();
    } catch {
      throw repositoryError('ONBOARDING_REPOSITORY_CONTEXT_INVALID');
    }
    const parsed = z.object({ tenantId: safeIdSchema }).passthrough().safeParse(trusted);
    if (!parsed.success) throw repositoryError('ONBOARDING_REPOSITORY_CONTEXT_INVALID');
    return parsed.data.tenantId;
  }
}

/** 入职任务证明只允许在入职聚合事务内追加，禁止自报租户或非规范证明。 */
@Injectable()
export class OnboardingTaskEvidenceRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OnboardingTaskEvidenceRecord.name)
    private readonly records: Model<OnboardingTaskEvidenceDocument>,
  ) {}

  async append(evidence: OnboardingTaskEvidence, sessionValue: ClientSession): Promise<void> {
    const tenantId = this.tenantId();
    const canonical = parseTaskEvidence(evidence);
    if (canonical.tenantId !== tenantId) {
      throw repositoryError('ONBOARDING_EVIDENCE_TENANT_MISMATCH');
    }
    const session = requireActiveTransaction(sessionValue);
    const row = {
      ...canonical,
      occurredAt: new Date(canonical.occurredAt),
    };
    const created = await this.records.create([row], { session });
    if (!Array.isArray(created) || created.length !== 1) {
      throw repositoryError('ONBOARDING_EVIDENCE_WRITE_UNAVAILABLE');
    }
    const stored = parseWrittenTaskEvidence(taskEvidenceSnapshot(created[0]));
    if (!isDeepStrictEqual(toTaskEvidence(stored), canonical)) {
      throw repositoryError('ONBOARDING_EVIDENCE_WRITE_UNAVAILABLE');
    }
  }

  private tenantId(): string {
    let trusted: unknown;
    try {
      trusted = this.context.getTenantRequired();
    } catch {
      throw repositoryError('ONBOARDING_EVIDENCE_CONTEXT_INVALID');
    }
    const parsed = z.object({ tenantId: safeIdSchema }).passthrough().safeParse(trusted);
    if (!parsed.success) throw repositoryError('ONBOARDING_EVIDENCE_CONTEXT_INVALID');
    return parsed.data.tenantId;
  }
}

function validateInstanceState(
  value: {
    readonly signedEvidenceId: string | null;
    readonly identityEvidenceId: string | null;
    readonly materialsEvidenceId: string | null;
    readonly orgAssignmentEvidenceId: string | null;
    readonly trainingEvidenceId: string | null;
    readonly orgPositionId: string | null;
    readonly completionEvidenceId: string | null;
    readonly employmentId: string | null;
    readonly status: z.infer<typeof statusSchema>;
    readonly version: number;
    readonly createdAt: string | Date;
    readonly updatedAt: string | Date;
  },
  issue: (message: string) => void,
): void {
  const evidence = [
    value.signedEvidenceId,
    value.identityEvidenceId,
    value.materialsEvidenceId,
    value.orgAssignmentEvidenceId,
    value.trainingEvidenceId,
  ];
  const completedTaskCount = evidence.filter((item) => item !== null).length;
  const allTasksCompleted = completedTaskCount === evidence.length;
  if ((value.orgAssignmentEvidenceId === null) !== (value.orgPositionId === null)) {
    issue('organization_evidence_invalid');
  }
  if (new Date(value.createdAt).getTime() > new Date(value.updatedAt).getTime()) {
    issue('timestamp_order_invalid');
  }

  if (value.status === 'in_progress') {
    if (
      allTasksCompleted ||
      value.completionEvidenceId !== null ||
      value.employmentId !== null ||
      (value.version !== completedTaskCount && value.version !== completedTaskCount + 1)
    ) issue('in_progress_state_invalid');
    return;
  }
  if (value.status === 'ready') {
    if (
      !allTasksCompleted ||
      value.completionEvidenceId !== null ||
      value.employmentId !== null ||
      (value.version !== completedTaskCount && value.version !== completedTaskCount + 1)
    ) issue('ready_state_invalid');
    return;
  }
  if (value.status === 'provisioning') {
    if (
      !allTasksCompleted ||
      value.completionEvidenceId === null ||
      value.employmentId !== null ||
      (
        value.version !== completedTaskCount + 1 &&
        value.version !== completedTaskCount + 2
      )
    ) issue('provisioning_state_invalid');
    return;
  }
  if (value.status === 'completed') {
    if (
      !allTasksCompleted ||
      value.completionEvidenceId === null ||
      value.employmentId === null ||
      (
        value.version !== completedTaskCount + 2 &&
        value.version !== completedTaskCount + 3
      )
    ) issue('completed_state_invalid');
    return;
  }
  if (value.completionEvidenceId !== null || value.employmentId !== null) {
    issue('cancelled_state_invalid');
  }
}

function parseDomainInstance(value: unknown): Readonly<DomainInstance> {
  const parsed = domainInstanceSchema.safeParse(value);
  if (!parsed.success) throw repositoryError('ONBOARDING_REPOSITORY_INPUT_INVALID');
  return Object.freeze(parsed.data);
}

function parseRecord(value: unknown): RecordInstance {
  const parsed = recordInstanceSchema.safeParse(value);
  if (!parsed.success) throw repositoryError('ONBOARDING_REPOSITORY_RECORD_INVALID');
  return parsed.data;
}

function parseWrittenRecord(value: unknown): RecordInstance {
  try {
    return parseRecord(value);
  } catch {
    throw repositoryError('ONBOARDING_REPOSITORY_WRITE_UNAVAILABLE');
  }
}

function parseTaskEvidence(value: unknown): Readonly<DomainTaskEvidence> {
  const parsed = taskEvidenceDomainSchema.safeParse(value);
  if (!parsed.success) throw repositoryError('ONBOARDING_EVIDENCE_INPUT_INVALID');
  return Object.freeze(parsed.data);
}

function parseWrittenTaskEvidence(value: unknown): z.infer<typeof taskEvidenceRecordSchema> {
  const parsed = taskEvidenceRecordSchema.safeParse(value);
  if (!parsed.success) throw repositoryError('ONBOARDING_EVIDENCE_WRITE_UNAVAILABLE');
  return parsed.data;
}

function toRecord(value: DomainInstance): Record<string, unknown> {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

function toDomain(value: RecordInstance): OnboardingInstance {
  return Object.freeze({
    id: value.id,
    tenantId: value.tenantId,
    offerId: value.offerId,
    applicationId: value.applicationId,
    candidateId: value.candidateId,
    acceptanceEvidenceId: value.acceptanceEvidenceId,
    signedEvidenceId: value.signedEvidenceId,
    identityEvidenceId: value.identityEvidenceId,
    materialsEvidenceId: value.materialsEvidenceId,
    orgAssignmentEvidenceId: value.orgAssignmentEvidenceId,
    trainingEvidenceId: value.trainingEvidenceId,
    departmentId: value.departmentId,
    jobLevelId: value.jobLevelId,
    orgPositionId: value.orgPositionId,
    proposedStartDate: value.proposedStartDate,
    status: value.status,
    completionEvidenceId: value.completionEvidenceId,
    employmentId: value.employmentId,
    version: value.version,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  });
}

function toTaskEvidence(
  value: z.infer<typeof taskEvidenceRecordSchema>,
): OnboardingTaskEvidence {
  return Object.freeze({
    id: value.id,
    tenantId: value.tenantId,
    onboardingInstanceId: value.onboardingInstanceId,
    taskCode: value.taskCode,
    evidenceId: value.evidenceId,
    actorId: value.actorId,
    occurredAt: value.occurredAt.toISOString(),
  });
}

function instanceSnapshot(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Readonly<Record<string, unknown>>;
  return {
    id: record.id,
    tenantId: record.tenantId,
    offerId: record.offerId,
    applicationId: record.applicationId,
    candidateId: record.candidateId,
    acceptanceEvidenceId: record.acceptanceEvidenceId,
    signedEvidenceId: record.signedEvidenceId,
    identityEvidenceId: record.identityEvidenceId,
    materialsEvidenceId: record.materialsEvidenceId,
    orgAssignmentEvidenceId: record.orgAssignmentEvidenceId,
    trainingEvidenceId: record.trainingEvidenceId,
    departmentId: record.departmentId,
    jobLevelId: record.jobLevelId,
    orgPositionId: record.orgPositionId,
    proposedStartDate: record.proposedStartDate,
    status: record.status,
    completionEvidenceId: record.completionEvidenceId,
    employmentId: record.employmentId,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function taskEvidenceSnapshot(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Readonly<Record<string, unknown>>;
  return {
    id: record.id,
    tenantId: record.tenantId,
    onboardingInstanceId: record.onboardingInstanceId,
    taskCode: record.taskCode,
    evidenceId: record.evidenceId,
    actorId: record.actorId,
    occurredAt: record.occurredAt,
  };
}

function assertRecordBinding(
  value: RecordInstance,
  binding: Readonly<Partial<Pick<RecordInstance, 'tenantId' | 'id' | 'offerId' | 'candidateId'>>>,
): void {
  if (
    (binding.tenantId !== undefined && value.tenantId !== binding.tenantId) ||
    (binding.id !== undefined && value.id !== binding.id) ||
    (binding.offerId !== undefined && value.offerId !== binding.offerId) ||
    (binding.candidateId !== undefined && value.candidateId !== binding.candidateId)
  ) throw repositoryError('ONBOARDING_REPOSITORY_RECORD_INVALID');
}

function assertStableCandidateOrder(values: readonly RecordInstance[]): void {
  const ids = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index] as RecordInstance;
    if (ids.has(current.id)) throw repositoryError('ONBOARDING_REPOSITORY_RECORD_INVALID');
    ids.add(current.id);
    const previous = values[index - 1];
    if (previous === undefined) continue;
    const previousTime = previous.createdAt.getTime();
    const currentTime = current.createdAt.getTime();
    if (
      previousTime < currentTime ||
      (previousTime === currentTime && previous.id > current.id)
    ) throw repositoryError('ONBOARDING_REPOSITORY_RECORD_INVALID');
  }
}

function requireSafeId(value: unknown): string {
  const parsed = safeIdSchema.safeParse(value);
  if (!parsed.success) throw repositoryError('ONBOARDING_REPOSITORY_INPUT_INVALID');
  return parsed.data;
}

function requireExpectedVersion(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) >= Number.MAX_SAFE_INTEGER
  ) throw repositoryError('ONBOARDING_REPOSITORY_INPUT_INVALID');
  return value as number;
}

function requireActiveTransaction(value: unknown): ClientSession {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { readonly inTransaction?: unknown }).inTransaction !== 'function' ||
      !(value as ClientSession).inTransaction()
    ) throw repositoryError('ONBOARDING_REPOSITORY_TRANSACTION_REQUIRED');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'ONBOARDING_REPOSITORY_TRANSACTION_REQUIRED'
    ) throw error;
    throw repositoryError('ONBOARDING_REPOSITORY_TRANSACTION_REQUIRED');
  }
  return value as ClientSession;
}

function assertUpdateResult(value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { readonly acknowledged?: unknown }).acknowledged !== true
  ) throw repositoryError('ONBOARDING_REPOSITORY_WRITE_UNAVAILABLE');
  const matchedCount = (value as { readonly matchedCount?: unknown }).matchedCount;
  const modifiedCount = (value as { readonly modifiedCount?: unknown }).modifiedCount;
  if (matchedCount === 0 && modifiedCount === 0) throw new OnboardingWriteConflictError();
  if (matchedCount !== 1 || modifiedCount !== 1) {
    throw repositoryError('ONBOARDING_REPOSITORY_WRITE_UNAVAILABLE');
  }
}

function repositoryError(code: string): Error {
  return new Error(code);
}
