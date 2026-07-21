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
