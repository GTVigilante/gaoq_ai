import { createHash } from 'node:crypto';

import type { Employment } from '../../org/domain/employment.js';
import type {
  AttendanceCorrection,
  AttendanceDailySummary,
  AttendanceImpact,
  AttendanceSourceFact,
} from './attendance.js';
import { AttendanceDomainError } from './attendance.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const SHIFT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_MONTH_MINUTES = 31 * 24 * 60;
const MAX_CROSS_MIDNIGHT_GRACE_MINUTES = 360;

export type AttendanceProviderCode = 'dingtalk' | 'feishu';

export interface AttendanceShiftRule {
  readonly id: string;
  readonly tenantId: string;
  readonly rulesetVersion: string;
  readonly shiftCode: string;
  readonly timeZone: string;
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly workdays: readonly number[];
  readonly plannedMinutes: number;
  readonly lateGraceMinutes: number;
  readonly earlyLeaveGraceMinutes: number;
  readonly crossMidnightPunchOutGraceMinutes: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly governanceEvidenceId: string;
  readonly evidenceChecksum: string;
  readonly createdAt: string;
}

export interface AttendanceShiftAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly shiftRuleId: string;
  readonly providerCode: AttendanceProviderCode;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly governanceEvidenceId: string;
  readonly evidenceChecksum: string;
  readonly createdAt: string;
}

export interface AttendanceProviderCoverage {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly providerCode: AttendanceProviderCode;
  readonly providerStateId: string;
  readonly providerMappingId: string;
  readonly month: string;
  readonly throughBusinessDate: string;
  readonly sourceCutoffAt: string;
  readonly evidenceChecksum: string;
  readonly createdAt: string;
}

export interface AttendanceRuleEvaluation {
  readonly facts: readonly AttendanceSourceFact[];
  readonly corrections: readonly AttendanceCorrection[];
  readonly dailySummaries: readonly AttendanceDailySummary[];
}

export function createAttendanceShiftRule(
  input: Omit<AttendanceShiftRule, 'createdAt'>,
  now: Date,
): AttendanceShiftRule {
  for (const value of [
    input.id,
    input.tenantId,
    input.governanceEvidenceId,
  ]) assertId(value, 'ATTENDANCE_SHIFT_RULE_REFERENCE_INVALID');
  if (!VERSION_PATTERN.test(input.rulesetVersion)) {
    fail('ATTENDANCE_RULESET_INVALID', '考勤规则集版本非法');
  }
  if (!SHIFT_CODE_PATTERN.test(input.shiftCode)) {
    fail('ATTENDANCE_SHIFT_CODE_INVALID', '班次代码非法');
  }
  assertTimeZone(input.timeZone);
  const start = localTimeMinutes(input.startLocalTime);
  const end = localTimeMinutes(input.endLocalTime);
  const span = end > start ? end - start : 24 * 60 - start + end;
  const workdays = [...new Set(input.workdays)].sort((left, right) => left - right);
  if (
    workdays.length !== input.workdays.length ||
    workdays.length === 0 ||
    workdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  ) fail('ATTENDANCE_SHIFT_WORKDAYS_INVALID', '班次工作日必须为不重复的 ISO 星期 1..7');
  assertMinuteRange(input.plannedMinutes, 1, span, 'ATTENDANCE_SHIFT_PLANNED_MINUTES_INVALID');
  assertMinuteRange(input.lateGraceMinutes, 0, 180, 'ATTENDANCE_SHIFT_GRACE_INVALID');
  assertMinuteRange(input.earlyLeaveGraceMinutes, 0, 180, 'ATTENDANCE_SHIFT_GRACE_INVALID');
  assertMinuteRange(
    input.crossMidnightPunchOutGraceMinutes,
    0,
    MAX_CROSS_MIDNIGHT_GRACE_MINUTES,
    'ATTENDANCE_SHIFT_CROSS_MIDNIGHT_GRACE_INVALID',
  );
  if (end > start && input.crossMidnightPunchOutGraceMinutes !== 0) {
    fail('ATTENDANCE_SHIFT_CROSS_MIDNIGHT_GRACE_INVALID', '非跨天班次不得设置跨天签退宽限');
  }
  const effectiveFrom = assertDate(input.effectiveFrom, 'ATTENDANCE_SHIFT_EFFECTIVE_DATE_INVALID');
  const effectiveTo = input.effectiveTo === null
    ? null
    : assertDate(input.effectiveTo, 'ATTENDANCE_SHIFT_EFFECTIVE_DATE_INVALID');
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    fail('ATTENDANCE_SHIFT_EFFECTIVE_DATE_INVALID', '班次失效日期不得早于生效日期');
  }
  assertHash(input.evidenceChecksum, 'ATTENDANCE_SHIFT_EVIDENCE_INVALID');
  assertNow(now);
  return Object.freeze({
    ...input,
    workdays: Object.freeze(workdays),
    effectiveFrom,
    effectiveTo,
    createdAt: now.toISOString(),
  });
}

export function createAttendanceShiftAssignment(
  input: Omit<AttendanceShiftAssignment, 'createdAt'>,
  now: Date,
): AttendanceShiftAssignment {
  for (const value of [
    input.id,
    input.tenantId,
    input.employeeId,
    input.shiftRuleId,
    input.governanceEvidenceId,
  ]) assertId(value, 'ATTENDANCE_SHIFT_ASSIGNMENT_REFERENCE_INVALID');
  if (input.providerCode !== 'dingtalk' && input.providerCode !== 'feishu') {
    fail('ATTENDANCE_SHIFT_PROVIDER_INVALID', '班次来源 Provider 非法');
  }
  const effectiveFrom = assertDate(
    input.effectiveFrom,
    'ATTENDANCE_SHIFT_ASSIGNMENT_DATE_INVALID',
  );
  const effectiveTo = input.effectiveTo === null
    ? null
    : assertDate(input.effectiveTo, 'ATTENDANCE_SHIFT_ASSIGNMENT_DATE_INVALID');
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    fail('ATTENDANCE_SHIFT_ASSIGNMENT_DATE_INVALID', '排班失效日期不得早于生效日期');
  }
  assertHash(input.evidenceChecksum, 'ATTENDANCE_SHIFT_ASSIGNMENT_EVIDENCE_INVALID');
  assertNow(now);
  return Object.freeze({ ...input, effectiveFrom, effectiveTo, createdAt: now.toISOString() });
}

export function createAttendanceProviderCoverage(
  input: Omit<AttendanceProviderCoverage, 'evidenceChecksum' | 'createdAt'>,
  now: Date,
): AttendanceProviderCoverage {
  for (const value of [
    input.id,
    input.tenantId,
    input.employeeId,
    input.providerStateId,
    input.providerMappingId,
  ]) assertId(value, 'ATTENDANCE_PROVIDER_COVERAGE_REFERENCE_INVALID');
  if (input.providerCode !== 'dingtalk' && input.providerCode !== 'feishu') {
    fail('ATTENDANCE_PROVIDER_COVERAGE_PROVIDER_INVALID', '考勤覆盖证明 Provider 非法');
  }
  if (!MONTH_PATTERN.test(input.month)) {
    fail('ATTENDANCE_PROVIDER_COVERAGE_MONTH_INVALID', '考勤覆盖证明月份非法');
  }
  const throughBusinessDate = assertDate(
    input.throughBusinessDate,
    'ATTENDANCE_PROVIDER_COVERAGE_DATE_INVALID',
  );
  const sourceCutoffAt = strictInstant(
    input.sourceCutoffAt,
    'ATTENDANCE_PROVIDER_COVERAGE_CUTOFF_INVALID',
  );
  assertNow(now);
  if (Date.parse(sourceCutoffAt) > now.getTime()) {
    fail('ATTENDANCE_PROVIDER_COVERAGE_CUTOFF_INVALID', '覆盖证明截止时间不得位于未来');
  }
  const evidenceChecksum = hashCanonical({
    tenantId: input.tenantId,
    employeeId: input.employeeId,
    providerCode: input.providerCode,
    providerStateId: input.providerStateId,
    providerMappingId: input.providerMappingId,
    month: input.month,
    throughBusinessDate,
    sourceCutoffAt,
  });
  return Object.freeze({
    ...input,
    throughBusinessDate,
    sourceCutoffAt,
    evidenceChecksum,
    createdAt: now.toISOString(),
  });
}

/**
 * 使用权威劳动关系、排班、规则与 Provider 覆盖证明推导月结输入。
 * 原始事实保持不可变；跨天归属仅存在于本次快照计算与摘要哈希中。
 */
export function evaluateAttendanceMonth(input: {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly month: string;
  readonly rulesetVersion: string;
  readonly sourceCutoffAt: string;
  readonly employments: readonly Employment[];
  readonly rules: readonly AttendanceShiftRule[];
  readonly assignments: readonly AttendanceShiftAssignment[];
  readonly coverages: readonly AttendanceProviderCoverage[];
  readonly facts: readonly AttendanceSourceFact[];
  readonly corrections: readonly AttendanceCorrection[];
}): AttendanceRuleEvaluation {
  assertId(input.tenantId, 'ATTENDANCE_TENANT_INVALID');
  assertId(input.employeeId, 'ATTENDANCE_EMPLOYEE_INVALID');
  if (!MONTH_PATTERN.test(input.month)) fail('ATTENDANCE_MONTH_INVALID', '考勤月份非法');
  if (!VERSION_PATTERN.test(input.rulesetVersion)) {
    fail('ATTENDANCE_RULESET_INVALID', '考勤规则集版本非法');
  }
  const cutoff = strictInstant(input.sourceCutoffAt, 'ATTENDANCE_CUTOFF_INVALID');
  const monthStart = `${input.month}-01`;
  const monthEnd = endOfMonth(input.month);
  const rules = new Map(input.rules.map((rule) => [rule.id, rule]));
  if (rules.size !== input.rules.length) {
    fail('ATTENDANCE_SHIFT_RULE_DUPLICATE', '班次规则重复');
  }
  assertCoverage(input, monthEnd, cutoff);
  const correctionByFact = new Map<string, AttendanceCorrection>();
  for (const correction of input.corrections) {
    if (correctionByFact.has(correction.sourceFactId)) {
      fail('ATTENDANCE_CORRECTION_DUPLICATE', '同一源事实存在多个生效修订');
    }
    correctionByFact.set(correction.sourceFactId, correction);
  }

  const dayPlans = new Map<string, DayPlan>();
  for (const businessDate of datesBetween(monthStart, monthEnd)) {
    const employment = uniqueCovering(
      input.employments,
      businessDate,
      'ATTENDANCE_EMPLOYMENT_OVERLAP',
    );
    const assignment = uniqueCovering(
      input.assignments,
      businessDate,
      'ATTENDANCE_SHIFT_ASSIGNMENT_OVERLAP',
    );
    if (employment === null && assignment !== null) {
      fail('ATTENDANCE_SHIFT_OUTSIDE_EMPLOYMENT', '排班超出劳动关系有效区间');
    }
    if (employment === null) continue;
    if (employment.tenantId !== input.tenantId || employment.employeeId !== input.employeeId) {
      fail('ATTENDANCE_EMPLOYMENT_OUT_OF_SCOPE', '劳动关系不属于当前租户或员工');
    }
    if (assignment === null) {
      fail('ATTENDANCE_SHIFT_ASSIGNMENT_MISSING', '劳动关系有效日期缺少权威排班');
    }
    if (assignment.tenantId !== input.tenantId || assignment.employeeId !== input.employeeId) {
      fail('ATTENDANCE_SHIFT_ASSIGNMENT_OUT_OF_SCOPE', '排班不属于当前租户或员工');
    }
    const rule = rules.get(assignment.shiftRuleId);
    if (rule === undefined || rule.tenantId !== input.tenantId) {
      fail('ATTENDANCE_SHIFT_RULE_NOT_FOUND', '排班引用的班次规则不存在');
    }
    if (
      rule.rulesetVersion !== input.rulesetVersion ||
      businessDate < rule.effectiveFrom ||
      (rule.effectiveTo !== null && businessDate > rule.effectiveTo)
    ) fail('ATTENDANCE_RULESET_BINDING_MISMATCH', '班次规则版本或有效区间与月结不匹配');
    if (assignment.providerCode !== requiredCoverageProvider(
      input.coverages,
      assignment,
      input.month,
      cutoff,
      monthEnd,
    )) fail('ATTENDANCE_PROVIDER_COVERAGE_MISSING', '排班来源缺少完整 Provider 覆盖证明');
    dayPlans.set(businessDate, {
      employment,
      assignment,
      rule,
      workday: rule.workdays.includes(isoWeekday(businessDate)),
    });
  }

  const evaluatedFacts = new Map<string, AttendanceSourceFact[]>();
  const includedFacts: AttendanceSourceFact[] = [];
  const includedCorrections: AttendanceCorrection[] = [];
  for (const fact of input.facts) {
    if (fact.tenantId !== input.tenantId || fact.employeeId !== input.employeeId) {
      fail('ATTENDANCE_FACT_OUT_OF_SCOPE', '源事实不属于当前租户或员工');
    }
    if (
      Date.parse(fact.sourceObservedAt) > Date.parse(cutoff) ||
      Date.parse(fact.createdAt) > Date.parse(cutoff)
    ) fail('ATTENDANCE_FACT_AFTER_CUTOFF', '源事实晚于月结截止时间');
    const effectiveDate = effectiveBusinessDate(fact, dayPlans);
    if (effectiveDate < monthStart || effectiveDate > monthEnd) continue;
    const plan = dayPlans.get(effectiveDate);
    if (plan === undefined) {
      fail('ATTENDANCE_FACT_OUTSIDE_EMPLOYMENT', '源事实不在劳动关系有效日期内');
    }
    if (fact.timeZone !== plan.rule.timeZone) {
      fail('ATTENDANCE_FACT_TIME_ZONE_MISMATCH', '源事实时区与权威班次不一致');
    }
    const normalized = Object.freeze({ ...fact, businessDate: effectiveDate });
    includedFacts.push(normalized);
    const values = evaluatedFacts.get(effectiveDate) ?? [];
    values.push(normalized);
    evaluatedFacts.set(effectiveDate, values);
    const correction = correctionByFact.get(fact.id);
    if (correction !== undefined) {
      if (
        correction.tenantId !== input.tenantId ||
        correction.employeeId !== input.employeeId ||
        Date.parse(correction.approvedAt) > Date.parse(cutoff) ||
        Date.parse(correction.createdAt) > Date.parse(cutoff)
      ) fail('ATTENDANCE_CORRECTION_OUT_OF_SCOPE', '修订与租户、员工或截止时间不匹配');
      includedCorrections.push(Object.freeze({ ...correction, businessDate: effectiveDate }));
    }
  }

  const dailySummaries = Object.freeze([...dayPlans.entries()].map(([businessDate, plan]) =>
    evaluateDay(
      businessDate,
      plan,
      evaluatedFacts.get(businessDate) ?? [],
      correctionByFact,
    )));
  return Object.freeze({
    facts: Object.freeze(includedFacts),
    corrections: Object.freeze(includedCorrections),
    dailySummaries,
  });
}

interface DayPlan {
  readonly employment: Employment;
  readonly assignment: AttendanceShiftAssignment;
  readonly rule: AttendanceShiftRule;
  readonly workday: boolean;
}

function evaluateDay(
  businessDate: string,
  plan: DayPlan,
  facts: readonly AttendanceSourceFact[],
  corrections: ReadonlyMap<string, AttendanceCorrection>,
): AttendanceDailySummary {
  const ordered = [...facts].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  let impact = zeroImpact();
  const punchFacts: AttendanceSourceFact[] = [];
  const digestInputs: unknown[] = [
    plan.employment.id,
    plan.employment.version,
    plan.assignment.id,
    plan.assignment.evidenceChecksum,
    plan.rule.id,
    plan.rule.evidenceChecksum,
  ];
  let correctionCount = 0;
  let correctedPunch = false;
  for (const fact of ordered) {
    const correction = corrections.get(fact.id);
    if (correction !== undefined) {
      if (fact.factType === 'punch_in' || fact.factType === 'punch_out') {
        correctedPunch = true;
      }
      impact = addImpact(impact, correction.replacementImpact);
      correctionCount += 1;
      digestInputs.push([
        fact.id,
        fact.factType,
        fact.occurredAt,
        correction.id,
        correction.replacementImpact,
        correction.approvalEvidenceId,
      ]);
      continue;
    }
    if (fact.factType === 'punch_in' || fact.factType === 'punch_out') {
      punchFacts.push(fact);
      digestInputs.push([fact.id, fact.factType, fact.occurredAt]);
      continue;
    }
    impact = addImpact(impact, fact.impact);
    digestInputs.push([fact.id, fact.factType, fact.occurredAt, fact.impact]);
  }
  if (!correctedPunch && !plan.workday && punchFacts.length > 0) {
    fail('ATTENDANCE_OFF_DAY_PUNCH_REQUIRES_APPROVAL', '非工作日打卡必须通过加班或修订审批');
  }
  if (!correctedPunch && plan.workday) {
    impact = addImpact(impact, evaluatePunches(businessDate, plan.rule, punchFacts));
  }
  return Object.freeze({
    businessDate,
    ...impact,
    sourceFactCount: facts.length,
    correctionCount,
    digest: hashCanonical([businessDate, ...digestInputs, impact]),
  });
}

function evaluatePunches(
  businessDate: string,
  rule: AttendanceShiftRule,
  facts: readonly AttendanceSourceFact[],
): AttendanceImpact {
  if (facts.length === 0) {
    return { workedMinutes: 0, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: rule.plannedMinutes };
  }
  if (facts.length % 2 !== 0) {
    fail('ATTENDANCE_PUNCH_SEQUENCE_INCOMPLETE', '上下班打卡未成对，必须先完成修订审批');
  }
  let workedMinutes = 0;
  for (let index = 0; index < facts.length; index += 2) {
    const punchIn = facts[index];
    const punchOut = facts[index + 1];
    if (punchIn?.factType !== 'punch_in' || punchOut?.factType !== 'punch_out') {
      fail('ATTENDANCE_PUNCH_SEQUENCE_INVALID', '上下班打卡顺序非法');
    }
    const elapsed = (Date.parse(punchOut.occurredAt) - Date.parse(punchIn.occurredAt)) / 60_000;
    if (!Number.isSafeInteger(elapsed) || elapsed <= 0 || elapsed > 24 * 60) {
      fail('ATTENDANCE_PUNCH_DURATION_INVALID', '上下班打卡时长非法');
    }
    workedMinutes += elapsed;
  }
  const first = facts[0]!;
  const last = facts.at(-1)!;
  const start = localTimeMinutes(rule.startLocalTime);
  const end = localTimeMinutes(rule.endLocalTime);
  const crossMidnight = end <= start;
  const firstMinute = localMinuteAt(first.occurredAt, rule.timeZone);
  const lastDate = localDateAt(last.occurredAt, rule.timeZone);
  const lastMinute = localMinuteAt(last.occurredAt, rule.timeZone) +
    (lastDate > businessDate ? 24 * 60 : 0);
  const expectedEnd = end + (crossMidnight ? 24 * 60 : 0);
  const late = Math.max(0, firstMinute - start - rule.lateGraceMinutes);
  const early = Math.max(0, expectedEnd - lastMinute - rule.earlyLeaveGraceMinutes);
  const absentMinutes = Math.min(rule.plannedMinutes, late + early);
  return {
    workedMinutes: Math.min(workedMinutes, rule.plannedMinutes),
    leaveMinutes: 0,
    overtimeMinutes: 0,
    absentMinutes,
  };
}

function effectiveBusinessDate(
  fact: AttendanceSourceFact,
  plans: ReadonlyMap<string, DayPlan>,
): string {
  if (fact.factType !== 'punch_out') return fact.businessDate;
  const previousDate = shiftDate(fact.businessDate, -1);
  const previousPlan = plans.get(previousDate);
  if (previousPlan === undefined) return fact.businessDate;
  const start = localTimeMinutes(previousPlan.rule.startLocalTime);
  const end = localTimeMinutes(previousPlan.rule.endLocalTime);
  if (end > start) return fact.businessDate;
  const localDate = localDateAt(fact.occurredAt, previousPlan.rule.timeZone);
  const localMinute = localMinuteAt(fact.occurredAt, previousPlan.rule.timeZone);
  return localDate === fact.businessDate &&
    localMinute <= end + previousPlan.rule.crossMidnightPunchOutGraceMinutes
    ? previousDate
    : fact.businessDate;
}

function assertCoverage(
  input: Parameters<typeof evaluateAttendanceMonth>[0],
  monthEnd: string,
  cutoff: string,
): void {
  for (const coverage of input.coverages) {
    if (
      coverage.tenantId !== input.tenantId ||
      coverage.employeeId !== input.employeeId ||
      coverage.month !== input.month ||
      coverage.throughBusinessDate < monthEnd ||
      Date.parse(coverage.sourceCutoffAt) > Date.parse(cutoff)
    ) fail('ATTENDANCE_PROVIDER_COVERAGE_INVALID', 'Provider 覆盖证明与月结范围不匹配');
    const expected = createAttendanceProviderCoverage({
      id: coverage.id,
      tenantId: coverage.tenantId,
      employeeId: coverage.employeeId,
      providerCode: coverage.providerCode,
      providerStateId: coverage.providerStateId,
      providerMappingId: coverage.providerMappingId,
      month: coverage.month,
      throughBusinessDate: coverage.throughBusinessDate,
      sourceCutoffAt: coverage.sourceCutoffAt,
    }, new Date(coverage.createdAt));
    if (expected.evidenceChecksum !== coverage.evidenceChecksum) {
      fail('ATTENDANCE_PROVIDER_COVERAGE_TAMPERED', 'Provider 覆盖证明摘要不一致');
    }
  }
}

function requiredCoverageProvider(
  coverages: readonly AttendanceProviderCoverage[],
  assignment: AttendanceShiftAssignment,
  month: string,
  cutoff: string,
  monthEnd: string,
): AttendanceProviderCode | null {
  const candidates = coverages.filter((coverage) =>
    coverage.employeeId === assignment.employeeId &&
    coverage.providerCode === assignment.providerCode &&
    coverage.month === month &&
    coverage.throughBusinessDate >= monthEnd &&
    Date.parse(coverage.sourceCutoffAt) <= Date.parse(cutoff));
  return candidates.length === 0 ? null : assignment.providerCode;
}

function uniqueCovering<T extends { readonly effectiveFrom: string; readonly effectiveTo: string | null }>(
  values: readonly T[],
  date: string,
  overlapCode: string,
): T | null {
  const matches = values.filter((value) =>
    value.effectiveFrom <= date && (value.effectiveTo === null || value.effectiveTo >= date));
  if (matches.length > 1) fail(overlapCode, '有效区间存在重叠');
  return matches[0] ?? null;
}

function datesBetween(from: string, to: string): readonly string[] {
  const dates: string[] = [];
  let current = from;
  while (current <= to) {
    dates.push(current);
    current = shiftDate(current, 1);
  }
  return dates;
}

function endOfMonth(month: string): string {
  const [yearValue, monthValue] = month.split('-');
  const year = Number(yearValue);
  const monthIndex = Number(monthValue);
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

function shiftDate(value: string, days: number): string {
  const instant = new Date(`${value}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function isoWeekday(value: string): number {
  const day = new Date(`${value}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function localDateAt(value: string, timeZone: string): string {
  const parts = localParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localMinuteAt(value: string, timeZone: string): number {
  const parts = localParts(value, timeZone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function localParts(value: string, timeZone: string): Record<string, string> {
  const instant = new Date(strictInstant(value, 'ATTENDANCE_OCCURRED_AT_INVALID'));
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function localTimeMinutes(value: string): number {
  if (!LOCAL_TIME_PATTERN.test(value)) {
    fail('ATTENDANCE_SHIFT_LOCAL_TIME_INVALID', '班次时间必须为 HH:mm');
  }
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

function addImpact(left: AttendanceImpact, right: AttendanceImpact): AttendanceImpact {
  const result = {
    workedMinutes: left.workedMinutes + right.workedMinutes,
    leaveMinutes: left.leaveMinutes + right.leaveMinutes,
    overtimeMinutes: left.overtimeMinutes + right.overtimeMinutes,
    absentMinutes: left.absentMinutes + right.absentMinutes,
  };
  for (const minute of Object.values(result)) {
    if (!Number.isSafeInteger(minute) || minute < 0 || minute > MAX_MONTH_MINUTES) {
      fail('ATTENDANCE_MINUTES_INVALID', '考勤分钟数超出月度安全范围');
    }
  }
  return result;
}

function zeroImpact(): AttendanceImpact {
  return { workedMinutes: 0, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 };
}

function assertDate(value: string, code: string): string {
  if (!DATE_PATTERN.test(value)) fail(code, '日期必须为 YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(code, '日期非法');
  }
  return value;
}

function strictInstant(value: string, code: string): string {
  const parsed = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) fail(code, '时间必须为毫秒精度 UTC ISO instant');
  return value;
}

function assertTimeZone(value: string): void {
  if (value.length < 1 || value.length > 64) {
    fail('ATTENDANCE_TIME_ZONE_INVALID', 'IANA 时区非法');
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date());
  } catch {
    fail('ATTENDANCE_TIME_ZONE_INVALID', 'IANA 时区非法');
  }
}

function assertMinuteRange(value: number, minimum: number, maximum: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, '分钟数超出允许范围');
  }
}

function assertHash(value: string, code: string): void {
  if (!HASH_PATTERN.test(value)) fail(code, '证据摘要必须为 SHA-256 base64url');
}

function assertId(value: string, code: string): void {
  if (!ID_PATTERN.test(value)) fail(code, '资源标识非法');
}

function assertNow(now: Date): void {
  if (!Number.isFinite(now.getTime())) fail('ATTENDANCE_NOW_INVALID', '当前时间非法');
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('base64url');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) =>
    `${JSON.stringify(key)}:${canonicalize(nested)}`).join(',')}}`;
}

function fail(code: string, message: string): never {
  throw new AttendanceDomainError(code, message);
}
