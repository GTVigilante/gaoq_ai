import { describe, expect, it } from 'vitest';

import {
  PayrollCalculationError,
  proratePayrollCompensation,
  type PayrollCompensationSegmentInput,
} from './index.js';

const hash = 'h'.repeat(43);

function segment(
  profileId: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  amountMinor: number,
  jurisdictionCode = 'CN-SH',
): PayrollCompensationSegmentInput {
  return {
    profileId,
    profileVersion: profileId === 'profile-1' ? 1 : 2,
    profileHash: hash,
    effectiveFrom,
    effectiveTo,
    data: {
      currency: 'CNY',
      jurisdictionCode,
      taxableEarnings: [{ code: 'BASE', amountMinor }],
      nonTaxableEarnings: [],
      employeeSocialInsuranceMinor: amountMinor / 10,
      employeeHousingFundMinor: 0,
      specialAdditionalDeductionMinor: 0,
      otherPreTaxWithholdingMinor: 0,
      postTaxDeductionMinor: 0,
      attendanceAdjustment: {
        overtimePayMinorPerMinute: 10,
        absenceDeductionMinorPerMinute: 5,
        unpaidLeaveDeductionMinorPerMinute: 5,
      },
    },
  };
}

describe('月中薪酬与跨法域分摊', () => {
  it('按自然日 HALF_UP 合并月中两个薪酬版本并冻结法域证据', () => {
    const result = proratePayrollCompensation('2026-07', [
      segment('profile-1', '2026-01-01', '2026-07-15', 310_000),
      segment('profile-2', '2026-07-16', null, 620_000, 'CN-BJ'),
    ]);

    expect(result.taxableEarnings).toEqual([{ code: 'BASE', amountMinor: 470_000 }]);
    expect(result.employeeSocialInsuranceMinor).toBe(47_000);
    expect(result.allocations).toEqual([
      expect.objectContaining({
        profileId: 'profile-1', jurisdictionCode: 'CN-SH',
        allocatedFrom: '2026-07-01', allocatedTo: '2026-07-15',
        allocatedDays: 15, periodDays: 31, allocationMethod: 'CALENDAR_DAY_HALF_UP',
      }),
      expect.objectContaining({
        profileId: 'profile-2', jurisdictionCode: 'CN-BJ',
        allocatedFrom: '2026-07-16', allocatedTo: '2026-07-31',
        allocatedDays: 16, periodDays: 31, allocationMethod: 'CALENDAR_DAY_HALF_UP',
      }),
    ]);
  });

  it.each([
    {
      expected: 'PAYROLL_COMPENSATION_SEGMENT_GAP',
      values: [
        segment('profile-1', '2026-01-01', '2026-07-14', 310_000),
        segment('profile-2', '2026-07-16', null, 620_000),
      ],
    },
    {
      expected: 'PAYROLL_COMPENSATION_SEGMENT_OVERLAP',
      values: [
        segment('profile-1', '2026-01-01', '2026-07-16', 310_000),
        segment('profile-2', '2026-07-16', null, 620_000),
      ],
    },
  ])('拒绝工资期间覆盖缺口或重叠：$expected', ({ expected, values }) => {
    expect(() => proratePayrollCompensation('2026-07', values))
      .toThrowError(expect.objectContaining({ code: expected }));
  });

  it('月度考勤无法跨不同费率分段时拒绝猜算', () => {
    const second = segment('profile-2', '2026-07-16', null, 620_000);
    const changed = {
      ...second,
      data: {
        ...second.data,
        attendanceAdjustment: {
          ...second.data.attendanceAdjustment,
          overtimePayMinorPerMinute: 20,
        },
      },
    };
    try {
      proratePayrollCompensation('2026-07', [
        segment('profile-1', '2026-01-01', '2026-07-15', 310_000),
        changed,
      ]);
      throw new Error('预期分摊失败');
    } catch (error) {
      expect(error).toBeInstanceOf(PayrollCalculationError);
      expect((error as PayrollCalculationError).code)
        .toBe('PAYROLL_ATTENDANCE_RATE_ALLOCATION_REQUIRED');
    }
  });

  it('合并并排序重复组件，覆盖 HALF_UP 向下与向上分摊', () => {
    const first = segment('profile-1', '2026-01-01', '2026-07-15', 31);
    const second = segment('profile-2', '2026-07-16', null, 31);
    const result = proratePayrollCompensation('2026-07', [
      {
        ...first,
        data: {
          ...first.data,
          employeeSocialInsuranceMinor: 3,
          taxableEarnings: [
            { code: 'Z', amountMinor: 31 },
            { code: 'A', amountMinor: 32 },
          ],
          nonTaxableEarnings: [{ code: 'MEAL', amountMinor: 31 }],
        },
      },
      {
        ...second,
        data: {
          ...second.data,
          employeeSocialInsuranceMinor: 3,
          taxableEarnings: [
            { code: 'A', amountMinor: 31 },
            { code: 'Z', amountMinor: 31 },
          ],
          nonTaxableEarnings: [{ code: 'MEAL', amountMinor: 31 }],
        },
      },
    ]);
    expect(result.taxableEarnings.map((item) => item.code)).toEqual(['A', 'Z']);
    expect(result.nonTaxableEarnings).toEqual([{ code: 'MEAL', amountMinor: 31 }]);
  });

  it.each([
    ['2026-13', [segment('profile-1', '2026-01-01', null, 31)], 'PAYROLL_PERIOD_INVALID'],
    ['2026-07', [], 'PAYROLL_COMPENSATION_SEGMENT_COUNT_INVALID'],
    ['2026-07', Array(32).fill(segment('profile-1', '2026-01-01', null, 31)), 'PAYROLL_COMPENSATION_SEGMENT_COUNT_INVALID'],
    ['2026-07', [
      segment('profile-1', '2026-01-01', '2026-07-15', 31),
      segment('profile-1', '2026-07-16', null, 31),
    ], 'PAYROLL_COMPENSATION_SEGMENT_DUPLICATED'],
    ['2026-07', [segment('profile-1', '2026-08-01', null, 31)], 'PAYROLL_COMPENSATION_SEGMENT_NOT_EFFECTIVE'],
    ['2026-07', [segment('profile-1', '2026-01-01', '2026-07-30', 31)], 'PAYROLL_COMPENSATION_SEGMENT_GAP'],
  ] as const)('拒绝期间或覆盖边界：%s / %s', (period, values, code) => {
    expect(() => proratePayrollCompensation(period, values))
      .toThrowError(expect.objectContaining({ code }));
  });

  it.each([
    { profileId: '' },
    { profileVersion: 0 },
    { profileVersion: Number.NaN },
    { profileHash: 'bad' },
    { effectiveFrom: '2026-02-30' },
    { effectiveTo: 'bad' },
    { effectiveFrom: '2026-07-02', effectiveTo: '2026-07-01' },
    { data: { ...segment('profile-1', '2026-01-01', null, 31).data, jurisdictionCode: '' } },
  ])('拒绝非法薪酬分段 %#', (change) => {
    const baseSegment = segment('profile-1', '2026-01-01', null, 31);
    expect(() => proratePayrollCompensation('2026-07', [{
      ...baseSegment,
      ...change,
    }])).toThrowError(expect.objectContaining({
      code: 'PAYROLL_COMPENSATION_SEGMENT_INVALID',
    }));
  });

  it('拒绝非法日期、组件编码、金额和累计溢出', () => {
    const baseSegment = segment('profile-1', '2026-01-01', null, 31);
    expect(() => proratePayrollCompensation('2026-07', [{
      ...baseSegment,
      effectiveFrom: 'not-a-date',
    }])).toThrowError(expect.objectContaining({
      code: 'PAYROLL_COMPENSATION_SEGMENT_INVALID',
    }));
    expect(() => proratePayrollCompensation('2026-07', [{
      ...baseSegment,
      data: {
        ...baseSegment.data,
        taxableEarnings: [{ code: 'bad', amountMinor: 1 }],
      },
    }])).toThrowError(expect.objectContaining({
      code: 'PAYROLL_COMPONENT_CODE_INVALID',
    }));
    for (const amountMinor of [-1, Number.NaN]) {
      expect(() => proratePayrollCompensation('2026-07', [{
        ...baseSegment,
        data: {
          ...baseSegment.data,
          taxableEarnings: [{ code: 'BASE', amountMinor }],
        },
      }])).toThrowError(expect.objectContaining({
        code: 'PAYROLL_AMOUNT_INVALID',
      }));
    }
    expect(() => proratePayrollCompensation('2026-07', [{
      ...baseSegment,
      data: {
        ...baseSegment.data,
        taxableEarnings: [
          { code: 'BASE', amountMinor: Number.MAX_SAFE_INTEGER },
          { code: 'BASE', amountMinor: Number.MAX_SAFE_INTEGER },
        ],
      },
    }])).toThrowError(expect.objectContaining({
      code: 'PAYROLL_AMOUNT_OVERFLOW',
    }));
  });
});
