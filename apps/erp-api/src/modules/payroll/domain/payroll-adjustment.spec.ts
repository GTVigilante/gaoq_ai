import { describe, expect, it } from 'vitest';

import {
  applyPayrollAdjustmentApproval,
  calculatePayroll,
  createPayrollAdjustment,
  lockPayrollAdjustment,
  PayrollCalculationError,
  payrollDigest,
  requestPayrollAdjustmentApproval,
  type PayrollAdjustmentInput,
  type PayrollAdjustmentControl,
  type PayrollCalculationInput,
  type PayrollCalculationResult,
} from './index.js';

const base: PayrollCalculationInput = {
  tenantId: 'tenant-001', employeeId: 'employee-001', period: '2026-07',
  currency: 'CNY', engineVersion: 'payroll-engine-v1',
  rulePack: {
    id: 'rule-001', version: 1, monthlyBasicDeductionMinor: 500_000,
    roundingMode: 'HALF_UP',
    taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
  },
  taxableEarnings: [{ code: 'BASE', amountMinor: 1_000_000 }],
  nonTaxableEarnings: [], employeeSocialInsuranceMinor: 100_000,
  employeeHousingFundMinor: 50_000, specialAdditionalDeductionMinor: 0,
  otherPreTaxWithholdingMinor: 0, postTaxDeductionMinor: 0,
  cumulativeBefore: {
    taxableIncomeMinor: 0, basicDeductionMinor: 0, socialInsuranceMinor: 0,
    housingFundMinor: 0, specialAdditionalDeductionMinor: 0,
    otherDeductionMinor: 0, taxWithheldMinor: 0,
  },
};

function adjust(corrected: PayrollCalculationInput) {
  return createPayrollAdjustment({
    tenantId: 'tenant-001', employeeId: 'employee-001', period: '2026-07',
    originalCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
    reasonCode: 'RETROACTIVE_SALARY_CHANGE', originalPeriodStatus: 'reconciled',
    original: calculatePayroll(base), corrected: calculatePayroll(corrected),
  });
}

function adjustmentInput(
  overrides: Partial<PayrollAdjustmentInput> = {},
): PayrollAdjustmentInput {
  return {
    tenantId: 'tenant-001',
    employeeId: 'employee-001',
    period: '2026-07',
    originalCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
    reasonCode: 'RETROACTIVE_SALARY_CHANGE',
    originalPeriodStatus: 'reconciled',
    original: calculatePayroll(base),
    corrected: calculatePayroll({
      ...base,
      taxableEarnings: [{ code: 'BASE', amountMinor: 1_100_000 }],
    }),
    ...overrides,
  };
}

function rehashResult(
  result: PayrollCalculationResult,
  changes: Partial<PayrollCalculationResult>,
): PayrollCalculationResult {
  const { resultHash, ...withoutHash } = { ...result, ...changes };
  void resultHash;
  return {
    ...withoutHash,
    resultHash: payrollDigest(withoutHash),
  };
}

describe('锁定工资补发与冲销差额', () => {
  it('正向净额只形成补发应付，不接受任意客户端金额', () => {
    const result = adjust({
      ...base,
      taxableEarnings: [{ code: 'BASE', amountMinor: 1_100_000 }],
    });
    expect(result).toMatchObject({
      type: 'supplement', payableMinor: 97_000, receivableMinor: 0,
      delta: {
        grossPayMinor: 100_000, taxableEarningsMinor: 100_000,
        withholdingTaxMinor: 3_000, netPayMinor: 97_000,
      },
    });
    expect(result.adjustmentHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('负向净额形成独立应收，绝不生成负数银行支付', () => {
    const result = adjust({
      ...base,
      taxableEarnings: [{ code: 'BASE', amountMinor: 900_000 }],
    });
    expect(result).toMatchObject({
      type: 'reversal', payableMinor: 0, receivableMinor: 97_000,
      delta: { netPayMinor: -97_000 },
    });
  });

  it('相同规范输入或被篡改原结果均失败关闭', () => {
    expect(() => adjust(base)).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_INPUT_UNCHANGED',
    }));
    const original = calculatePayroll(base);
    expect(() => createPayrollAdjustment({
      tenantId: 'tenant-001', employeeId: 'employee-001', period: '2026-07',
      originalCalculationLineId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
      reasonCode: 'RETROACTIVE_SALARY_CHANGE', originalPeriodStatus: 'locked',
      original: { ...original, netPayMinor: original.netPayMinor + 1 },
      corrected: calculatePayroll({
        ...base, taxableEarnings: [{ code: 'BASE', amountMinor: 1_100_000 }],
      }),
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_ORIGINAL_INTEGRITY_FAILED',
    }));
  });

  it('净额为零但税额变化时形成 tax_only 且现金结算无需动作', () => {
    const result = adjust({
      ...base,
      taxableEarnings: [{ code: 'BASE', amountMinor: 1_100_000 }],
      postTaxDeductionMinor: 97_000,
    });
    expect(result).toMatchObject({
      type: 'tax_only',
      payableMinor: 0,
      receivableMinor: 0,
      delta: { netPayMinor: 0, withholdingTaxMinor: 3_000 },
    });
  });

  it('不同输入未形成任何工资或累计差额时拒绝创建空调整', () => {
    expect(() => createPayrollAdjustment(adjustmentInput({
      corrected: calculatePayroll({ ...base, engineVersion: 'payroll-engine-v2' }),
    }))).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_DELTA_ZERO',
    }));
  });

  it.each([
    ['tenantId', '', 'PAYROLL_ADJUSTMENT_REFERENCE_INVALID'],
    ['employeeId', '', 'PAYROLL_ADJUSTMENT_REFERENCE_INVALID'],
    ['period', '2026-13', 'PAYROLL_ADJUSTMENT_REFERENCE_INVALID'],
    ['originalCalculationLineId', 'bad', 'PAYROLL_ADJUSTMENT_REFERENCE_INVALID'],
    ['reasonCode', 'bad', 'PAYROLL_ADJUSTMENT_REFERENCE_INVALID'],
    ['originalPeriodStatus', 'open', 'PAYROLL_ADJUSTMENT_REFERENCE_INVALID'],
  ] as const)('拒绝非法工资调整根字段：%s', (field, value, code) => {
    expect(() => createPayrollAdjustment(adjustmentInput({
      [field]: value,
    }))).toThrowError(expect.objectContaining({ code }));
  });

  it('分别校验更正结果摘要、金额类型和安全整数差额边界', () => {
    const input = adjustmentInput();
    expect(() => createPayrollAdjustment({
      ...input,
      corrected: { ...input.corrected, resultHash: 'x'.repeat(43) },
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_CORRECTED_INTEGRITY_FAILED',
    }));

    expect(() => rehashResult(input.corrected, {
      grossPayMinor: Number.NaN,
    })).toThrowError(PayrollCalculationError);

    const maximum = rehashResult(input.corrected, {
      grossPayMinor: Number.MAX_SAFE_INTEGER,
    });
    const minimum = rehashResult(input.original, {
      grossPayMinor: Number.MIN_SAFE_INTEGER,
    });
    expect(() => createPayrollAdjustment({
      ...input,
      original: minimum,
      corrected: maximum,
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_AMOUNT_OVERFLOW',
    }));
  });
});

const preparedControl: PayrollAdjustmentControl = Object.freeze({
  id: '01J8ZQK7V0A2M4N6P8R0T2W4D1',
  tenantId: 'tenant-001',
  status: 'prepared',
  preparedBy: 'adjustment-engine',
  requestedBy: null,
  approvalInstanceId: null,
  approvalDecidedBy: null,
  approvalEvidenceId: null,
  lockedBy: null,
  strongAuthEvidenceId: null,
  version: 1,
});

describe('工资调整审批与强认证锁定', () => {
  it('按送审、可信批准和独立 WebAuthn 锁定推进版本', () => {
    const pending = requestPayrollAdjustmentApproval(preparedControl, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      requestedBy: 'payroll-requester',
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    });
    const approved = applyPayrollAdjustmentApproval(pending, {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      approvalInstanceId: pending.approvalInstanceId!,
      outcome: 'approved',
      decidedBy: 'finance-approver',
      approvalEvidenceId: pending.approvalInstanceId!,
      trustedApproval: true,
    });
    const locked = lockPayrollAdjustment(approved, {
      tenantId: 'tenant-001',
      expectedVersion: 3,
      lockedBy: 'treasury-locker',
      strongAuthEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    });
    expect(locked).toMatchObject({
      status: 'locked',
      version: 4,
      requestedBy: 'payroll-requester',
      approvalDecidedBy: 'finance-approver',
      lockedBy: 'treasury-locker',
    });
  });

  it('拒绝伪造审批、职责冲突和跳过状态', () => {
    const pending = requestPayrollAdjustmentApproval(preparedControl, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      requestedBy: 'payroll-requester',
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    });
    expect(() => applyPayrollAdjustmentApproval(pending, {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      approvalInstanceId: pending.approvalInstanceId!,
      outcome: 'approved',
      decidedBy: 'payroll-requester',
      approvalEvidenceId: pending.approvalInstanceId!,
      trustedApproval: true,
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_APPROVER_INDEPENDENCE_REQUIRED',
    }));
    expect(() => lockPayrollAdjustment(preparedControl, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      lockedBy: 'treasury-locker',
      strongAuthEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_TRANSITION_INVALID',
    }));
  });

  it('拒绝租户、版本、控制标识和送审职责冲突', () => {
    const valid = {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      requestedBy: 'payroll-requester',
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    };
    expect(() => requestPayrollAdjustmentApproval(preparedControl, {
      ...valid, tenantId: 'tenant-002',
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_TENANT_MISMATCH',
    }));
    expect(() => requestPayrollAdjustmentApproval(preparedControl, {
      ...valid, expectedVersion: Number.NaN,
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_VERSION_CONFLICT',
    }));
    expect(() => requestPayrollAdjustmentApproval(preparedControl, {
      ...valid, requestedBy: '',
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_CONTROL_ID_INVALID',
    }));
    expect(() => requestPayrollAdjustmentApproval(preparedControl, {
      ...valid, approvalInstanceId: '',
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_CONTROL_ID_INVALID',
    }));
    expect(() => requestPayrollAdjustmentApproval(preparedControl, {
      ...valid, requestedBy: preparedControl.preparedBy,
    })).toThrowError(expect.objectContaining({
      code: 'PAYROLL_ADJUSTMENT_REQUESTER_INDEPENDENCE_REQUIRED',
    }));
  });

  it('拒绝不可信审批、错误审批引用与非法审批控制标识', () => {
    const pending = requestPayrollAdjustmentApproval(preparedControl, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      requestedBy: 'payroll-requester',
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    });
    const valid = {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      approvalInstanceId: pending.approvalInstanceId!,
      outcome: 'approved' as const,
      decidedBy: 'finance-approver',
      approvalEvidenceId: pending.approvalInstanceId!,
      trustedApproval: true,
    };
    for (const command of [
      { ...valid, approvalInstanceId: '' },
      { ...valid, decidedBy: '' },
      { ...valid, approvalEvidenceId: '' },
    ]) {
      expect(() => applyPayrollAdjustmentApproval(pending, command))
        .toThrowError(expect.objectContaining({
          code: 'PAYROLL_ADJUSTMENT_CONTROL_ID_INVALID',
        }));
    }
    for (const command of [
      { ...valid, trustedApproval: false },
      { ...valid, approvalInstanceId: 'different-approval' },
    ]) {
      expect(() => applyPayrollAdjustmentApproval(pending, command))
        .toThrowError(expect.objectContaining({
          code: 'PAYROLL_ADJUSTMENT_APPROVAL_UNTRUSTED',
        }));
    }
    expect(applyPayrollAdjustmentApproval(pending, {
      ...valid,
      outcome: 'rejected',
    }).status).toBe('cancelled');
  });

  it('拒绝锁定标识与三类职责冲突', () => {
    const pending = requestPayrollAdjustmentApproval(preparedControl, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      requestedBy: 'payroll-requester',
      approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    });
    const approved = applyPayrollAdjustmentApproval(pending, {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      approvalInstanceId: pending.approvalInstanceId!,
      outcome: 'approved',
      decidedBy: 'finance-approver',
      approvalEvidenceId: pending.approvalInstanceId!,
      trustedApproval: true,
    });
    const valid = {
      tenantId: 'tenant-001',
      expectedVersion: 3,
      lockedBy: 'treasury-locker',
      strongAuthEvidenceId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    };
    for (const command of [
      { ...valid, lockedBy: '' },
      { ...valid, strongAuthEvidenceId: '' },
    ]) {
      expect(() => lockPayrollAdjustment(approved, command))
        .toThrowError(expect.objectContaining({
          code: 'PAYROLL_ADJUSTMENT_CONTROL_ID_INVALID',
        }));
    }
    for (const lockedBy of [
      approved.preparedBy,
      approved.requestedBy!,
      approved.approvalDecidedBy!,
    ]) {
      expect(() => lockPayrollAdjustment(approved, { ...valid, lockedBy }))
        .toThrowError(expect.objectContaining({
          code: 'PAYROLL_ADJUSTMENT_LOCKER_INDEPENDENCE_REQUIRED',
        }));
    }
  });
});
