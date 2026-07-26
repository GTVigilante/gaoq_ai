import { createHash } from 'node:crypto';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const RULESET_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_MINUTES = 31 * 24 * 60;

export type AttendanceFactType =
  | 'punch_in'
  | 'punch_out'
  | 'shift'
  | 'leave'
  | 'overtime'
  | 'travel';

export interface AttendanceImpact {
  readonly workedMinutes: number;
  readonly leaveMinutes: number;
  readonly overtimeMinutes: number;
  readonly absentMinutes: number;
}

export interface AttendanceShiftDerivation {
  readonly algorithmVersion: 'attendance-shift-v1';
  readonly shiftPlanId: string;
  readonly rulesetVersion: string;
  readonly outcome: 'complete' | 'missing_punch';
  readonly punchProviderCode: string | null;
  readonly punchInFactId: string | null;
  readonly punchOutFactId: string | null;
}

export interface AttendanceSourceFact {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly providerCode: string;
  readonly factType: AttendanceFactType;
  readonly occurredAt: string;
  readonly timeZone: string;
  readonly businessDate: string;
  readonly shiftPlanId?: string | null;
  readonly derivation?: AttendanceShiftDerivation | null | undefined;
  readonly impact: AttendanceImpact;
  readonly sourceObservedAt: string;
  readonly createdAt: string;
}

export interface AttendanceCorrection {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly sourceFactId: string;
  readonly businessDate: string;
  readonly replacementImpact: AttendanceImpact;
  readonly reasonCode: string;
  readonly approvalReferenceType: 'approval_instance' | 'legacy_history';
  readonly approvalInstanceId: string | null;
  readonly approvalHistoryId: string | null;
  readonly approvalEvidenceId: string;
  readonly approvedAt: string;
  readonly createdAt: string;
}

export interface AttendanceDailySummary extends AttendanceImpact {
  readonly businessDate: string;
  readonly sourceFactCount: number;
  readonly correctionCount: number;
  readonly digest: string;
}

export interface AttendanceSourceWatermark {
  readonly providerCode: string;
  readonly throughDate: string;
  readonly lastPolledAt: string;
  readonly completedInboxCount: number;
}

export interface AttendanceMonthlySnapshot extends AttendanceImpact {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly month: string;
  readonly snapshotVersion: number;
  readonly rulesetVersion: string;
  readonly sourceCutoffAt: string;
  readonly sourceProviderCount: number;
  readonly sourceWatermarkDigest: string;
  readonly sourceFactCount: number;
  readonly correctionCount: number;
  readonly dailySummaries: readonly AttendanceDailySummary[];
  readonly snapshotHash: string;
  readonly status: 'active' | 'superseded';
  readonly previousSnapshotId: string | null;
  readonly supersessionEvidenceId: string | null;
  readonly closedAt: string;
}

export class AttendanceDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AttendanceDomainError';
  }
}

export function businessDateAt(occurredAt: string, timeZone: string): string {
  const instant = parseInstant(occurredAt, 'ATTENDANCE_OCCURRED_AT_INVALID');
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function createAttendanceSourceFact(
  input: Omit<AttendanceSourceFact, 'businessDate' | 'createdAt'>,
  now: Date,
): AttendanceSourceFact {
  assertId(input.id, 'ATTENDANCE_FACT_ID_INVALID');
  assertId(input.tenantId, 'ATTENDANCE_TENANT_INVALID');
  assertId(input.employeeId, 'ATTENDANCE_EMPLOYEE_INVALID');
  assertId(input.providerCode, 'ATTENDANCE_PROVIDER_INVALID');
  assertFactType(input.factType);
  if (input.shiftPlanId !== undefined && input.shiftPlanId !== null) {
    assertId(input.shiftPlanId, 'ATTENDANCE_SHIFT_PLAN_REFERENCE_INVALID');
    if (input.factType !== 'shift' || input.providerCode !== 'attendance_rules') {
      fail(
        'ATTENDANCE_SHIFT_DERIVATION_INVALID',
        '只有 Attendance 规则引擎派生的 shift 事实可以绑定班次计划',
      );
    }
    assertShiftDerivation(input.shiftPlanId, input.derivation);
  } else if (input.derivation !== undefined && input.derivation !== null) {
    fail('ATTENDANCE_SHIFT_DERIVATION_INVALID', '班次派生谱系必须绑定班次计划');
  }
  const sourceObservedAt = parseInstant(input.sourceObservedAt, 'ATTENDANCE_SOURCE_TIME_INVALID');
  const occurredAt = parseInstant(input.occurredAt, 'ATTENDANCE_OCCURRED_AT_INVALID');
  if (sourceObservedAt.getTime() < occurredAt.getTime()) {
    fail('ATTENDANCE_SOURCE_TIME_INVALID', '源系统观测时间不得早于事实发生时间');
  }
  const businessDate = businessDateAt(input.occurredAt, input.timeZone);
  assertImpact(input.impact);
  if (!Number.isFinite(now.getTime())) fail('ATTENDANCE_NOW_INVALID', '当前时间非法');
  return Object.freeze({
    ...input,
    derivation: input.derivation === undefined || input.derivation === null
      ? input.derivation
      : Object.freeze({ ...input.derivation }),
    impact: freezeImpact(input.impact),
    businessDate,
    createdAt: now.toISOString(),
  });
}

/** 数据迁移专用：恢复严格历史时间，不伪造在线采集事实。 */
export function restoreAttendanceSourceFactFromMigration(
  input: Omit<AttendanceSourceFact, 'businessDate'>,
  now: Date,
): AttendanceSourceFact {
  const occurredAt = strictMigrationInstant(input.occurredAt);
  const sourceObservedAt = strictMigrationInstant(input.sourceObservedAt);
  const createdAt = strictMigrationInstant(input.createdAt);
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(input.providerCode) ||
    Date.parse(occurredAt) > Date.parse(sourceObservedAt) ||
    Date.parse(sourceObservedAt) > Date.parse(createdAt) ||
    Date.parse(createdAt) > now.getTime() + 5 * 60 * 1_000) {
    fail('ATTENDANCE_MIGRATION_SOURCE_TIMELINE_INVALID', '考勤源事实迁移时间线或来源无效');
  }
  return createAttendanceSourceFact({
    id: input.id, tenantId: input.tenantId, employeeId: input.employeeId,
    providerCode: input.providerCode, factType: input.factType,
    occurredAt, timeZone: input.timeZone, impact: input.impact, sourceObservedAt,
  }, new Date(createdAt));
}

export function createAttendanceCorrection(
  input: Omit<AttendanceCorrection, 'createdAt'>,
  now: Date,
): AttendanceCorrection {
  for (const value of [
    input.id,
    input.tenantId,
    input.employeeId,
    input.sourceFactId,
    input.approvalEvidenceId,
  ]) assertId(value, 'ATTENDANCE_CORRECTION_REFERENCE_INVALID');
  const approvalReferenceId = input.approvalReferenceType === 'approval_instance'
    ? input.approvalInstanceId
    : input.approvalHistoryId;
  if (approvalReferenceId === null ||
    (input.approvalReferenceType === 'approval_instance' && input.approvalHistoryId !== null) ||
    (input.approvalReferenceType === 'legacy_history' && input.approvalInstanceId !== null)) {
    fail('ATTENDANCE_CORRECTION_APPROVAL_REFERENCE_INVALID', '考勤修订审批引用类型或证据绑定无效');
  }
  assertId(approvalReferenceId, 'ATTENDANCE_CORRECTION_REFERENCE_INVALID');
  if (!DATE_PATTERN.test(input.businessDate)) {
    fail('ATTENDANCE_BUSINESS_DATE_INVALID', '考勤业务日期非法');
  }
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.reasonCode)) {
    fail('ATTENDANCE_REASON_INVALID', '考勤修订原因码非法');
  }
  parseInstant(input.approvedAt, 'ATTENDANCE_APPROVED_AT_INVALID');
  assertImpact(input.replacementImpact);
  if (!Number.isFinite(now.getTime())) fail('ATTENDANCE_NOW_INVALID', '当前时间非法');
  return Object.freeze({
    ...input,
    replacementImpact: freezeImpact(input.replacementImpact),
    createdAt: now.toISOString(),
  });
}

/** 数据迁移专用：批准时间来自已迁移审批历史，并保留严格历史落库时间。 */
export function restoreAttendanceCorrectionFromMigration(
  input: AttendanceCorrection,
  now: Date,
): AttendanceCorrection {
  const approvedAt = strictMigrationInstant(input.approvedAt);
  const createdAt = strictMigrationInstant(input.createdAt);
  if (Date.parse(approvedAt) > Date.parse(createdAt) ||
    Date.parse(createdAt) > now.getTime() + 5 * 60 * 1_000) {
    fail('ATTENDANCE_MIGRATION_CORRECTION_TIMELINE_INVALID', '考勤修订迁移时间线无效');
  }
  return createAttendanceCorrection({
    id: input.id, tenantId: input.tenantId, employeeId: input.employeeId,
    sourceFactId: input.sourceFactId, businessDate: input.businessDate,
    replacementImpact: input.replacementImpact, reasonCode: input.reasonCode,
    approvalReferenceType: input.approvalReferenceType,
    approvalInstanceId: input.approvalInstanceId,
    approvalHistoryId: input.approvalHistoryId,
    approvalEvidenceId: input.approvalEvidenceId, approvedAt,
  }, new Date(createdAt));
}

export function closeAttendanceMonth(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly month: string;
  readonly snapshotVersion: number;
  readonly rulesetVersion: string;
  readonly sourceCutoffAt: string;
  readonly sourceWatermarks?: readonly AttendanceSourceWatermark[];
  readonly facts: readonly AttendanceSourceFact[];
  readonly corrections: readonly AttendanceCorrection[];
  readonly previousSnapshotId: string | null;
  readonly supersessionEvidenceId: string | null;
}, now: Date): AttendanceMonthlySnapshot {
  for (const value of [input.id, input.tenantId, input.employeeId]) {
    assertId(value, 'ATTENDANCE_SNAPSHOT_REFERENCE_INVALID');
  }
  if (!MONTH_PATTERN.test(input.month)) fail('ATTENDANCE_MONTH_INVALID', '考勤月份非法');
  if (!Number.isSafeInteger(input.snapshotVersion) || input.snapshotVersion < 1) {
    fail('ATTENDANCE_SNAPSHOT_VERSION_INVALID', '考勤快照版本非法');
  }
  if (!RULESET_PATTERN.test(input.rulesetVersion)) {
    fail('ATTENDANCE_RULESET_INVALID', '考勤规则版本非法');
  }
  const cutoff = parseInstant(input.sourceCutoffAt, 'ATTENDANCE_CUTOFF_INVALID');
  if (!Number.isFinite(now.getTime()) || cutoff.getTime() > now.getTime()) {
    fail('ATTENDANCE_CUTOFF_IN_FUTURE', '源数据截止时间不得晚于关账时间');
  }
  if (input.snapshotVersion === 1) {
    if (input.previousSnapshotId !== null || input.supersessionEvidenceId !== null) {
      fail('ATTENDANCE_INITIAL_SNAPSHOT_CHAIN_INVALID', '首版快照不得包含重开链');
    }
  } else {
    if (input.previousSnapshotId === null || input.supersessionEvidenceId === null) {
      fail('ATTENDANCE_SUPERSESSION_EVIDENCE_REQUIRED', '重开月结必须引用前序快照和审批证据');
    }
    assertId(input.previousSnapshotId, 'ATTENDANCE_PREVIOUS_SNAPSHOT_INVALID');
    assertId(input.supersessionEvidenceId, 'ATTENDANCE_SUPERSESSION_EVIDENCE_INVALID');
  }

  const factById = new Map<string, AttendanceSourceFact>();
  for (const fact of input.facts) {
    assertSnapshotFact(input, fact, cutoff);
    if (factById.has(fact.id)) fail('ATTENDANCE_FACT_DUPLICATE', '考勤源事实重复');
    factById.set(fact.id, fact);
  }
  const correctionByFact = new Map<string, AttendanceCorrection>();
  for (const correction of input.corrections) {
    assertSnapshotCorrection(input, correction, factById, cutoff);
    if (correctionByFact.has(correction.sourceFactId)) {
      fail('ATTENDANCE_CORRECTION_DUPLICATE', '同一源事实存在多个生效修订');
    }
    correctionByFact.set(correction.sourceFactId, correction);
  }
  const sourceWatermarks = normalizeSourceWatermarks(input.sourceWatermarks ?? [], cutoff);
  const sourceWatermarkDigest = hashCanonical(sourceWatermarks);

  const days = new Map<string, {
    impact: AttendanceImpact;
    facts: number;
    corrections: number;
    inputs: string[];
  }>();
  for (const fact of [...input.facts].sort(compareFacts)) {
    const correction = correctionByFact.get(fact.id);
    const impact = correction?.replacementImpact ?? fact.impact;
    const day = days.get(fact.businessDate) ?? {
      impact: zeroImpact(), facts: 0, corrections: 0, inputs: [],
    };
    day.impact = addImpact(day.impact, impact);
    day.facts += 1;
    day.corrections += correction === undefined ? 0 : 1;
    day.inputs.push(hashCanonical([
      fact.id,
      fact.shiftPlanId ?? null,
      fact.derivation ?? null,
      fact.factType,
      fact.occurredAt,
      fact.impact,
      correction === undefined ? null : [
        correction.id,
        correction.replacementImpact,
        correction.approvalReferenceType,
        correction.approvalInstanceId,
        correction.approvalHistoryId,
        correction.approvalEvidenceId,
      ],
    ]));
    days.set(fact.businessDate, day);
  }

  const dailySummaries = Object.freeze([...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([businessDate, day]) => Object.freeze({
      businessDate,
      ...day.impact,
      sourceFactCount: day.facts,
      correctionCount: day.corrections,
      digest: hashCanonical([businessDate, ...day.inputs]),
    })));
  const totals = dailySummaries.reduce<AttendanceImpact>(
    (value, day) => addImpact(value, day),
    zeroImpact(),
  );
  const snapshotHash = hashCanonical({
    tenantId: input.tenantId,
    employeeId: input.employeeId,
    month: input.month,
    snapshotVersion: input.snapshotVersion,
    rulesetVersion: input.rulesetVersion,
    sourceCutoffAt: cutoff.toISOString(),
    sourceWatermarks,
    totals,
    dailySummaries,
    previousSnapshotId: input.previousSnapshotId,
    supersessionEvidenceId: input.supersessionEvidenceId,
  });
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    employeeId: input.employeeId,
    month: input.month,
    snapshotVersion: input.snapshotVersion,
    rulesetVersion: input.rulesetVersion,
    sourceCutoffAt: cutoff.toISOString(),
    sourceProviderCount: sourceWatermarks.length,
    sourceWatermarkDigest,
    ...totals,
    sourceFactCount: input.facts.length,
    correctionCount: input.corrections.length,
    dailySummaries,
    snapshotHash,
    status: 'active',
    previousSnapshotId: input.previousSnapshotId,
    supersessionEvidenceId: input.supersessionEvidenceId,
    closedAt: now.toISOString(),
  });
}

function assertShiftDerivation(
  shiftPlanId: string,
  derivation: AttendanceShiftDerivation | null | undefined,
): void {
  if (derivation === undefined || derivation === null ||
    derivation.algorithmVersion !== 'attendance-shift-v1' ||
    derivation.shiftPlanId !== shiftPlanId ||
    !RULESET_PATTERN.test(derivation.rulesetVersion)) {
    fail('ATTENDANCE_SHIFT_DERIVATION_INVALID', '班次派生事实缺少有效规则谱系');
  }
  for (const id of [derivation.punchInFactId, derivation.punchOutFactId]) {
    if (id !== null) assertId(id, 'ATTENDANCE_SHIFT_DERIVATION_INVALID');
  }
  if (derivation.punchProviderCode !== null) {
    assertId(derivation.punchProviderCode, 'ATTENDANCE_SHIFT_DERIVATION_INVALID');
  }
  const hasPunch = derivation.punchInFactId !== null || derivation.punchOutFactId !== null;
  if ((hasPunch && derivation.punchProviderCode === null) ||
    (!hasPunch && derivation.punchProviderCode !== null) ||
    (derivation.outcome === 'complete' &&
      (derivation.punchProviderCode === null ||
        derivation.punchInFactId === null ||
        derivation.punchOutFactId === null))) {
    fail('ATTENDANCE_SHIFT_DERIVATION_INVALID', '班次派生结果与打卡谱系不一致');
  }
}

function normalizeSourceWatermarks(
  values: readonly AttendanceSourceWatermark[],
  cutoff: Date,
): readonly AttendanceSourceWatermark[] {
  const providers = new Set<string>();
  return Object.freeze([...values]
    .sort((left, right) => left.providerCode.localeCompare(right.providerCode))
    .map((value) => {
      assertId(value.providerCode, 'ATTENDANCE_SOURCE_PROVIDER_INVALID');
      if (providers.has(value.providerCode)) {
        fail('ATTENDANCE_SOURCE_WATERMARK_DUPLICATE', '同一来源存在多个关账水位');
      }
      providers.add(value.providerCode);
      if (!DATE_PATTERN.test(value.throughDate)) {
        fail('ATTENDANCE_SOURCE_WATERMARK_INVALID', '来源水位日期非法');
      }
      const lastPolledAt = parseInstant(
        value.lastPolledAt,
        'ATTENDANCE_SOURCE_WATERMARK_INVALID',
      );
      if (lastPolledAt.getTime() > cutoff.getTime()) {
        fail('ATTENDANCE_SOURCE_WATERMARK_AFTER_CUTOFF', '来源水位晚于关账截止时间');
      }
      if (!Number.isSafeInteger(value.completedInboxCount) ||
        value.completedInboxCount < 0) {
        fail('ATTENDANCE_SOURCE_WATERMARK_INVALID', '来源已处理记录数非法');
      }
      return Object.freeze({
        providerCode: value.providerCode,
        throughDate: value.throughDate,
        lastPolledAt: lastPolledAt.toISOString(),
        completedInboxCount: value.completedInboxCount,
      });
    }));
}

/** 数据迁移专用：使用现有算法重算快照，并保留严格历史关账时间。 */
export function restoreAttendanceMonthFromMigration(
  input: Parameters<typeof closeAttendanceMonth>[0] & { readonly closedAt: string },
  now: Date,
): AttendanceMonthlySnapshot {
  const closedAt = strictMigrationInstant(input.closedAt);
  if (Date.parse(closedAt) > now.getTime() + 5 * 60 * 1_000) {
    fail('ATTENDANCE_MIGRATION_MONTH_TIMELINE_INVALID', '考勤月结迁移关账时间无效');
  }
  const restored = closeAttendanceMonth(input, new Date(closedAt));
  if (restored.closedAt !== closedAt) {
    fail('ATTENDANCE_MIGRATION_MONTH_TIMELINE_INVALID', '考勤月结迁移时间未被完整保留');
  }
  return restored;
}

function assertSnapshotFact(
  snapshot: { readonly tenantId: string; readonly employeeId: string; readonly month: string },
  fact: AttendanceSourceFact,
  cutoff: Date,
): void {
  if (
    fact.tenantId !== snapshot.tenantId ||
    fact.employeeId !== snapshot.employeeId ||
    !fact.businessDate.startsWith(`${snapshot.month}-`)
  ) fail('ATTENDANCE_FACT_OUT_OF_SCOPE', '源事实不属于当前租户、员工或月份');
  if (Date.parse(fact.sourceObservedAt) > cutoff.getTime()) {
    fail('ATTENDANCE_FACT_AFTER_CUTOFF', '源事实晚于关账截止时间');
  }
  if (Date.parse(fact.createdAt) > cutoff.getTime()) {
    fail('ATTENDANCE_FACT_AFTER_CUTOFF', '源事实在 ERP 的落库时间晚于关账截止时间');
  }
  assertImpact(fact.impact);
}

function assertSnapshotCorrection(
  snapshot: { readonly tenantId: string; readonly employeeId: string; readonly month: string },
  correction: AttendanceCorrection,
  facts: ReadonlyMap<string, AttendanceSourceFact>,
  cutoff: Date,
): void {
  const fact = facts.get(correction.sourceFactId);
  if (
    fact === undefined ||
    correction.tenantId !== snapshot.tenantId ||
    correction.employeeId !== snapshot.employeeId ||
    correction.businessDate !== fact.businessDate ||
    !correction.businessDate.startsWith(`${snapshot.month}-`)
  ) fail('ATTENDANCE_CORRECTION_OUT_OF_SCOPE', '修订与源事实、租户、员工或月份不匹配');
  if (Date.parse(correction.approvedAt) > cutoff.getTime()) {
    fail('ATTENDANCE_CORRECTION_AFTER_CUTOFF', '修订审批晚于关账截止时间');
  }
  if (Date.parse(correction.createdAt) > cutoff.getTime()) {
    fail('ATTENDANCE_CORRECTION_AFTER_CUTOFF', '修订在 ERP 的登记时间晚于关账截止时间');
  }
  assertImpact(correction.replacementImpact);
}

function compareFacts(left: AttendanceSourceFact, right: AttendanceSourceFact): number {
  return left.businessDate.localeCompare(right.businessDate) ||
    left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function zeroImpact(): AttendanceImpact {
  return { workedMinutes: 0, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 };
}

function addImpact(left: AttendanceImpact, right: AttendanceImpact): AttendanceImpact {
  const result = {
    workedMinutes: left.workedMinutes + right.workedMinutes,
    leaveMinutes: left.leaveMinutes + right.leaveMinutes,
    overtimeMinutes: left.overtimeMinutes + right.overtimeMinutes,
    absentMinutes: left.absentMinutes + right.absentMinutes,
  };
  assertImpact(result);
  return result;
}

function assertImpact(value: AttendanceImpact): void {
  for (const minute of [
    value.workedMinutes,
    value.leaveMinutes,
    value.overtimeMinutes,
    value.absentMinutes,
  ]) {
    if (!Number.isSafeInteger(minute) || minute < 0 || minute > MAX_MINUTES) {
      fail('ATTENDANCE_MINUTES_INVALID', '考勤分钟数必须为安全非负整数且在月度上限内');
    }
  }
}

function freezeImpact(value: AttendanceImpact): AttendanceImpact {
  return Object.freeze({ ...value });
}

function assertFactType(value: string): void {
  if (!['punch_in', 'punch_out', 'shift', 'leave', 'overtime', 'travel'].includes(value)) {
    fail('ATTENDANCE_FACT_TYPE_INVALID', '考勤事实类型非法');
  }
}

function assertId(value: string, code: string): void {
  if (!ID_PATTERN.test(value)) fail(code, '考勤资源标识非法');
}

function assertTimeZone(value: string): void {
  if (value.length < 1 || value.length > 64) fail('ATTENDANCE_TIME_ZONE_INVALID', 'IANA 时区非法');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date());
  } catch {
    fail('ATTENDANCE_TIME_ZONE_INVALID', 'IANA 时区非法');
  }
}

function parseInstant(value: string, code: string): Date {
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(parsed.getTime())) {
    fail(code, '时间必须为 UTC ISO-8601 instant');
  }
  return parsed;
}

function strictMigrationInstant(value: string): string {
  const parsed = parseInstant(value, 'ATTENDANCE_MIGRATION_SOURCE_TIME_INVALID');
  if (parsed.toISOString() !== value) {
    fail('ATTENDANCE_MIGRATION_SOURCE_TIME_INVALID', '迁移时间必须为毫秒精度 UTC ISO instant');
  }
  return value;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('base64url');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`).join(',')}}`;
}

function fail(code: string, message: string): never {
  throw new AttendanceDomainError(code, message);
}
