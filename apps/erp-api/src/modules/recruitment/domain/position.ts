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
