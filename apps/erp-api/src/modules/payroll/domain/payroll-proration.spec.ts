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
});
