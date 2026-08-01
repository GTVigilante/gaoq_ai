import { RecruitmentDomainError } from './recruitment.errors.js';
import {
  assertRecruitmentId,
  assertRecruitmentLabel,
  assertRecruitmentTenant,
  assertRecruitmentVersion,
  deepFreezeRecruitment,
  toRecruitmentIso,
} from './recruitment.validation.js';

export type RecruitmentInterviewStatus = 'scheduled' | 'completed' | 'cancelled';
export type RecruitmentInterviewMode = 'phone' | 'video' | 'onsite';
export type InterviewRecommendation = 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire';

const INTERVIEW_MODES: readonly RecruitmentInterviewMode[] =
  ['phone', 'video', 'onsite'];
const INTERVIEW_STATUSES: readonly RecruitmentInterviewStatus[] =
  ['scheduled', 'completed', 'cancelled'];
const INTERVIEW_RECOMMENDATIONS: readonly InterviewRecommendation[] =
  ['strong_hire', 'hire', 'no_hire', 'strong_no_hire'];
const INTERVIEW_TIMEZONE_PATTERN =
  /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/;

export interface RecruitmentInterview {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly roundNumber: number;
  readonly mode: RecruitmentInterviewMode;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly interviewerIds: readonly string[];
  /** L3；持久层必须加密，列表、事件和审计不得输出。 */
  readonly location: string;
  readonly status: RecruitmentInterviewStatus;
  readonly version: number;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecruitmentInterviewFeedback {
  readonly id: string;
  readonly tenantId: string;
  readonly interviewId: string;
  readonly interviewerId: string;
  readonly recommendation: InterviewRecommendation;
  readonly score: number;
  /** L3 原文；只能加密追加，禁止覆盖。 */
  readonly notes: string;
  readonly submittedAt: string;
}

export interface RecruitmentInterviewFeedbackResult {
  readonly interview: RecruitmentInterview;
  readonly feedback: RecruitmentInterviewFeedback;
}

export interface RecruitmentInterviewMigrationFeedback {
  readonly id: string;
  readonly interviewerId: string;
  readonly recommendation: InterviewRecommendation;
  readonly score: number;
  readonly notes: string;
  readonly submittedAt: string;
}

export interface RecruitmentInterviewMigrationResult {
  readonly interview: RecruitmentInterview;
  readonly feedback: readonly RecruitmentInterviewFeedback[];
}

export function createRecruitmentInterview(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly applicationId: string;
    readonly roundNumber: number;
    readonly mode: RecruitmentInterviewMode;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly timezone: string;
    readonly interviewerIds: readonly string[];
    readonly location: string;
    readonly actorId: string;
  },
  now: Date,
): RecruitmentInterview {
  const occurredAt = toRecruitmentIso(now);
  for (const [field, value] of Object.entries({
    id: input.id, tenantId: input.tenantId, applicationId: input.applicationId,
    actorId: input.actorId,
  })) assertRecruitmentId(value, field);
  if (!Number.isSafeInteger(input.roundNumber) || input.roundNumber < 1 || input.roundNumber > 100) {
    throw new RecruitmentDomainError('RECRUITMENT_INTERVIEW_ROUND_INVALID', '面试轮次必须为 1..100 的整数');
  }
  assertInterviewMode(input.mode);
  if (!Array.isArray(input.interviewerIds)) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEWERS_INVALID', '面试官必须唯一且人数为 1..20',
  );
  const interviewerIds = [...new Set(input.interviewerIds)];
  if (
    interviewerIds.length < 1 || interviewerIds.length > 20 ||
    interviewerIds.length !== input.interviewerIds.length
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEWERS_INVALID', '面试官必须唯一且人数为 1..20',
  );
  for (const interviewerId of interviewerIds) assertRecruitmentId(interviewerId, 'interviewerId');
  const startsAtIso = toRecruitmentIso(input.startsAt);
  const endsAtIso = toRecruitmentIso(input.endsAt);
  const startsAt = input.startsAt.getTime();
  const endsAt = input.endsAt.getTime();
  if (
    !Number.isFinite(startsAt) || !Number.isFinite(endsAt) ||
    startsAt <= now.getTime() || endsAt <= startsAt ||
    endsAt - startsAt > 12 * 60 * 60 * 1_000
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEW_TIME_INVALID', '面试必须在未来开始、正向结束且时长不超过 12 小时',
  );
  assertInterviewTimezone(input.timezone);
  assertRecruitmentLabel(input.location, 'location', 2_048);
  return deepFreezeRecruitment({
    id: input.id, tenantId: input.tenantId, applicationId: input.applicationId,
    roundNumber: input.roundNumber, mode: input.mode,
    startsAt: startsAtIso, endsAt: endsAtIso,
    timezone: input.timezone, interviewerIds, location: input.location.trim(),
    status: 'scheduled' as const, version: 1, completedAt: null, cancelledAt: null,
    createdBy: input.actorId, createdAt: occurredAt, updatedAt: occurredAt,
  });
}

/** 数据迁移专用：以内存状态机恢复面试和评价，不伪造在线排期或评价事件。 */
export function restoreRecruitmentInterviewFromMigration(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly applicationId: string;
    readonly roundNumber: number;
    readonly mode: RecruitmentInterviewMode;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly timezone: string;
    readonly interviewerIds: readonly string[];
    readonly location: string;
    readonly createdBy: string;
    readonly feedback: readonly RecruitmentInterviewMigrationFeedback[];
    readonly expectedStatus: RecruitmentInterviewStatus;
    readonly expectedVersion: number;
    readonly completedAt: string | null;
    readonly cancelledAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
  now: Date,
): RecruitmentInterviewMigrationResult {
  toRecruitmentIso(now);
  assertInterviewStatus(input.expectedStatus);
  assertRecruitmentVersion(input.expectedVersion);
  if (!Array.isArray(input.interviewerIds)) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEWERS_INVALID', '面试官必须唯一且人数为 1..20',
  );
  if (!Array.isArray(input.feedback)) throw new RecruitmentDomainError(
    'RECRUITMENT_MIGRATION_INTERVIEW_FEEDBACK_INVALID',
    '面试迁移评价必须为有界普通对象数组',
  );
  const createdAt = strictInterviewMigrationIso(input.createdAt);
  const startsAt = strictInterviewMigrationIso(input.startsAt);
  const endsAt = strictInterviewMigrationIso(input.endsAt);
  const updatedAt = strictInterviewMigrationIso(input.updatedAt);
  const completedAt = input.completedAt === null
    ? null
    : strictInterviewMigrationIso(input.completedAt);
  const cancelledAt = input.cancelledAt === null
    ? null
    : strictInterviewMigrationIso(input.cancelledAt);
  const nowTime = now.getTime();
  if (Date.parse(createdAt) > nowTime + 5 * 60 * 1_000 || createdAt > startsAt ||
    Date.parse(endsAt) <= Date.parse(startsAt) ||
    Date.parse(endsAt) - Date.parse(startsAt) > 12 * 60 * 60 * 1_000 ||
    (input.expectedStatus === 'scheduled' && Date.parse(endsAt) <= nowTime)) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_INTERVIEW_TIMELINE_INVALID',
      '面试迁移时间线无效或待排期面试已过期',
    );
  }
  for (const [field, value] of Object.entries({
    id: input.id,
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    createdBy: input.createdBy,
  })) assertRecruitmentId(value, field);
  if (!Number.isSafeInteger(input.roundNumber) || input.roundNumber < 1 || input.roundNumber > 100) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_INTERVIEW_ROUND_INVALID', '面试轮次必须为 1..100 的整数',
    );
  }
  assertInterviewMode(input.mode);
  const interviewerIds = [...new Set(input.interviewerIds)];
  if (interviewerIds.length < 1 || interviewerIds.length > 20 ||
    interviewerIds.length !== input.interviewerIds.length) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEWERS_INVALID', '面试官必须唯一且人数为 1..20',
  );
  for (const interviewerId of interviewerIds) assertRecruitmentId(interviewerId, 'interviewerId');
  assertInterviewTimezone(input.timezone);
  assertRecruitmentLabel(input.location, 'location', 2_048);
  if (input.feedback.length > 20 ||
    input.expectedVersion !== 1 + input.feedback.length +
      (input.expectedStatus === 'scheduled' ? 0 : 1)) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_INTERVIEW_VERSION_INVALID',
      '面试迁移评价数量、状态与版本不一致',
    );
  }
  let interview: RecruitmentInterview = deepFreezeRecruitment({
    id: input.id,
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    roundNumber: input.roundNumber,
    mode: input.mode,
    startsAt,
    endsAt,
    timezone: input.timezone,
    interviewerIds,
    location: input.location.trim(),
    status: 'scheduled' as const,
    version: 1,
    completedAt: null,
    cancelledAt: null,
    createdBy: input.createdBy,
    createdAt,
    updatedAt: createdAt,
  });
  const restoredFeedback: RecruitmentInterviewFeedback[] = [];
  const submitted = new Set<string>();
  let previous = createdAt;
  for (const candidate of input.feedback as readonly unknown[]) {
    assertMigrationFeedback(candidate);
    const source = candidate;
    const submittedAt = strictInterviewMigrationIso(source.submittedAt);
    if (submittedAt < startsAt || submittedAt < previous ||
      Date.parse(submittedAt) > nowTime + 5 * 60 * 1_000 ||
      submitted.has(source.interviewerId)) {
      throw new RecruitmentDomainError(
        'RECRUITMENT_MIGRATION_INTERVIEW_FEEDBACK_INVALID',
        '面试迁移评价必须唯一、按时间排序且不得位于未来',
      );
    }
    const result = submitRecruitmentInterviewFeedback(interview, {
      id: source.id,
      tenantId: input.tenantId,
      expectedVersion: interview.version,
      interviewerId: source.interviewerId,
      recommendation: source.recommendation,
      score: source.score,
      notes: source.notes,
    }, new Date(submittedAt));
    interview = result.interview;
    restoredFeedback.push(result.feedback);
    submitted.add(source.interviewerId);
    previous = submittedAt;
  }
  if (input.expectedStatus === 'completed') {
    if (completedAt === null || cancelledAt !== null || completedAt < endsAt ||
      completedAt < previous || Date.parse(completedAt) > nowTime + 5 * 60 * 1_000) {
      throw new RecruitmentDomainError(
        'RECRUITMENT_MIGRATION_INTERVIEW_TIMELINE_INVALID', '面试完成时间线无效',
      );
    }
    interview = completeRecruitmentInterview(interview, {
      tenantId: input.tenantId,
      expectedVersion: interview.version,
      submittedInterviewerIds: [...submitted],
    }, new Date(completedAt));
  } else if (input.expectedStatus === 'cancelled') {
    if (cancelledAt === null || completedAt !== null || cancelledAt < createdAt ||
      cancelledAt < previous || Date.parse(cancelledAt) > nowTime + 5 * 60 * 1_000) {
      throw new RecruitmentDomainError(
        'RECRUITMENT_MIGRATION_INTERVIEW_TIMELINE_INVALID', '面试取消时间线无效',
      );
    }
    interview = cancelRecruitmentInterview(interview, {
      tenantId: input.tenantId,
      expectedVersion: interview.version,
    }, new Date(cancelledAt));
  } else if (completedAt !== null || cancelledAt !== null) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_INTERVIEW_TIMELINE_INVALID', '待排期面试不得持有终态时间',
    );
  }
  if (interview.status !== input.expectedStatus || interview.version !== input.expectedVersion ||
    interview.updatedAt !== updatedAt || interview.completedAt !== completedAt ||
    interview.cancelledAt !== cancelledAt) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_INTERVIEW_CONTROL_MISMATCH',
      '面试迁移最终状态、版本或时间控制事实不一致',
    );
  }
  return deepFreezeRecruitment({ interview, feedback: restoredFeedback });
}

export function submitRecruitmentInterviewFeedback(
  interview: RecruitmentInterview,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly interviewerId: string;
    readonly recommendation: InterviewRecommendation;
    readonly score: number;
    readonly notes: string;
  },
  now: Date,
): RecruitmentInterviewFeedbackResult {
  assertInterviewCommand(interview, input.tenantId, input.expectedVersion);
  assertRecruitmentId(input.id, 'id');
  assertRecruitmentId(input.interviewerId, 'interviewerId');
  if (interview.status !== 'scheduled' || !interview.interviewerIds.includes(input.interviewerId)) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_FEEDBACK_SUBMIT_DENIED', '只有该轮有效面试官可提交评价',
    );
  }
  if (!INTERVIEW_RECOMMENDATIONS.includes(input.recommendation)) {
    throw new RecruitmentDomainError('RECRUITMENT_RECOMMENDATION_INVALID', '面试建议无效');
  }
  if (!Number.isSafeInteger(input.score) || input.score < 1 || input.score > 5) {
    throw new RecruitmentDomainError('RECRUITMENT_FEEDBACK_SCORE_INVALID', '面试评分必须为 1..5 的整数');
  }
  assertRecruitmentLabel(input.notes, 'notes', 8_192);
  const submittedAt = toRecruitmentIso(now);
  if (submittedAt < interview.startsAt) throw new RecruitmentDomainError(
    'RECRUITMENT_FEEDBACK_TIME_INVALID', '面试开始前不得提交评价',
  );
  const feedback = deepFreezeRecruitment({
    id: input.id, tenantId: input.tenantId, interviewId: interview.id,
    interviewerId: input.interviewerId, recommendation: input.recommendation,
    score: input.score, notes: input.notes.trim(), submittedAt,
  });
  const updatedInterview = advanceInterview(interview, now, {});
  return deepFreezeRecruitment({ interview: updatedInterview, feedback });
}

export function completeRecruitmentInterview(
  interview: RecruitmentInterview,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly submittedInterviewerIds: readonly string[];
  },
  now: Date,
): RecruitmentInterview {
  assertInterviewCommand(interview, input.tenantId, input.expectedVersion);
  if (interview.status !== 'scheduled') throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEW_COMPLETE_INVALID', '只有已排期面试可完成',
  );
  if (!Array.isArray(input.submittedInterviewerIds)) throw new RecruitmentDomainError(
    'RECRUITMENT_FEEDBACK_INCOMPLETE', '所有面试官提交评价后才能完成面试',
  );
  for (const id of input.submittedInterviewerIds) {
    assertRecruitmentId(id, 'submittedInterviewerId');
  }
  const submitted = new Set(input.submittedInterviewerIds);
  if (
    submitted.size !== input.submittedInterviewerIds.length ||
    submitted.size !== interview.interviewerIds.length ||
    !interview.interviewerIds.every((id) => submitted.has(id))
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_FEEDBACK_INCOMPLETE', '所有面试官提交评价后才能完成面试',
  );
  const occurredAt = toRecruitmentIso(now);
  if (occurredAt < interview.endsAt) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEW_COMPLETE_TIME_INVALID', '面试结束前不得完成面试',
  );
  return advanceInterview(interview, now, {
    status: 'completed' as const,
    completedAt: occurredAt,
  });
}

export function cancelRecruitmentInterview(
  interview: RecruitmentInterview,
  input: { readonly tenantId: string; readonly expectedVersion: number },
  now: Date,
): RecruitmentInterview {
  assertInterviewCommand(interview, input.tenantId, input.expectedVersion);
  if (interview.status !== 'scheduled') throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEW_CANCEL_INVALID', '只有已排期面试可取消',
  );
  return advanceInterview(interview, now, {
    status: 'cancelled' as const,
    cancelledAt: toRecruitmentIso(now),
  });
}

function assertInterviewCommand(
  interview: RecruitmentInterview,
  tenantId: string,
  expectedVersion: number,
): void {
  assertRecruitmentTenant(interview.tenantId, tenantId);
  assertRecruitmentVersion(interview.version);
  assertRecruitmentVersion(expectedVersion);
  assertInterviewStatus(interview.status);
  if (interview.version !== expectedVersion) throw new RecruitmentDomainError(
    'RECRUITMENT_VERSION_CONFLICT', '面试版本冲突',
  );
}

function advanceInterview<T extends Partial<RecruitmentInterview>>(
  interview: RecruitmentInterview,
  now: Date,
  patch: T,
): RecruitmentInterview {
  const updatedAt = toRecruitmentIso(now);
  if (interview.version >= Number.MAX_SAFE_INTEGER) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_INTERVIEW_VERSION_EXHAUSTED',
      '面试版本已达到安全整数上限',
    );
  }
  if (updatedAt < interview.updatedAt) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEW_TIMELINE_INVALID',
    '面试更新时间不能早于当前版本',
  );
  return deepFreezeRecruitment({
    ...interview,
    ...patch,
    version: interview.version + 1,
    updatedAt,
  });
}

function assertInterviewMode(value: unknown): asserts value is RecruitmentInterviewMode {
  if (!INTERVIEW_MODES.includes(value as RecruitmentInterviewMode)) {
    throw new RecruitmentDomainError('RECRUITMENT_INTERVIEW_MODE_INVALID', '面试方式无效');
  }
}

function assertInterviewStatus(value: unknown): asserts value is RecruitmentInterviewStatus {
  if (!INTERVIEW_STATUSES.includes(value as RecruitmentInterviewStatus)) {
    throw new RecruitmentDomainError('RECRUITMENT_INTERVIEW_STATUS_INVALID', '面试状态无效');
  }
}

function assertInterviewTimezone(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !INTERVIEW_TIMEZONE_PATTERN.test(value)) {
    throw new RecruitmentDomainError('RECRUITMENT_TIMEZONE_INVALID', '时区必须使用有效 IANA 标识');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new RecruitmentDomainError(
      'RECRUITMENT_TIMEZONE_INVALID',
      '时区必须使用有效 IANA 标识',
    );
  }
}

function assertMigrationFeedback(
  value: unknown,
): asserts value is RecruitmentInterviewMigrationFeedback {
  const expectedKeys = [
    'id',
    'interviewerId',
    'recommendation',
    'score',
    'notes',
    'submittedAt',
  ] as const;
  let descriptors: PropertyDescriptorMap;
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) throw new Error('not_plain');
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(
        key as (typeof expectedKeys)[number],
      ))
    ) throw new Error('keys_invalid');
    descriptors = Object.getOwnPropertyDescriptors(value);
    if (expectedKeys.some((key) => !Object.hasOwn(descriptors, key) ||
      !Object.hasOwn(descriptors[key]!, 'value'))) throw new Error('accessor_invalid');
  } catch {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_INTERVIEW_FEEDBACK_INVALID',
      '面试迁移评价必须为精确普通数据对象',
    );
  }
}

function strictInterviewMigrationIso(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_INTERVIEW_TIMELINE_INVALID',
      '面试迁移时间必须为严格 UTC ISO',
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_INTERVIEW_TIMELINE_INVALID', '面试迁移时间必须为严格 UTC ISO',
    );
  }
  return value;
}
