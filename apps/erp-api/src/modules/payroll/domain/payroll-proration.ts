import {
  PayrollCalculationError,
  type PayrollAmountComponent,
  type PayrollCompensationAllocationEvidence,
} from './payroll-calculation.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DAY_MILLISECONDS = 86_400_000;

export interface PayrollAttendanceAdjustmentRates {
  readonly overtimePayMinorPerMinute: number;
  readonly absenceDeductionMinorPerMinute: number;
  readonly unpaidLeaveDeductionMinorPerMinute: number;
}

export interface PayrollCompensationData {
  readonly currency: 'CNY';
  readonly jurisdictionCode: string;
  readonly taxableEarnings: readonly PayrollAmountComponent[];
  readonly nonTaxableEarnings: readonly PayrollAmountComponent[];
  readonly employeeSocialInsuranceMinor: number;
  readonly employeeHousingFundMinor: number;
  readonly specialAdditionalDeductionMinor: number;
  readonly otherPreTaxWithholdingMinor: number;
  readonly postTaxDeductionMinor: number;
  readonly attendanceAdjustment: PayrollAttendanceAdjustmentRates;
}

export interface PayrollCompensationSegmentInput {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileHash: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly data: PayrollCompensationData;
}

export interface ProratedPayrollCompensation {
  readonly currency: 'CNY';
  readonly taxableEarnings: readonly PayrollAmountComponent[];
  readonly nonTaxableEarnings: readonly PayrollAmountComponent[];
  readonly employeeSocialInsuranceMinor: number;
  readonly employeeHousingFundMinor: number;
  readonly specialAdditionalDeductionMinor: number;
  readonly otherPreTaxWithholdingMinor: number;
  readonly postTaxDeductionMinor: number;
  readonly attendanceAdjustment: PayrollAttendanceAdjustmentRates;
  readonly allocations: readonly PayrollCompensationAllocationEvidence[];
}

/**
 * 按自然日对月中薪酬版本进行确定性 HALF_UP 分摊。
 * 输入档案必须恰好覆盖整月且不得重叠；月度考勤缺少逐日金额归属时，跨段费率必须一致。
 */
export function proratePayrollCompensation(
  period: string,
  segments: readonly PayrollCompensationSegmentInput[],
): ProratedPayrollCompensation {
  const { start, end, days } = periodBounds(period);
  if (segments.length < 1 || segments.length > 31) {
    invalid('PAYROLL_COMPENSATION_SEGMENT_COUNT_INVALID', '薪酬分段数量必须为 1 至 31');
  }
  const profileIds = new Set<string>();
  const active = segments.map((segment) => {
    assertSegment(segment);
    if (profileIds.has(segment.profileId)) {
      invalid('PAYROLL_COMPENSATION_SEGMENT_DUPLICATED', '薪酬档案引用不得重复');
    }
    profileIds.add(segment.profileId);
    const from = Math.max(dateOrdinal(segment.effectiveFrom), start);
    const to = Math.min(
      segment.effectiveTo === null ? end : dateOrdinal(segment.effectiveTo),
      end,
    );
    if (from > to) {
      invalid('PAYROLL_COMPENSATION_SEGMENT_NOT_EFFECTIVE', '薪酬档案未在工资期间生效');
    }
    return { segment, from, to };
  }).sort((left, right) => left.from - right.from || left.to - right.to);

  let expectedDay = start;
  for (const item of active) {
    if (item.from < expectedDay) {
      invalid('PAYROLL_COMPENSATION_SEGMENT_OVERLAP', '工资期间内薪酬档案生效区间重叠');
    }
    if (item.from > expectedDay) {
      invalid('PAYROLL_COMPENSATION_SEGMENT_GAP', '工资期间内薪酬档案存在覆盖缺口');
    }
    expectedDay = item.to + DAY_MILLISECONDS;
  }
  if (expectedDay !== end + DAY_MILLISECONDS) {
    invalid('PAYROLL_COMPENSATION_SEGMENT_GAP', '薪酬档案未覆盖完整工资期间');
  }

  const firstRates = required(active[0]).segment.data.attendanceAdjustment;
  if (active.some(({ segment }) =>
    JSON.stringify(segment.data.attendanceAdjustment) !== JSON.stringify(firstRates))) {
    invalid(
      'PAYROLL_ATTENDANCE_RATE_ALLOCATION_REQUIRED',
      '月度考勤快照无法分配到不同薪酬费率，请先生成逐日归属证据',
    );
  }

  const taxable = new Map<string, number>();
  const nonTaxable = new Map<string, number>();
  let employeeSocialInsuranceMinor = 0;
  let employeeHousingFundMinor = 0;
  let specialAdditionalDeductionMinor = 0;
  let otherPreTaxWithholdingMinor = 0;
  let postTaxDeductionMinor = 0;
  const allocations: PayrollCompensationAllocationEvidence[] = [];
  for (const { segment, from, to } of active) {
    const allocatedDays = Math.round((to - from) / DAY_MILLISECONDS) + 1;
    addProratedComponents(taxable, segment.data.taxableEarnings, allocatedDays, days);
    addProratedComponents(nonTaxable, segment.data.nonTaxableEarnings, allocatedDays, days);
    employeeSocialInsuranceMinor = safeAdd(
      employeeSocialInsuranceMinor,
      prorated(segment.data.employeeSocialInsuranceMinor, allocatedDays, days),
    );
    employeeHousingFundMinor = safeAdd(
      employeeHousingFundMinor,
      prorated(segment.data.employeeHousingFundMinor, allocatedDays, days),
    );
    specialAdditionalDeductionMinor = safeAdd(
      specialAdditionalDeductionMinor,
      prorated(segment.data.specialAdditionalDeductionMinor, allocatedDays, days),
    );
    otherPreTaxWithholdingMinor = safeAdd(
      otherPreTaxWithholdingMinor,
      prorated(segment.data.otherPreTaxWithholdingMinor, allocatedDays, days),
    );
    postTaxDeductionMinor = safeAdd(
      postTaxDeductionMinor,
      prorated(segment.data.postTaxDeductionMinor, allocatedDays, days),
    );
    allocations.push(Object.freeze({
      profileId: segment.profileId,
      profileVersion: segment.profileVersion,
      profileHash: segment.profileHash,
      jurisdictionCode: segment.data.jurisdictionCode,
      effectiveFrom: segment.effectiveFrom,
      effectiveTo: segment.effectiveTo,
      allocatedFrom: formatDate(from),
      allocatedTo: formatDate(to),
      allocatedDays,
      periodDays: days,
      allocationMethod: 'CALENDAR_DAY_HALF_UP' as const,
    }));
  }
  return Object.freeze({
    currency: 'CNY' as const,
    taxableEarnings: freezeComponents(taxable),
    nonTaxableEarnings: freezeComponents(nonTaxable),
    employeeSocialInsuranceMinor,
    employeeHousingFundMinor,
    specialAdditionalDeductionMinor,
    otherPreTaxWithholdingMinor,
    postTaxDeductionMinor,
    attendanceAdjustment: Object.freeze({ ...firstRates }),
    allocations: Object.freeze(allocations),
  });
}

function assertSegment(segment: PayrollCompensationSegmentInput): void {
  if (!ID_PATTERN.test(segment.profileId) || !ID_PATTERN.test(segment.data.jurisdictionCode) ||
    !Number.isSafeInteger(segment.profileVersion) || segment.profileVersion < 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(segment.profileHash) ||
    !isCalendarDate(segment.effectiveFrom) ||
    (segment.effectiveTo !== null &&
      (!isCalendarDate(segment.effectiveTo) || segment.effectiveTo < segment.effectiveFrom))) {
    invalid('PAYROLL_COMPENSATION_SEGMENT_INVALID', '薪酬分段引用、生效区间或法域非法');
  }
}

function addProratedComponents(
  target: Map<string, number>,
  components: readonly PayrollAmountComponent[],
  allocatedDays: number,
  periodDays: number,
): void {
  for (const component of components) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(component.code)) {
      invalid('PAYROLL_COMPONENT_CODE_INVALID', '薪酬组件编码非法');
    }
    const amount = prorated(component.amountMinor, allocatedDays, periodDays);
    target.set(component.code, safeAdd(target.get(component.code) ?? 0, amount));
  }
}

function freezeComponents(values: ReadonlyMap<string, number>): readonly PayrollAmountComponent[] {
  return Object.freeze([...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, amountMinor]) => Object.freeze({ code, amountMinor })));
}

function prorated(amount: number, allocatedDays: number, periodDays: number): number {
  assertMinor(amount);
  const numerator = BigInt(amount) * BigInt(allocatedDays);
  const quotient = numerator / BigInt(periodDays);
  const remainder = numerator % BigInt(periodDays);
  return toSafeMinor(quotient + (remainder * 2n >= BigInt(periodDays) ? 1n : 0n));
}

function periodBounds(period: string): { readonly start: number; readonly end: number; readonly days: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    invalid('PAYROLL_PERIOD_INVALID', '工资期间必须为 YYYY-MM');
  }
  const [yearText, monthText] = period.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const start = Date.UTC(year, month - 1, 1);
  const end = Date.UTC(year, month, 0);
  return Object.freeze({ start, end, days: new Date(end).getUTCDate() });
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const ordinal = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ordinal) && formatDate(ordinal) === value;
}

function dateOrdinal(value: string): number {
  if (!isCalendarDate(value)) invalid('PAYROLL_DATE_INVALID', '薪酬生效日期非法');
  return Date.parse(`${value}T00:00:00.000Z`);
}

function formatDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function assertMinor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid('PAYROLL_AMOUNT_INVALID', '薪酬金额必须是非负安全整数');
  }
}

function safeAdd(left: number, right: number): number {
  return toSafeMinor(BigInt(left) + BigInt(right));
}

function toSafeMinor(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid('PAYROLL_AMOUNT_OVERFLOW', '薪酬金额超出安全整数范围');
  }
  return Number(value);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) invalid('PAYROLL_COMPENSATION_SEGMENT_REQUIRED', '薪酬分段不能为空');
  return value;
}

function invalid(code: string, message: string): never {
  throw new PayrollCalculationError(code, message);
}
