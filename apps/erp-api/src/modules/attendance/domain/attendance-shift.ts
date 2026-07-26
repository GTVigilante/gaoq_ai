import {
  AttendanceDomainError,
  businessDateAt,
  type AttendanceImpact,
  type AttendanceSourceFact,
} from './attendance.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RULESET_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_SHIFT_MINUTES = 36 * 60;
const MAX_WINDOW_MINUTES = 6 * 60;

export interface AttendanceShiftPlan {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly providerCode: string;
  readonly planCode: string;
  readonly businessDate: string;
  readonly rulesetVersion: string;
  readonly timeZone: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly breakMinutes: number;
  readonly graceMinutes: number;
  readonly earlyArrivalWindowMinutes: number;
  readonly lateDepartureWindowMinutes: number;
  readonly sourceObservedAt: string;
  readonly createdAt: string;
}

export interface AttendanceShiftEvaluation {
  readonly shiftPlanId: string;
  readonly businessDate: string;
  readonly outcome: 'complete' | 'missing_punch';
  readonly punchProviderCode: string | null;
  readonly punchInFactId: string | null;
  readonly punchOutFactId: string | null;
  readonly impact: AttendanceImpact;
}

export function createAttendanceShiftPlan(
  input: Omit<AttendanceShiftPlan, 'createdAt'>,
  now: Date,
): AttendanceShiftPlan {
  for (const value of [
    input.id,
    input.tenantId,
    input.employeeId,
    input.providerCode,
    input.planCode,
  ]) assertId(value);
  if (!DATE_PATTERN.test(input.businessDate)) {
    fail('ATTENDANCE_SHIFT_BUSINESS_DATE_INVALID', '班次业务日期非法');
  }
  if (!RULESET_PATTERN.test(input.rulesetVersion)) {
    fail('ATTENDANCE_SHIFT_RULESET_INVALID', '班次规则版本非法');
  }
  const start = parseInstant(input.scheduledStartAt);
  const end = parseInstant(input.scheduledEndAt);
  const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (!Number.isSafeInteger(durationMinutes) ||
    durationMinutes < 1 || durationMinutes > MAX_SHIFT_MINUTES) {
    fail('ATTENDANCE_SHIFT_DURATION_INVALID', '班次时长必须为 1 分钟至 36 小时');
  }
  if (businessDateAt(input.scheduledStartAt, input.timeZone) !== input.businessDate) {
    fail('ATTENDANCE_SHIFT_ATTRIBUTION_INVALID', '班次必须归属排班开始时刻所在业务日');
  }
  assertMinute(input.breakMinutes, durationMinutes - 1, 'ATTENDANCE_SHIFT_BREAK_INVALID');
  assertMinute(input.graceMinutes, 120, 'ATTENDANCE_SHIFT_GRACE_INVALID');
  assertMinute(
    input.earlyArrivalWindowMinutes,
    MAX_WINDOW_MINUTES,
    'ATTENDANCE_SHIFT_CAPTURE_WINDOW_INVALID',
  );
  assertMinute(
    input.lateDepartureWindowMinutes,
    MAX_WINDOW_MINUTES,
    'ATTENDANCE_SHIFT_CAPTURE_WINDOW_INVALID',
  );
  const sourceObservedAt = parseInstant(input.sourceObservedAt);
  if (!Number.isFinite(now.getTime()) || sourceObservedAt.getTime() > now.getTime()) {
    fail('ATTENDANCE_SHIFT_SOURCE_TIME_INVALID', '排班来源观测时间不得晚于 ERP 落库时间');
  }
  return Object.freeze({ ...input, createdAt: now.toISOString() });
}

export function assertShiftPlanCaptureWindowAvailable(
  candidate: AttendanceShiftPlan,
  existing: readonly AttendanceShiftPlan[],
): void {
  const candidateWindow = captureWindow(candidate);
  for (const plan of existing) {
    if (plan.id === candidate.id) continue;
    if (plan.tenantId !== candidate.tenantId || plan.employeeId !== candidate.employeeId) {
      fail('ATTENDANCE_SHIFT_PLAN_OUT_OF_SCOPE', '班次重叠检查发现跨租户或跨员工记录');
    }
    const existingWindow = captureWindow(plan);
    if (
      candidateWindow.start <= existingWindow.end &&
      existingWindow.start <= candidateWindow.end
    ) {
      fail(
        'ATTENDANCE_SHIFT_CAPTURE_WINDOW_OVERLAP',
        `班次 ${candidate.planCode} 与 ${plan.planCode} 的打卡捕获窗口重叠`,
      );
    }
  }
}

/**
 * 工时只按计划班次计算；早到和晚退不自动形成加班，缺卡形成整班缺勤，
 * 后续只能通过既有审批修订替换派生 shift 事实。
 */
export function evaluateAttendanceShift(
  plan: AttendanceShiftPlan,
  facts: readonly AttendanceSourceFact[],
  now: Date,
): AttendanceShiftEvaluation {
  const end = parseInstant(plan.scheduledEndAt);
  const window = captureWindow(plan);
  if (!Number.isFinite(now.getTime()) || now.getTime() < window.end) {
    fail('ATTENDANCE_SHIFT_CAPTURE_WINDOW_OPEN', '打卡捕获窗口关闭前不得计算考勤结果');
  }
  const eligible = facts.filter((fact) => {
    if (fact.tenantId !== plan.tenantId || fact.employeeId !== plan.employeeId) {
      fail('ATTENDANCE_SHIFT_FACT_OUT_OF_SCOPE', '班次计算发现跨租户或跨员工打卡');
    }
    const occurredAt = parseInstant(fact.occurredAt).getTime();
    return occurredAt >= window.start && occurredAt <= window.end;
  });
  const punchFacts = eligible.filter(
    (fact) => fact.factType === 'punch_in' || fact.factType === 'punch_out',
  );
  const providerCodes = [...new Set(punchFacts.map((fact) => fact.providerCode))].sort();
  if (providerCodes.length > 1) {
    fail(
      'ATTENDANCE_SHIFT_PUNCH_PROVIDER_AMBIGUOUS',
      '同一班次捕获到多个打卡来源，必须人工确认后再计算',
    );
  }
  const punchProviderCode = providerCodes[0] ?? null;
  const punchIns = punchFacts
    .filter((fact) => fact.factType === 'punch_in')
    .sort(compareFacts);
  const punchOuts = punchFacts
    .filter((fact) => fact.factType === 'punch_out')
    .sort(compareFacts);
  const punchIn = punchIns[0] ?? null;
  const punchOut = punchOuts.at(-1) ?? null;
  const scheduledMinutes = Math.floor(
    (end.getTime() - Date.parse(plan.scheduledStartAt)) / 60_000,
  ) - plan.breakMinutes;
  if (punchIn === null || punchOut === null ||
    Date.parse(punchOut.occurredAt) <= Date.parse(punchIn.occurredAt)) {
    return Object.freeze({
      shiftPlanId: plan.id,
      businessDate: plan.businessDate,
      outcome: 'missing_punch',
      punchProviderCode,
      punchInFactId: punchIn?.id ?? null,
      punchOutFactId: punchOut?.id ?? null,
      impact: Object.freeze({
        workedMinutes: 0,
        leaveMinutes: 0,
        overtimeMinutes: 0,
        absentMinutes: scheduledMinutes,
      }),
    });
  }
  const start = Date.parse(plan.scheduledStartAt);
  const graceMs = plan.graceMinutes * 60_000;
  const rawIn = Date.parse(punchIn.occurredAt);
  const rawOut = Date.parse(punchOut.occurredAt);
  const effectiveIn = rawIn <= start + graceMs ? start : Math.max(start, rawIn);
  const effectiveOut = rawOut >= end.getTime() - graceMs
    ? end.getTime()
    : Math.min(end.getTime(), rawOut);
  const grossMinutes = Math.max(0, Math.floor((effectiveOut - effectiveIn) / 60_000));
  const workedMinutes = Math.max(0, grossMinutes - Math.min(plan.breakMinutes, grossMinutes));
  return Object.freeze({
    shiftPlanId: plan.id,
    businessDate: plan.businessDate,
    outcome: 'complete',
    punchProviderCode,
    punchInFactId: punchIn.id,
    punchOutFactId: punchOut.id,
    impact: Object.freeze({
      workedMinutes,
      leaveMinutes: 0,
      overtimeMinutes: 0,
      absentMinutes: Math.max(0, scheduledMinutes - workedMinutes),
    }),
  });
}

export function shiftPlanRequiredThroughDate(plan: AttendanceShiftPlan): string {
  return businessDateAt(plan.scheduledEndAt, plan.timeZone);
}

function captureWindow(plan: AttendanceShiftPlan): { readonly start: number; readonly end: number } {
  return {
    start: Date.parse(plan.scheduledStartAt) - plan.earlyArrivalWindowMinutes * 60_000,
    end: Date.parse(plan.scheduledEndAt) + plan.lateDepartureWindowMinutes * 60_000,
  };
}

function compareFacts(left: AttendanceSourceFact, right: AttendanceSourceFact): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function parseInstant(value: string): Date {
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(parsed.getTime())) {
    fail('ATTENDANCE_SHIFT_INSTANT_INVALID', '班次时间必须为 UTC ISO-8601 instant');
  }
  return parsed;
}

function assertMinute(value: number, maximum: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(code, '班次分钟配置非法');
  }
}

function assertId(value: string): void {
  if (!ID_PATTERN.test(value)) fail('ATTENDANCE_SHIFT_REFERENCE_INVALID', '班次资源标识非法');
}

function fail(code: string, message: string): never {
  throw new AttendanceDomainError(code, message);
}
