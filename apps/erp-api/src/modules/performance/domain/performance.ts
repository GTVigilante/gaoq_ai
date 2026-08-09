export const PERFORMANCE_RATINGS = ['S', 'A', 'B', 'C', 'D'] as const;
export type PerformanceRating = (typeof PERFORMANCE_RATINGS)[number];
export type PerformanceCycleStatus = 'draft' | 'published' | 'self_review' | 'manager_review' | 'calibration' | 'confirmation' | 'closed';
export type PerformanceAssignmentStatus = 'goal_setting' | 'self_review' | 'manager_review' | 'calibration' | 'confirmation' | 'confirmed' | 'appealed' | 'finalized';

export interface PerformanceTemplate {
  readonly id: string; readonly tenantId: string; readonly name: string;
  readonly okrWeightBps: number; readonly kpiWeightBps: number; readonly competencyWeightBps: number;
  readonly thresholds: Readonly<Record<Exclude<PerformanceRating, 'D'>, number>>;
  readonly coefficients: Readonly<Record<PerformanceRating, number>>;
  readonly version: number; readonly createdAt: string; readonly updatedAt: string;
}

export interface PerformanceCycle {
  readonly id: string; readonly tenantId: string; readonly name: string; readonly templateId: string;
  readonly startDate: string; readonly endDate: string; readonly status: PerformanceCycleStatus;
  readonly assignmentCount: number; readonly version: number; readonly publishedAt: string | null;
  readonly createdAt: string; readonly updatedAt: string;
}

export interface PerformanceAssignment {
  readonly id: string; readonly tenantId: string; readonly cycleId: string;
  readonly employeeId: string; readonly employmentId: string; readonly departmentId: string;
  readonly managerEmployeeId: string; readonly hrbpEmployeeId: string;
  readonly status: PerformanceAssignmentStatus;
  readonly selfScoreBps: number | null; readonly managerScoreBps: number | null;
  readonly calibratedScoreBps: number | null; readonly finalScoreBps: number | null;
  readonly rating: PerformanceRating | null; readonly coefficientBps: number | null;
  readonly selfEvidenceRef: string | null; readonly managerEvidenceRef: string | null;
  readonly calibrationReasonCode: string | null; readonly appealReasonCode: string | null;
  readonly appealEvidenceRef: string | null; readonly version: number;
  readonly createdAt: string; readonly updatedAt: string;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NAME = /^.{2,128}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON = /^[a-z][a-z0-9_]{2,63}$/;

export function createPerformanceTemplate(input: Omit<PerformanceTemplate, 'version' | 'createdAt' | 'updatedAt'>, now: Date): PerformanceTemplate {
  [input.id, input.tenantId].forEach(assertId);
  if (!NAME.test(input.name.trim())) throw new Error('PERFORMANCE_TEMPLATE_NAME_INVALID');
  const weights = [input.okrWeightBps, input.kpiWeightBps, input.competencyWeightBps];
  if (weights.some((value) => !basisPoints(value)) || weights.reduce((sum, value) => sum + value, 0) !== 10_000) {
    throw new Error('PERFORMANCE_TEMPLATE_WEIGHTS_INVALID');
  }
  const { S, A, B, C } = input.thresholds;
  if (![S, A, B, C].every(basisPoints) || !(S > A && A > B && B > C)) throw new Error('PERFORMANCE_TEMPLATE_THRESHOLDS_INVALID');
  if (
    !exactKeys(input.thresholds, ['S', 'A', 'B', 'C']) ||
    !exactKeys(input.coefficients, PERFORMANCE_RATINGS) ||
    !PERFORMANCE_RATINGS.every((rating) => coefficientBps(input.coefficients[rating]))
  ) throw new Error('PERFORMANCE_TEMPLATE_COEFFICIENTS_INVALID');
  const occurredAt = now.toISOString();
  return Object.freeze({ ...input, name: input.name.trim(), thresholds: Object.freeze({ ...input.thresholds }), coefficients: Object.freeze({ ...input.coefficients }), version: 1, createdAt: occurredAt, updatedAt: occurredAt });
}

export function createPerformanceCycle(input: Omit<PerformanceCycle, 'status' | 'assignmentCount' | 'version' | 'publishedAt' | 'createdAt' | 'updatedAt'>, now: Date): PerformanceCycle {
  [input.id, input.tenantId, input.templateId].forEach(assertId);
  if (!NAME.test(input.name.trim())) throw new Error('PERFORMANCE_CYCLE_NAME_INVALID');
  assertDate(input.startDate); assertDate(input.endDate);
  if (input.endDate < input.startDate) throw new Error('PERFORMANCE_CYCLE_RANGE_INVALID');
  const occurredAt = now.toISOString();
  return Object.freeze({ ...input, name: input.name.trim(), status: 'draft', assignmentCount: 0, version: 1, publishedAt: null, createdAt: occurredAt, updatedAt: occurredAt });
}

export function publishPerformanceCycle(cycle: PerformanceCycle, assignmentCount: number, now: Date): PerformanceCycle {
  if (cycle.status !== 'draft' || !Number.isSafeInteger(assignmentCount) || assignmentCount < 1 || assignmentCount > 10_000) throw new Error('PERFORMANCE_CYCLE_PUBLISH_INVALID');
  const occurredAt = now.toISOString();
  return Object.freeze({ ...cycle, status: 'published', assignmentCount, version: cycle.version + 1, publishedAt: occurredAt, updatedAt: occurredAt });
}

export function createPerformanceAssignment(input: Omit<PerformanceAssignment, 'status' | 'selfScoreBps' | 'managerScoreBps' | 'calibratedScoreBps' | 'finalScoreBps' | 'rating' | 'coefficientBps' | 'selfEvidenceRef' | 'managerEvidenceRef' | 'calibrationReasonCode' | 'appealReasonCode' | 'appealEvidenceRef' | 'version' | 'createdAt' | 'updatedAt'>, now: Date): PerformanceAssignment {
  [input.id, input.tenantId, input.cycleId, input.employeeId, input.employmentId, input.departmentId, input.managerEmployeeId, input.hrbpEmployeeId].forEach(assertId);
  const occurredAt = now.toISOString();
  return Object.freeze({ ...input, status: 'goal_setting', selfScoreBps: null, managerScoreBps: null, calibratedScoreBps: null, finalScoreBps: null, rating: null, coefficientBps: null, selfEvidenceRef: null, managerEvidenceRef: null, calibrationReasonCode: null, appealReasonCode: null, appealEvidenceRef: null, version: 1, createdAt: occurredAt, updatedAt: occurredAt });
}

export function submitSelfReview(value: PerformanceAssignment, scoreBps: number, evidenceRef: string, now: Date): PerformanceAssignment {
  if (!['goal_setting', 'self_review'].includes(value.status)) throw new Error('PERFORMANCE_SELF_REVIEW_STATE_INVALID');
  assertScoreAndEvidence(scoreBps, evidenceRef);
  return advance(value, { status: 'manager_review', selfScoreBps: scoreBps, selfEvidenceRef: evidenceRef }, now);
}

export function submitManagerReview(value: PerformanceAssignment, scoreBps: number, evidenceRef: string, now: Date): PerformanceAssignment {
  if (value.status !== 'manager_review' || value.selfScoreBps === null) throw new Error('PERFORMANCE_MANAGER_REVIEW_STATE_INVALID');
  assertScoreAndEvidence(scoreBps, evidenceRef);
  return advance(value, { status: 'calibration', managerScoreBps: scoreBps, managerEvidenceRef: evidenceRef }, now);
}

export function calibratePerformance(value: PerformanceAssignment, scoreBps: number, reasonCode: string, now: Date): PerformanceAssignment {
  if (value.status !== 'calibration' || value.managerScoreBps === null || !REASON.test(reasonCode)) throw new Error('PERFORMANCE_CALIBRATION_INVALID');
  if (!basisPoints(scoreBps)) throw new Error('PERFORMANCE_SCORE_INVALID');
  return advance(value, { status: 'confirmation', calibratedScoreBps: scoreBps, calibrationReasonCode: reasonCode }, now);
}

export function appealPerformance(value: PerformanceAssignment, reasonCode: string, evidenceRef: string, now: Date): PerformanceAssignment {
  if (value.status !== 'confirmation' || !REASON.test(reasonCode)) throw new Error('PERFORMANCE_APPEAL_INVALID');
  if (!withinBusinessDays(value.updatedAt, now, 5)) throw new Error('PERFORMANCE_APPEAL_WINDOW_EXPIRED');
  assertEvidence(evidenceRef);
  return advance(value, { status: 'appealed', appealReasonCode: reasonCode, appealEvidenceRef: evidenceRef }, now);
}

export function confirmPerformance(value: PerformanceAssignment, now: Date): PerformanceAssignment {
  if (value.status !== 'confirmation' || value.calibratedScoreBps === null) throw new Error('PERFORMANCE_CONFIRM_STATE_INVALID');
  return advance(value, { status: 'confirmed' }, now);
}

export function finalizePerformance(value: PerformanceAssignment, template: PerformanceTemplate, scoreOverride: number | null, reasonCode: string | null, now: Date): PerformanceAssignment {
  if (!['confirmed', 'appealed'].includes(value.status) || value.calibratedScoreBps === null) throw new Error('PERFORMANCE_FINALIZE_STATE_INVALID');
  if (value.status === 'appealed' && (scoreOverride === null || reasonCode === null || !REASON.test(reasonCode))) throw new Error('PERFORMANCE_APPEAL_RESOLUTION_INVALID');
  const score = scoreOverride ?? value.calibratedScoreBps;
  if (!basisPoints(score)) throw new Error('PERFORMANCE_SCORE_INVALID');
  const rating = ratingFor(template, score);
  return advance(value, { status: 'finalized', finalScoreBps: score, rating, coefficientBps: template.coefficients[rating], ...(reasonCode === null ? {} : { calibrationReasonCode: reasonCode }) }, now);
}

function ratingFor(template: PerformanceTemplate, score: number): PerformanceRating {
  if (score >= template.thresholds.S) return 'S';
  if (score >= template.thresholds.A) return 'A';
  if (score >= template.thresholds.B) return 'B';
  if (score >= template.thresholds.C) return 'C';
  return 'D';
}

function advance(value: PerformanceAssignment, patch: Partial<PerformanceAssignment>, now: Date): PerformanceAssignment {
  return Object.freeze({ ...value, ...patch, version: value.version + 1, updatedAt: now.toISOString() });
}
function basisPoints(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 10_000; }
function coefficientBps(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 30_000; }
function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function assertId(value: string): void { if (!ID.test(value)) throw new Error('PERFORMANCE_ID_INVALID'); }
function assertEvidence(value: string): void { if (!ID.test(value)) throw new Error('PERFORMANCE_EVIDENCE_INVALID'); }
function assertScoreAndEvidence(score: number, evidence: string): void { if (!basisPoints(score)) throw new Error('PERFORMANCE_SCORE_INVALID'); assertEvidence(evidence); }
function assertDate(value: string): void {
  if (!DATE.test(value)) throw new Error('PERFORMANCE_DATE_INVALID');
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) throw new Error('PERFORMANCE_DATE_INVALID');
}

function withinBusinessDays(startIso: string, end: Date, limit: number): boolean {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime()) || end.getTime() < start.getTime()) return false;
  let cursor = new Date(start);
  let businessDays = 0;
  while (cursor < end) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) businessDays += 1;
    if (businessDays > limit) return false;
  }
  return true;
}
