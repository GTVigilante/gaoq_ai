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
  if (input.questionBankRef !== undefined) assertId(input.questionBankRef, 'questionBankRef');
  if (input.questionBankDigest !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(input.questionBankDigest)) {
    invalid('KNOWLEDGE_QUESTION_DIGEST_INVALID', '题库摘要必须为 SHA-256 base64url');
  }
  if (input.passingScoreBps !== undefined) assertBps(input.passingScoreBps, 'passingScoreBps');
  const occurredAt = iso(now);
  return Object.freeze({
    id: input.id, tenantId: input.tenantId, courseCode: input.courseCode,
    revision: input.revision, title, contentRef: input.contentRef,
    questionBankRef: input.questionBankRef ?? null,
    questionBankDigest: input.questionBankDigest ?? null,
    passingScoreBps: input.passingScoreBps ?? null,
    status: 'draft', version: 1, createdAt: occurredAt, updatedAt: occurredAt,
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
    readonly scoreBps: number;
    readonly passingScoreBps: number;
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
  return Object.freeze({
    id: input.id, tenantId: input.tenantId, assignmentId: input.assignmentId,
    attemptNumber: input.attemptNumber, submissionRef: input.submissionRef,
    questionSetDigest: input.questionSetDigest, gradingEvidenceId: input.gradingEvidenceId,
    scoreBps: input.scoreBps, passed: input.scoreBps >= input.passingScoreBps,
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
  },
  now: Date,
): TrainingAssignment {
  assertVersion(assignment, input.tenantId, input.expectedVersion);
  assertId(input.completionEvidenceId, 'completionEvidenceId');
  if (assignment.progressBps !== 10_000) invalid(
    'KNOWLEDGE_CONTENT_INCOMPLETE', '课程内容尚未完成',
  );
  if (assignment.examRequired) assertId(input.passedExamAttemptId, 'passedExamAttemptId');
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
