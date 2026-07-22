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
  for (const [field, value] of Object.entries({
    id: input.id, tenantId: input.tenantId, applicationId: input.applicationId,
    actorId: input.actorId,
  })) assertRecruitmentId(value, field);
  if (!Number.isSafeInteger(input.roundNumber) || input.roundNumber < 1 || input.roundNumber > 100) {
    throw new RecruitmentDomainError('RECRUITMENT_INTERVIEW_ROUND_INVALID', '面试轮次必须为 1..100 的整数');
  }
  if (!['phone', 'video', 'onsite'].includes(input.mode)) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEW_MODE_INVALID', '面试方式无效',
  );
  const interviewerIds = [...new Set(input.interviewerIds)];
  if (
    interviewerIds.length < 1 || interviewerIds.length > 20 ||
    interviewerIds.length !== input.interviewerIds.length
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEWERS_INVALID', '面试官必须唯一且人数为 1..20',
  );
  for (const interviewerId of interviewerIds) assertRecruitmentId(interviewerId, 'interviewerId');
  const startsAt = input.startsAt.getTime();
  const endsAt = input.endsAt.getTime();
  if (
    !Number.isFinite(startsAt) || !Number.isFinite(endsAt) ||
    startsAt <= now.getTime() || endsAt <= startsAt ||
    endsAt - startsAt > 12 * 60 * 60 * 1_000
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEW_TIME_INVALID', '面试必须在未来开始、正向结束且时长不超过 12 小时',
  );
  if (!/^(?:UTC|[A-Za-z_]+\/[A-Za-z0-9_+.-]+)$/.test(input.timezone)) {
    throw new RecruitmentDomainError('RECRUITMENT_TIMEZONE_INVALID', '时区必须使用 IANA 标识');
  }
  assertRecruitmentLabel(input.location, 'location', 2_048);
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    id: input.id, tenantId: input.tenantId, applicationId: input.applicationId,
    roundNumber: input.roundNumber, mode: input.mode,
    startsAt: toRecruitmentIso(input.startsAt), endsAt: toRecruitmentIso(input.endsAt),
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
  if (!['phone', 'video', 'onsite'].includes(input.mode)) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEW_MODE_INVALID', '面试方式无效',
  );
  const interviewerIds = [...new Set(input.interviewerIds)];
  if (interviewerIds.length < 1 || interviewerIds.length > 20 ||
    interviewerIds.length !== input.interviewerIds.length) throw new RecruitmentDomainError(
    'RECRUITMENT_INTERVIEWERS_INVALID', '面试官必须唯一且人数为 1..20',
  );
  for (const interviewerId of interviewerIds) assertRecruitmentId(interviewerId, 'interviewerId');
  if (!/^(?:UTC|[A-Za-z_]+\/[A-Za-z0-9_+.-]+)$/.test(input.timezone)) {
    throw new RecruitmentDomainError('RECRUITMENT_TIMEZONE_INVALID', '时区必须使用 IANA 标识');
  }
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
  for (const source of input.feedback) {
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
  if (!['strong_hire', 'hire', 'no_hire', 'strong_no_hire'].includes(input.recommendation)) {
    throw new RecruitmentDomainError('RECRUITMENT_RECOMMENDATION_INVALID', '面试建议无效');
  }
  if (!Number.isSafeInteger(input.score) || input.score < 1 || input.score > 5) {
    throw new RecruitmentDomainError('RECRUITMENT_FEEDBACK_SCORE_INVALID', '面试评分必须为 1..5 的整数');
  }
  assertRecruitmentLabel(input.notes, 'notes', 8_192);
  const submittedAt = toRecruitmentIso(now);
  const feedback = deepFreezeRecruitment({
    id: input.id, tenantId: input.tenantId, interviewId: interview.id,
    interviewerId: input.interviewerId, recommendation: input.recommendation,
    score: input.score, notes: input.notes.trim(), submittedAt,
  });
  const updatedInterview = deepFreezeRecruitment({
    ...interview, version: interview.version + 1, updatedAt: submittedAt,
  });
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
  const submitted = new Set(input.submittedInterviewerIds);
  if (
    submitted.size !== interview.interviewerIds.length ||
    !interview.interviewerIds.every((id) => submitted.has(id))
  ) throw new RecruitmentDomainError(
    'RECRUITMENT_FEEDBACK_INCOMPLETE', '所有面试官提交评价后才能完成面试',
  );
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    ...interview, status: 'completed' as const, version: interview.version + 1,
    completedAt: occurredAt, updatedAt: occurredAt,
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
  const occurredAt = toRecruitmentIso(now);
  return deepFreezeRecruitment({
    ...interview, status: 'cancelled' as const, version: interview.version + 1,
    cancelledAt: occurredAt, updatedAt: occurredAt,
  });
}

function assertInterviewCommand(
  interview: RecruitmentInterview,
  tenantId: string,
  expectedVersion: number,
): void {
  assertRecruitmentTenant(interview.tenantId, tenantId);
  assertRecruitmentVersion(expectedVersion);
  if (interview.version !== expectedVersion) throw new RecruitmentDomainError(
    'RECRUITMENT_VERSION_CONFLICT', '面试版本冲突',
  );
}

function strictInterviewMigrationIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RecruitmentDomainError(
      'RECRUITMENT_MIGRATION_INTERVIEW_TIMELINE_INVALID', '面试迁移时间必须为严格 UTC ISO',
    );
  }
  return value;
}
