import { RecruitmentDomainError } from './recruitment.errors.js';
import {
  assertRecruitmentId,
  assertRecruitmentLabel,
  assertRecruitmentTenant,
  assertRecruitmentVersion,
  deepFreezeRecruitment,
  toRecruitmentIso,
} from './recruitment.validation.js';

export type RecruitmentPositionStatus = 'draft' | 'open' | 'paused' | 'closed';

export interface RecruitmentPosition {
  readonly id: string;
  readonly tenantId: string;
  readonly requisitionId: string;
  readonly title: string;
  readonly departmentId: string;
  readonly jobLevelId: string;
  readonly location: string;
  readonly headcount: number;
  readonly status: RecruitmentPositionStatus;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createRecruitmentPosition(
  input: Omit<RecruitmentPosition, 'status' | 'version' | 'publishedAt' | 'closedAt' | 'createdAt' | 'updatedAt'>,
  now: Date,
): RecruitmentPosition {
  for (const [field, value] of Object.entries({
    id: input.id,
    tenantId: input.tenantId,
    requisitionId: input.requisitionId,
    departmentId: input.departmentId,
    jobLevelId: input.jobLevelId,
  })) assertRecruitmentId(value, field);
  assertRecruitmentLabel(input.title, 'title', 128);
  assertRecruitmentLabel(input.location, 'location', 128);
  if (!Number.isSafeInteger(input.headcount) || input.headcount < 1 || input.headcount > 10_000) {
    throw new RecruitmentDomainError('RECRUITMENT_HEADCOUNT_INVALID', '招聘人数必须为 1..10000 的整数');
  }
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    ...input,
    title: input.title.trim(),
    location: input.location.trim(),
    status: 'draft' as const,
    version: 1,
    publishedAt: null,
    closedAt: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

/** 数据迁移专用：恢复职位生命周期事实，不重放发布、暂停或关闭副作用。 */
export function restoreRecruitmentPositionFromMigration(
  input: RecruitmentPosition,
): RecruitmentPosition {
  for (const [field, value] of Object.entries({
    id: input.id,
    tenantId: input.tenantId,
    requisitionId: input.requisitionId,
    departmentId: input.departmentId,
    jobLevelId: input.jobLevelId,
  })) assertRecruitmentId(value, field);
  assertRecruitmentLabel(input.title, 'title', 128);
  assertRecruitmentLabel(input.location, 'location', 128);
  assertRecruitmentVersion(input.version);
  if (!Number.isSafeInteger(input.headcount) || input.headcount < 1 || input.headcount > 10_000) {
    throw new RecruitmentDomainError('RECRUITMENT_HEADCOUNT_INVALID', '招聘人数必须为 1..10000 的整数');
  }
  if (!['draft', 'open', 'paused', 'closed'].includes(input.status)) {
    throw new RecruitmentDomainError('RECRUITMENT_POSITION_STATUS_INVALID', '职位迁移状态无效');
  }
  const createdAt = migrationIso(input.createdAt);
  const updatedAt = migrationIso(input.updatedAt);
  const publishedAt = input.publishedAt === null ? null : migrationIso(input.publishedAt);
  const closedAt = input.closedAt === null ? null : migrationIso(input.closedAt);
  const stateValid = input.status === 'draft'
    ? input.version === 1 && publishedAt === null && closedAt === null
    : input.status === 'open'
      ? input.version >= 2 && publishedAt !== null && closedAt === null
      : input.status === 'paused'
        ? input.version >= 3 && publishedAt !== null && closedAt === null
        : input.version >= 2 && closedAt !== null;
  if (!stateValid || updatedAt < createdAt ||
    (publishedAt !== null && (publishedAt < createdAt || publishedAt > updatedAt)) ||
    (closedAt !== null && (closedAt < createdAt || closedAt > updatedAt ||
      (publishedAt !== null && closedAt < publishedAt)))) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_POSITION_MIGRATION_STATE_INVALID',
      '职位迁移状态、版本或生命周期时间不一致',
    );
  }
  return deepFreezeRecruitment({
    ...input,
    title: input.title.trim(),
    location: input.location.trim(),
    publishedAt,
    closedAt,
    createdAt,
    updatedAt,
  });
}

export function transitionRecruitmentPosition(
  position: RecruitmentPosition,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly targetStatus: Exclude<RecruitmentPositionStatus, 'draft'>;
    readonly requisitionApproved: boolean;
  },
  now: Date,
): RecruitmentPosition {
  assertRecruitmentTenant(position.tenantId, input.tenantId);
  assertRecruitmentVersion(input.expectedVersion);
  if (position.version !== input.expectedVersion) {
    throw new RecruitmentDomainError('RECRUITMENT_VERSION_CONFLICT', '职位版本冲突');
  }
  const allowed: Readonly<Record<RecruitmentPositionStatus, readonly RecruitmentPositionStatus[]>> = {
    draft: ['open', 'closed'],
    open: ['paused', 'closed'],
    paused: ['open', 'closed'],
    closed: [],
  };
  if (!allowed[position.status].includes(input.targetStatus)) {
    throw new RecruitmentDomainError('RECRUITMENT_POSITION_TRANSITION_INVALID', '职位状态迁移无效');
  }
  if (input.targetStatus === 'open' && !input.requisitionApproved) {
    throw new RecruitmentDomainError('RECRUITMENT_REQUISITION_NOT_APPROVED', 'HC 审批通过前不能开放职位');
  }
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    ...position,
    status: input.targetStatus,
    version: position.version + 1,
    publishedAt: input.targetStatus === 'open' && position.publishedAt === null
      ? occurredAt
      : position.publishedAt,
    closedAt: input.targetStatus === 'closed' ? occurredAt : null,
    updatedAt: occurredAt,
  });
}

function migrationIso(value: string): string {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_POSITION_MIGRATION_TIME_INVALID',
      '职位迁移时间必须为规范 UTC ISO 时间',
    );
  }
  return value;
}
