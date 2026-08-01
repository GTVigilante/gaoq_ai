export type OnboardingStatus =
  | 'in_progress'
  | 'ready'
  | 'provisioning'
  | 'completed'
  | 'cancelled';

export type OnboardingTaskCode =
  | 'contract_archived'
  | 'identity_verified'
  | 'materials_verified'
  | 'org_assignment_verified'
  | 'mandatory_training_completed';

export class OnboardingDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OnboardingDomainError';
  }
}

/** 入职聚合只保存权威证据引用，不复制候选人、合同、材料或培训正文。 */
export interface OnboardingInstance {
  readonly id: string;
  readonly tenantId: string;
  readonly offerId: string;
  readonly applicationId: string;
  readonly candidateId: string;
  readonly acceptanceEvidenceId: string;
  readonly signedEvidenceId: string | null;
  readonly identityEvidenceId: string | null;
  readonly materialsEvidenceId: string | null;
  readonly orgAssignmentEvidenceId: string | null;
  readonly trainingEvidenceId: string | null;
  readonly departmentId: string;
  readonly jobLevelId: string;
  readonly orgPositionId: string | null;
  readonly proposedStartDate: string;
  readonly status: OnboardingStatus;
  readonly completionEvidenceId: string | null;
  readonly employmentId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OnboardingTaskEvidence {
  readonly id: string;
  readonly tenantId: string;
  readonly onboardingInstanceId: string;
  readonly taskCode: OnboardingTaskCode;
  readonly evidenceId: string;
  readonly actorId: string;
  readonly occurredAt: string;
}

export function createOnboardingInstance(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly offerId: string;
    readonly applicationId: string;
    readonly candidateId: string;
    readonly acceptanceEvidenceId: string;
    readonly signedEvidenceId: string | null;
    readonly departmentId: string;
    readonly jobLevelId: string;
    readonly proposedStartDate: string;
  },
  now: Date,
): OnboardingInstance {
  for (const [field, value] of Object.entries({
    id: input.id, tenantId: input.tenantId, offerId: input.offerId,
    applicationId: input.applicationId, candidateId: input.candidateId,
    acceptanceEvidenceId: input.acceptanceEvidenceId,
    departmentId: input.departmentId, jobLevelId: input.jobLevelId,
  })) assertId(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.proposedStartDate)) {
    throw new OnboardingDomainError('ONBOARDING_START_DATE_INVALID', '拟入职日期格式非法');
  }
  const proposedStartDate = new Date(`${input.proposedStartDate}T00:00:00.000Z`);
  if (
    Number.isNaN(proposedStartDate.getTime()) ||
    proposedStartDate.toISOString().slice(0, 10) !== input.proposedStartDate
  ) throw new OnboardingDomainError('ONBOARDING_START_DATE_INVALID', '拟入职日期不是合法日期');
  if (input.signedEvidenceId !== null) assertId(input.signedEvidenceId, 'signedEvidenceId');
  const occurredAt = toIso(now);
  return Object.freeze({
    ...input,
    identityEvidenceId: null,
    materialsEvidenceId: null,
    orgAssignmentEvidenceId: null,
    trainingEvidenceId: null,
    orgPositionId: null,
    status: 'in_progress',
    completionEvidenceId: null,
    employmentId: null,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 追加单个任务证据；完成后的证据不可替换，只能人工进入纠错流程。 */
export function recordOnboardingTaskEvidence(
  instance: OnboardingInstance,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly taskCode: OnboardingTaskCode;
    readonly evidenceId: string;
    readonly evidenceRecordId: string;
    readonly actorId: string;
    readonly orgPositionId?: string;
  },
  now: Date,
): { readonly instance: OnboardingInstance; readonly evidence: OnboardingTaskEvidence | null } {
  assertCommand(instance, input.tenantId, input.expectedVersion);
  if (instance.status === 'provisioning' || instance.status === 'completed' || instance.status === 'cancelled') {
    throw new OnboardingDomainError('ONBOARDING_TASKS_LOCKED', '当前入职状态禁止变更任务证据');
  }
  assertId(input.evidenceId, 'evidenceId');
  assertId(input.evidenceRecordId, 'evidenceRecordId');
  assertId(input.actorId, 'actorId');
  if (input.taskCode === 'org_assignment_verified') {
    assertId(input.orgPositionId, 'orgPositionId');
  } else if (input.orgPositionId !== undefined) {
    throw new OnboardingDomainError('ONBOARDING_ORG_POSITION_UNEXPECTED', '非组织分配任务不能指定岗位');
  }
  const currentEvidence = evidenceFor(instance, input.taskCode);
  if (currentEvidence !== null) {
    if (
      currentEvidence === input.evidenceId &&
      (input.taskCode !== 'org_assignment_verified' || instance.orgPositionId === input.orgPositionId)
    ) return { instance, evidence: null };
    throw new OnboardingDomainError('ONBOARDING_TASK_EVIDENCE_IMMUTABLE', '任务证据已存在且不可替换');
  }
  const occurredAt = toIso(now);
  const next = withEvidence(instance, input.taskCode, input.evidenceId, input.orgPositionId);
  const updated: OnboardingInstance = Object.freeze({
    ...next,
    status: allTasksCompleted(next) ? 'ready' : 'in_progress',
    version: instance.version + 1,
    updatedAt: occurredAt,
  });
  return {
    instance: updated,
    evidence: Object.freeze({
      id: input.evidenceRecordId, tenantId: instance.tenantId,
      onboardingInstanceId: instance.id, taskCode: input.taskCode,
      evidenceId: input.evidenceId, actorId: input.actorId, occurredAt,
    }),
  };
}

export function beginOnboardingProvisioning(
  instance: OnboardingInstance,
  input: { readonly tenantId: string; readonly expectedVersion: number; readonly completionEvidenceId: string },
  now: Date,
): OnboardingInstance {
  assertCommand(instance, input.tenantId, input.expectedVersion);
  assertId(input.completionEvidenceId, 'completionEvidenceId');
  if (instance.status !== 'ready') {
    throw new OnboardingDomainError('ONBOARDING_NOT_READY', '入职任务尚未全部完成');
  }
  return Object.freeze({
    ...instance, status: 'provisioning', completionEvidenceId: input.completionEvidenceId,
    version: instance.version + 1, updatedAt: toIso(now),
  });
}

export function completeOnboardingProvisioning(
  instance: OnboardingInstance,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly completionEvidenceId: string;
    readonly employmentId: string;
  },
  now: Date,
): OnboardingInstance {
  assertCommand(instance, input.tenantId, input.expectedVersion);
  assertId(input.employmentId, 'employmentId');
  if (
    instance.status !== 'provisioning' ||
    instance.completionEvidenceId !== input.completionEvidenceId
  ) throw new OnboardingDomainError(
    'ONBOARDING_PROVISIONING_EVIDENCE_INVALID',
    '入职建档状态或完成证据不匹配',
  );
  return Object.freeze({
    ...instance, status: 'completed', employmentId: input.employmentId,
    version: instance.version + 1, updatedAt: toIso(now),
  });
}

export function onboardingTaskStatuses(
  instance: OnboardingInstance,
): Readonly<Record<OnboardingTaskCode, 'pending' | 'completed'>> {
  return Object.freeze({
    contract_archived: instance.signedEvidenceId === null ? 'pending' : 'completed',
    identity_verified: instance.identityEvidenceId === null ? 'pending' : 'completed',
    materials_verified: instance.materialsEvidenceId === null ? 'pending' : 'completed',
    org_assignment_verified: instance.orgAssignmentEvidenceId === null ? 'pending' : 'completed',
    mandatory_training_completed: instance.trainingEvidenceId === null ? 'pending' : 'completed',
  });
}

function withEvidence(
  instance: OnboardingInstance,
  code: OnboardingTaskCode,
  evidenceId: string,
  orgPositionId?: string,
): OnboardingInstance {
  if (code === 'contract_archived') return { ...instance, signedEvidenceId: evidenceId };
  if (code === 'identity_verified') return { ...instance, identityEvidenceId: evidenceId };
  if (code === 'materials_verified') return { ...instance, materialsEvidenceId: evidenceId };
  if (code === 'mandatory_training_completed') return { ...instance, trainingEvidenceId: evidenceId };
  return {
    ...instance,
    orgAssignmentEvidenceId: evidenceId,
    orgPositionId: orgPositionId ?? null,
  };
}

function evidenceFor(instance: OnboardingInstance, code: OnboardingTaskCode): string | null {
  if (code === 'contract_archived') return instance.signedEvidenceId;
  if (code === 'identity_verified') return instance.identityEvidenceId;
  if (code === 'materials_verified') return instance.materialsEvidenceId;
  if (code === 'mandatory_training_completed') return instance.trainingEvidenceId;
  return instance.orgAssignmentEvidenceId;
}

function allTasksCompleted(instance: OnboardingInstance): boolean {
  return Object.values(onboardingTaskStatuses(instance)).every((status) => status === 'completed');
}

function assertCommand(
  instance: OnboardingInstance,
  tenantId: string,
  expectedVersion: number,
): void {
  assertId(tenantId, 'tenantId');
  if (instance.tenantId !== tenantId) throw new OnboardingDomainError(
    'ONBOARDING_CROSS_TENANT', '禁止跨租户修改入职实例',
  );
  if (!Number.isSafeInteger(expectedVersion) || instance.version !== expectedVersion) {
    throw new OnboardingDomainError('ONBOARDING_VERSION_CONFLICT', '入职实例版本冲突');
  }
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new OnboardingDomainError('ONBOARDING_ID_INVALID', `${field} 非法`);
  }
}

function toIso(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new OnboardingDomainError(
    'ONBOARDING_TIME_INVALID', '时间非法',
  );
  return value.toISOString();
}
