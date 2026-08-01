export class KnowledgeDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'KnowledgeDomainError';
  }
}

export interface CourseVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly courseCode: string;
  readonly revision: number;
  readonly title: string;
  readonly contentRef: string;
  readonly questionBankRef: string | null;
  readonly questionBankDigest: string | null;
  readonly passingScoreBps: number | null;
  readonly questionMode: 'objective' | 'subjective' | 'mixed' | null;
  readonly timeLimitMinutes: number | null;
  readonly maxAttempts: number | null;
  readonly gradingPolicyVersion: string | null;
  readonly passingRule: 'score_threshold' | 'all_required_sections' | null;
  readonly gradingSlaMinutes: number | null;
  readonly manualReviewSlaMinutes: number | null;
  readonly manualReviewRequired: boolean;
  readonly audienceMode: 'assigned_only' | 'employment_scope';
  readonly audienceDepartmentIds: readonly string[];
  readonly audiencePositionIds: readonly string[];
  readonly status: 'draft' | 'published' | 'retired';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TrainingAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly onboardingInstanceId: string;
  readonly courseVersionId: string;
  readonly mandatory: boolean;
  readonly examRequired: boolean;
  readonly dueDate: string;
  readonly status: 'assigned' | 'in_progress' | 'completed' | 'expired';
  readonly progressBps: number;
  readonly passedExamAttemptId: string | null;
  readonly completionEvidenceId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 评分结果只保存摘要与证据引用，禁止保存答案或标准答案。 */
export interface ExamAttempt {
  readonly id: string;
  readonly tenantId: string;
  readonly assignmentId: string;
  readonly attemptNumber: number;
  readonly submissionRef: string;
  readonly questionSetDigest: string;
  readonly gradingEvidenceId: string;
  readonly questionMode: 'objective' | 'subjective' | 'mixed';
  readonly gradingPolicyVersion: string;
  readonly passingRule: 'score_threshold' | 'all_required_sections';
  readonly manualReviewEvidenceId: string | null;
  readonly submissionReason: 'learner' | 'timeout';
  readonly scoreBps: number;
  readonly passed: boolean;
  readonly gradedAt: string;
}

export function createCourseVersion(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly courseCode: string;
    readonly revision: number;
    readonly title: string;
    readonly contentRef: string;
    readonly questionBankRef?: string;
    readonly questionBankDigest?: string;
    readonly passingScoreBps?: number;
    readonly questionMode?: 'objective' | 'subjective' | 'mixed';
    readonly timeLimitMinutes?: number;
    readonly maxAttempts?: number;
    readonly gradingPolicyVersion?: string;
    readonly passingRule?: 'score_threshold' | 'all_required_sections';
    readonly gradingSlaMinutes?: number;
    readonly manualReviewSlaMinutes?: number;
    readonly audienceMode?: 'assigned_only' | 'employment_scope';
    readonly audienceDepartmentIds?: readonly string[];
    readonly audiencePositionIds?: readonly string[];
  },
  now: Date,
): CourseVersion {
  for (const [field, value] of Object.entries({
    id: input.id, tenantId: input.tenantId, contentRef: input.contentRef,
  })) assertId(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.courseCode)) invalid('KNOWLEDGE_COURSE_CODE_INVALID', '课程编码非法');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) invalid('KNOWLEDGE_REVISION_INVALID', '课程修订号非法');
  const title = input.title.normalize('NFKC').trim();
  if (title.length < 1 || title.length > 128) invalid('KNOWLEDGE_TITLE_INVALID', '课程标题非法');
  const examFields = [input.questionBankRef, input.questionBankDigest, input.passingScoreBps];
  if (examFields.some((value) => value !== undefined) && examFields.some((value) => value === undefined)) {
    invalid('KNOWLEDGE_EXAM_CONFIG_INCOMPLETE', '考试配置必须完整提供');
  }
  const policyFields = [
    input.questionMode,
    input.timeLimitMinutes,
    input.maxAttempts,
    input.gradingPolicyVersion,
    input.passingRule,
    input.gradingSlaMinutes,
    input.manualReviewSlaMinutes,
  ];
  if (examFields.every((value) => value === undefined) &&
    policyFields.some((value) => value !== undefined)) {
    invalid('KNOWLEDGE_EXAM_POLICY_WITHOUT_BANK', '未配置题库时不能配置考试策略');
  }
  if (input.questionBankRef !== undefined) assertId(input.questionBankRef, 'questionBankRef');
  if (input.questionBankDigest !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(input.questionBankDigest)) {
    invalid('KNOWLEDGE_QUESTION_DIGEST_INVALID', '题库摘要必须为 SHA-256 base64url');
  }
  if (input.passingScoreBps !== undefined) assertBps(input.passingScoreBps, 'passingScoreBps');
  const examConfigured = input.questionBankRef !== undefined;
  const questionMode = examConfigured ? input.questionMode ?? 'objective' : null;
  const timeLimitMinutes = examConfigured ? input.timeLimitMinutes ?? 60 : null;
  const maxAttempts = examConfigured ? input.maxAttempts ?? 3 : null;
  const gradingPolicyVersion = examConfigured
    ? input.gradingPolicyVersion ?? 'objective-auto-v1'
    : null;
  const passingRule = examConfigured ? input.passingRule ?? 'score_threshold' : null;
  const gradingSlaMinutes = examConfigured ? input.gradingSlaMinutes ?? 5 : null;
  const manualReviewSlaMinutes = examConfigured
    ? input.manualReviewSlaMinutes ?? 1_440
    : null;
  if (
    timeLimitMinutes !== null &&
    (!Number.isSafeInteger(timeLimitMinutes) ||
      timeLimitMinutes < 5 ||
      timeLimitMinutes > 240)
  ) invalid('KNOWLEDGE_EXAM_TIME_LIMIT_INVALID', '答题时限必须为 5..240 分钟');
  if (
    maxAttempts !== null &&
    (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
  ) invalid('KNOWLEDGE_EXAM_MAX_ATTEMPTS_INVALID', '最大考试次数必须为 1..10');
  if (
    gradingPolicyVersion !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u.test(gradingPolicyVersion)
  ) invalid('KNOWLEDGE_GRADING_POLICY_VERSION_INVALID', '评分策略版本非法');
  if (
    passingRule !== null &&
    !['score_threshold', 'all_required_sections'].includes(passingRule)
  ) invalid('KNOWLEDGE_PASSING_RULE_INVALID', '考试通过规则非法');
  if (
    gradingSlaMinutes !== null &&
    (!Number.isSafeInteger(gradingSlaMinutes) ||
      gradingSlaMinutes < 1 ||
      gradingSlaMinutes > 60)
  ) invalid('KNOWLEDGE_GRADING_SLA_INVALID', '自动评分 SLA 必须为 1..60 分钟');
  if (
    manualReviewSlaMinutes !== null &&
    (!Number.isSafeInteger(manualReviewSlaMinutes) ||
      manualReviewSlaMinutes < 30 ||
      manualReviewSlaMinutes > 10_080)
  ) invalid('KNOWLEDGE_MANUAL_REVIEW_SLA_INVALID', '人工复核 SLA 必须为 30..10080 分钟');
  const audienceMode = input.audienceMode ?? 'assigned_only';
  const audienceDepartmentIds = normalizeAudienceIds(
    input.audienceDepartmentIds ?? [],
    'audienceDepartmentIds',
  );
  const audiencePositionIds = normalizeAudienceIds(
    input.audiencePositionIds ?? [],
    'audiencePositionIds',
  );
  if (audienceMode === 'assigned_only') {
    if (audienceDepartmentIds.length > 0 || audiencePositionIds.length > 0) invalid(
      'KNOWLEDGE_AUDIENCE_INVALID',
      '仅限已分配人员的课程不能同时配置部门或岗位范围',
    );
  } else if (
    audienceMode !== 'employment_scope' ||
    (audienceDepartmentIds.length === 0 && audiencePositionIds.length === 0)
  ) invalid(
    'KNOWLEDGE_AUDIENCE_INVALID',
    '任职范围课程必须至少配置一个部门或岗位',
  );
  const occurredAt = iso(now);
  return Object.freeze({
    id: input.id, tenantId: input.tenantId, courseCode: input.courseCode,
    revision: input.revision, title, contentRef: input.contentRef,
    questionBankRef: input.questionBankRef ?? null,
    questionBankDigest: input.questionBankDigest ?? null,
    passingScoreBps: input.passingScoreBps ?? null,
    questionMode,
    timeLimitMinutes,
    maxAttempts,
    gradingPolicyVersion,
    passingRule,
    gradingSlaMinutes,
    manualReviewSlaMinutes,
    manualReviewRequired: questionMode === 'subjective' || questionMode === 'mixed',
    audienceMode,
    audienceDepartmentIds,
    audiencePositionIds,
    status: 'draft', version: 1, createdAt: occurredAt, updatedAt: occurredAt,
  });
}

export function retireCourseVersion(
  course: CourseVersion,
  input: { readonly tenantId: string; readonly expectedVersion: number },
  now: Date,
): CourseVersion {
  assertVersion(course, input.tenantId, input.expectedVersion);
  if (course.status !== 'published') invalid(
    'KNOWLEDGE_COURSE_RETIRE_INVALID',
    '只能下架已发布课程',
  );
  return Object.freeze({
    ...course,
    status: 'retired',
    version: course.version + 1,
    updatedAt: iso(now),
  });
}

export function publishCourseVersion(
  course: CourseVersion,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly contentVerified: boolean;
    readonly questionBankVerified: boolean;
  },
  now: Date,
): CourseVersion {
  assertVersion(course, input.tenantId, input.expectedVersion);
  if (course.status !== 'draft' || !input.contentVerified) invalid(
    'KNOWLEDGE_COURSE_PUBLISH_INVALID', '课程内容未通过发布校验',
  );
  if (course.questionBankRef !== null && !input.questionBankVerified) invalid(
    'KNOWLEDGE_QUESTION_BANK_UNVERIFIED', '题库未通过受信任校验',
  );
  return Object.freeze({
    ...course, status: 'published', version: course.version + 1, updatedAt: iso(now),
  });
}

export function createTrainingAssignment(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly onboardingInstanceId: string;
    readonly courseVersionId: string;
    readonly mandatory: boolean;
    readonly examRequired: boolean;
    readonly dueDate: string;
    readonly coursePublished: boolean;
  },
  now: Date,
): TrainingAssignment {
  for (const [field, value] of Object.entries({
    id: input.id, tenantId: input.tenantId,
    onboardingInstanceId: input.onboardingInstanceId, courseVersionId: input.courseVersionId,
  })) assertId(value, field);
  if (!input.coursePublished) invalid('KNOWLEDGE_COURSE_NOT_PUBLISHED', '只能分配已发布课程');
  assertLocalDate(input.dueDate, 'dueDate');
  const occurredAt = iso(now);
  return Object.freeze({
    id: input.id, tenantId: input.tenantId,
    onboardingInstanceId: input.onboardingInstanceId,
    courseVersionId: input.courseVersionId, mandatory: input.mandatory,
    examRequired: input.examRequired, dueDate: input.dueDate,
    status: 'assigned', progressBps: 0, passedExamAttemptId: null,
    completionEvidenceId: null, version: 1,
    createdAt: occurredAt, updatedAt: occurredAt,
  });
}

/** 学习进度只接受服务端消费记录计算后的绝对值，禁止客户端增量累加。 */
export function recordTrainingProgress(
  assignment: TrainingAssignment,
  input: { readonly tenantId: string; readonly expectedVersion: number; readonly progressBps: number },
  now: Date,
): TrainingAssignment {
  assertVersion(assignment, input.tenantId, input.expectedVersion);
  assertBps(input.progressBps, 'progressBps');
  if (assignment.status === 'completed' || assignment.status === 'expired') invalid(
    'KNOWLEDGE_ASSIGNMENT_TERMINAL', '终态培训任务不能更新进度',
  );
  if (input.progressBps < assignment.progressBps) invalid(
    'KNOWLEDGE_PROGRESS_REGRESSION', '培训进度不能回退',
  );
  return Object.freeze({
    ...assignment,
    progressBps: input.progressBps,
    status: input.progressBps === 0 ? 'assigned' : 'in_progress',
    version: assignment.version + 1,
    updatedAt: iso(now),
  });
}

export function createExamAttempt(
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly assignmentId: string;
    readonly attemptNumber: number;
    readonly submissionRef: string;
    readonly questionSetDigest: string;
    readonly gradingEvidenceId: string;
    readonly questionMode?: 'objective' | 'subjective' | 'mixed';
    readonly gradingPolicyVersion?: string;
    readonly passingRule?: 'score_threshold' | 'all_required_sections';
    readonly manualReviewEvidenceId?: string;
    readonly submissionReason?: 'learner' | 'timeout';
    readonly scoreBps: number;
    readonly passingScoreBps: number;
    readonly passedOverride?: boolean;
    readonly serverGradingVerified: boolean;
  },
  now: Date,
): ExamAttempt {
  for (const [field, value] of Object.entries({
    id: input.id, tenantId: input.tenantId, assignmentId: input.assignmentId,
    submissionRef: input.submissionRef, gradingEvidenceId: input.gradingEvidenceId,
  })) assertId(value, field);
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) invalid(
    'KNOWLEDGE_ATTEMPT_NUMBER_INVALID', '考试次数非法',
  );
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.questionSetDigest)) invalid(
    'KNOWLEDGE_QUESTION_DIGEST_INVALID', '试题集摘要非法',
  );
  assertBps(input.scoreBps, 'scoreBps');
  assertBps(input.passingScoreBps, 'passingScoreBps');
  if (!input.serverGradingVerified) invalid(
    'KNOWLEDGE_SERVER_GRADING_REQUIRED', '考试成绩必须来自服务端评分器',
  );
  const questionMode = input.questionMode ?? 'objective';
  const gradingPolicyVersion = input.gradingPolicyVersion ?? 'objective-auto-v1';
  const passingRule = input.passingRule ?? 'score_threshold';
  const manualReviewRequired = questionMode === 'subjective' || questionMode === 'mixed';
  if (manualReviewRequired && input.manualReviewEvidenceId === undefined) {
    invalid(
      'KNOWLEDGE_MANUAL_REVIEW_EVIDENCE_REQUIRED',
      '主观题或混合题必须绑定人工复核证据',
    );
  }
  if (input.manualReviewEvidenceId !== undefined) {
    assertId(input.manualReviewEvidenceId, 'manualReviewEvidenceId');
  }
  const thresholdPassed = input.scoreBps >= input.passingScoreBps;
  if (
    passingRule === 'score_threshold' &&
    input.passedOverride !== undefined &&
    input.passedOverride !== thresholdPassed
  ) invalid('KNOWLEDGE_GRADING_PASS_MISMATCH', '评分通过结论与阈值策略不一致');
  if (passingRule === 'all_required_sections' && input.passedOverride === undefined) {
    invalid('KNOWLEDGE_GRADING_PASS_REQUIRED', '分项通过策略必须提供受信通过结论');
  }
  return Object.freeze({
    id: input.id, tenantId: input.tenantId, assignmentId: input.assignmentId,
    attemptNumber: input.attemptNumber, submissionRef: input.submissionRef,
    questionSetDigest: input.questionSetDigest, gradingEvidenceId: input.gradingEvidenceId,
    questionMode,
    gradingPolicyVersion,
    passingRule,
    manualReviewEvidenceId: input.manualReviewEvidenceId ?? null,
    submissionReason: input.submissionReason ?? 'learner',
    scoreBps: input.scoreBps,
    passed: input.passedOverride ?? thresholdPassed,
    gradedAt: iso(now),
  });
}

export function completeTrainingAssignment(
  assignment: TrainingAssignment,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly completionEvidenceId: string;
    readonly passedExamAttemptId?: string;
    readonly examPassedVerified: boolean;
  },
  now: Date,
): TrainingAssignment {
  assertVersion(assignment, input.tenantId, input.expectedVersion);
  assertId(input.completionEvidenceId, 'completionEvidenceId');
  if (assignment.progressBps !== 10_000) invalid(
    'KNOWLEDGE_CONTENT_INCOMPLETE', '课程内容尚未完成',
  );
  if (assignment.examRequired) {
    assertId(input.passedExamAttemptId, 'passedExamAttemptId');
    if (!input.examPassedVerified) invalid(
      'KNOWLEDGE_PASSED_EXAM_REQUIRED', '必须引用该培训任务已通过的可信考试记录',
    );
  } else if (input.passedExamAttemptId !== undefined || input.examPassedVerified) {
    invalid('KNOWLEDGE_EXAM_EVIDENCE_UNEXPECTED', '免试课程不能绑定考试记录');
  }
  return Object.freeze({
    ...assignment, status: 'completed',
    passedExamAttemptId: input.passedExamAttemptId ?? null,
    completionEvidenceId: input.completionEvidenceId,
    version: assignment.version + 1, updatedAt: iso(now),
  });
}

function assertVersion(
  aggregate: { readonly tenantId: string; readonly version: number },
  tenantId: string,
  expectedVersion: number,
): void {
  if (aggregate.tenantId !== tenantId) invalid('KNOWLEDGE_CROSS_TENANT', '禁止跨租户操作');
  if (aggregate.version !== expectedVersion) invalid('KNOWLEDGE_VERSION_CONFLICT', '版本冲突');
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) invalid(
    'KNOWLEDGE_ID_INVALID', `${field} 非法`,
  );
}

function assertBps(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) invalid(
    'KNOWLEDGE_BPS_INVALID', `${field} 必须为 0..10000 的整数`,
  );
}

function normalizeAudienceIds(values: readonly string[], field: string): readonly string[] {
  if (values.length > 200) invalid(
    'KNOWLEDGE_AUDIENCE_INVALID',
    `${field} 数量不能超过 200`,
  );
  const normalized = [...new Set<string>(values)];
  if (normalized.length !== values.length) invalid(
    'KNOWLEDGE_AUDIENCE_INVALID',
    `${field} 不能包含重复标识`,
  );
  for (const value of normalized) assertId(value, field);
  return Object.freeze(normalized.sort((left, right) => left.localeCompare(right)));
}

function assertLocalDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('KNOWLEDGE_DATE_INVALID', `${field} 非法`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid(
    'KNOWLEDGE_DATE_INVALID', `${field} 不是合法日期`,
  );
}

function iso(value: Date): string {
  if (Number.isNaN(value.getTime())) invalid('KNOWLEDGE_TIME_INVALID', '时间非法');
  return value.toISOString();
}

function invalid(code: string, message: string): never {
  throw new KnowledgeDomainError(code, message);
}
