export type KnowledgeAssignmentStatus = 'assigned' | 'in_progress' | 'completed' | 'expired';

export interface PersonalKnowledgeAssignmentView {
  readonly id: string;
  readonly course: {
    readonly id: string;
    readonly courseCode: string;
    readonly revision: number;
    readonly title: string;
    readonly examRequired: boolean;
    readonly passingScoreBps: number | null;
    readonly status: 'published' | 'retired';
    readonly version: number;
  };
  readonly mandatory: boolean;
  readonly examRequired: boolean;
  readonly dueDate: string;
  readonly status: KnowledgeAssignmentStatus;
  readonly progressBps: number;
  readonly version: number;
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const STATUSES = new Set<KnowledgeAssignmentStatus>(['assigned', 'in_progress', 'completed', 'expired']);

/** 校验本人培训任务最小投影；内容、题库、答卷、证据和租户字段一律拒绝。 */
export function parsePersonalKnowledgeAssignments(value: unknown): readonly PersonalKnowledgeAssignmentView[] {
  const root = record(value);
  if (!Array.isArray(root.items) || root.items.length > 200 || Object.hasOwn(root, 'tenantId')) {
    throw new Error('KNOWLEDGE_ASSIGNMENTS_INVALID');
  }
  return Object.freeze(root.items.map((item) => {
    const assignment = record(item);
    const course = record(assignment.course);
    if (
      typeof assignment.id !== 'string' || !ULID_PATTERN.test(assignment.id) ||
      typeof course.id !== 'string' || !ULID_PATTERN.test(course.id) ||
      typeof course.courseCode !== 'string' || !CODE_PATTERN.test(course.courseCode) ||
      typeof course.revision !== 'number' || !positiveInteger(course.revision) ||
      typeof course.title !== 'string' || course.title.trim().length < 1 || course.title.length > 128 ||
      typeof course.examRequired !== 'boolean' ||
      !(course.passingScoreBps === null || validBps(course.passingScoreBps)) ||
      (course.status !== 'published' && course.status !== 'retired') ||
      typeof course.version !== 'number' || !positiveInteger(course.version) ||
      typeof assignment.mandatory !== 'boolean' || typeof assignment.examRequired !== 'boolean' ||
      assignment.examRequired !== course.examRequired ||
      typeof assignment.dueDate !== 'string' || !localDate(assignment.dueDate) ||
      typeof assignment.status !== 'string' || !STATUSES.has(assignment.status as KnowledgeAssignmentStatus) ||
      typeof assignment.progressBps !== 'number' || !validBps(assignment.progressBps) ||
      typeof assignment.version !== 'number' || !positiveInteger(assignment.version) ||
      forbidden(assignment) || forbidden(course)
    ) throw new Error('KNOWLEDGE_ASSIGNMENTS_INVALID');
    return Object.freeze({
      id: assignment.id,
      course: Object.freeze({
        id: course.id,
        courseCode: course.courseCode,
        revision: course.revision,
        title: course.title.trim(),
        examRequired: course.examRequired,
        passingScoreBps: course.passingScoreBps,
        status: course.status,
        version: course.version,
      }),
      mandatory: assignment.mandatory,
      examRequired: assignment.examRequired,
      dueDate: assignment.dueDate,
      status: assignment.status as KnowledgeAssignmentStatus,
      progressBps: assignment.progressBps,
      version: assignment.version,
    });
  }));
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('KNOWLEDGE_ASSIGNMENTS_INVALID');
  }
  return value as Readonly<Record<string, unknown>>;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validBps(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
}

function localDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function forbidden(value: Readonly<Record<string, unknown>>): boolean {
  return ['tenantId', 'onboardingInstanceId', 'contentRef', 'questionBankRef', 'questionBankDigest',
    'submissionRef', 'completionEvidenceId', 'passedExamAttemptId'].some((key) => Object.hasOwn(value, key));
}
