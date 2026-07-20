import { OrgDomainError } from './org.errors.js';
import {
  assertEntityId,
  assertName,
  assertOrgCode,
  assertSameTenant,
  assertTenantId,
  toIso,
} from './org.validation.js';

/** 职级序列：专业序列 / 管理序列。 */
export type JobTrack = 'professional' | 'management';

/** 职级等级下限。 */
export const JOB_RANK_MIN = 1;
/** 职级等级上限。 */
export const JOB_RANK_MAX = 30;

/** 职级（纯值对象）；编码在租户内具有唯一语义，唯一性由持久层保证。 */
export interface JobLevel {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly track: JobTrack;
  /** 等级数值，同一序列内越大越高。 */
  readonly rank: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建职级入参。 */
export interface CreateJobLevelInput {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly track: JobTrack;
  readonly rank: number;
}

/** 更新职级补丁；tenantId 必须传入且与现有实体一致。 */
export interface UpdateJobLevelPatch {
  readonly tenantId: string;
  readonly code?: string;
  readonly name?: string;
  readonly track?: JobTrack;
  readonly rank?: number;
}

/** 断言职级序列合法。 */
function assertJobTrack(track: unknown, field = 'track'): asserts track is JobTrack {
  if (track !== 'professional' && track !== 'management') {
    throw new OrgDomainError('INVALID_TRACK', `${field} 仅允许 professional/management`);
  }
}

/** 断言职级等级为区间内的正整数。 */
function assertJobRank(rank: unknown, field = 'rank'): asserts rank is number {
  if (
    typeof rank !== 'number' ||
    !Number.isInteger(rank) ||
    rank < JOB_RANK_MIN ||
    rank > JOB_RANK_MAX
  ) {
    throw new OrgDomainError(
      'INVALID_RANK',
      `${field} 必须为 ${JOB_RANK_MIN}~${JOB_RANK_MAX} 的整数`,
    );
  }
}

/** 创建职级。校验：租户/标识非空、编码白名单、名称长度、序列枚举、等级区间。 */
export function createJobLevel(input: CreateJobLevelInput, now: Date): JobLevel {
  assertTenantId(input.tenantId);
  assertEntityId(input.id, 'id');
  assertOrgCode(input.code, 'code');
  assertName(input.name, 'name');
  assertJobTrack(input.track);
  assertJobRank(input.rank);

  const occurredAt = toIso(now);
  return {
    id: input.id,
    tenantId: input.tenantId,
    code: input.code,
    name: input.name,
    track: input.track,
    rank: input.rank,
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

/** 更新职级（不可变更新，版本递增）；禁止跨租户修改。 */
export function updateJobLevel(
  jobLevel: JobLevel,
  patch: UpdateJobLevelPatch,
  now: Date,
): JobLevel {
  assertSameTenant(jobLevel.tenantId, patch.tenantId);

  const code = patch.code ?? jobLevel.code;
  assertOrgCode(code, 'code');
  const name = patch.name ?? jobLevel.name;
  assertName(name, 'name');
  const track = patch.track ?? jobLevel.track;
  assertJobTrack(track);
  const rank = patch.rank ?? jobLevel.rank;
  assertJobRank(rank);

  return {
    ...jobLevel,
    code,
    name,
    track,
    rank,
    version: jobLevel.version + 1,
    updatedAt: toIso(now),
  };
}
