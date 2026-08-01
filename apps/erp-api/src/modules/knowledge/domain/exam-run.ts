export type KnowledgeExamRunStatus =
  | 'starting'
  | 'in_progress'
  | 'submitted'
  | 'pending_review'
  | 'graded'
  | 'dead';

export interface KnowledgeExamRun {
  readonly id: string;
  readonly tenantId: string;
  readonly assignmentId: string;
  readonly courseVersionId: string;
  readonly questionBankRef: string;
  readonly questionBankDigest: string;
  readonly attemptNumber: number;
  readonly questionMode: 'objective' | 'subjective' | 'mixed';
  readonly gradingPolicyVersion: string;
  readonly passingRule: 'score_threshold' | 'all_required_sections';
  readonly passingScoreBps: number;
  readonly maxAttempts: number;
  readonly timeLimitMinutes: number;
  readonly manualReviewRequired: boolean;
  readonly gradingSlaMinutes: number;
  readonly manualReviewSlaMinutes: number;
  readonly status: KnowledgeExamRunStatus;
  readonly gatewaySessionRef: string | null;
  readonly submissionRef: string | null;
  readonly questionSetDigest: string | null;
  readonly reviewEvidenceId: string | null;
  readonly finalAttemptId: string | null;
  readonly startedAt: string | null;
  readonly deadlineAt: string | null;
  readonly submittedAt: string | null;
  readonly submissionReason: 'learner' | 'timeout' | null;
  readonly timedOut: boolean;
  readonly attempts: number;
  readonly reviewPolls: number;
  readonly nextActionAt: string;
  readonly lastErrorCode: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createKnowledgeExamRun(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly assignmentId: string;
  readonly courseVersionId: string;
  readonly questionBankRef: string;
  readonly questionBankDigest: string;
  readonly attemptNumber: number;
  readonly questionMode: 'objective' | 'subjective' | 'mixed';
  readonly gradingPolicyVersion: string;
  readonly passingRule: 'score_threshold' | 'all_required_sections';
  readonly passingScoreBps: number;
  readonly maxAttempts: number;
  readonly timeLimitMinutes: number;
  readonly manualReviewRequired: boolean;
  readonly gradingSlaMinutes: number;
  readonly manualReviewSlaMinutes: number;
}, now: Date): KnowledgeExamRun {
  assertInteger(input.attemptNumber, 1, input.maxAttempts, '考试次数');
  assertInteger(input.passingScoreBps, 0, 10_000, '及格分');
  assertInteger(input.maxAttempts, 1, 10, '最大考试次数');
  assertInteger(input.timeLimitMinutes, 5, 240, '答题时限');
  assertInteger(input.gradingSlaMinutes, 1, 60, '自动评分 SLA');
  assertInteger(input.manualReviewSlaMinutes, 30, 10_080, '人工复核 SLA');
  if (
    input.manualReviewRequired !==
    (input.questionMode === 'subjective' || input.questionMode === 'mixed')
  ) throw new Error('KNOWLEDGE_EXAM_REVIEW_POLICY_INVALID');
  const timestamp = now.toISOString();
  return Object.freeze({
    ...input,
    status: 'starting',
    gatewaySessionRef: null,
    submissionRef: null,
    questionSetDigest: null,
    reviewEvidenceId: null,
    finalAttemptId: null,
    startedAt: null,
    deadlineAt: null,
    submittedAt: null,
    submissionReason: null,
    timedOut: false,
    attempts: 0,
    reviewPolls: 0,
    nextActionAt: timestamp,
    lastErrorCode: null,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function assertInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`KNOWLEDGE_EXAM_POLICY_INVALID:${label}`);
  }
}
