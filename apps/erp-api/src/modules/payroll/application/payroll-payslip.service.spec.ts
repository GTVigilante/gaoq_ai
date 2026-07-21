import type { ActorContext } from '@gaoq/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { calculatePayroll, payrollDigest, type PayrollCalculationInput } from '../domain/index.js';
import { PayrollPayslipService } from './payroll-payslip.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'user', actorId: 'actor-001', tenantId: tenant.tenantId,
  roleCodes: ['employee'], scopes: ['erp:payroll:sheet:read_self'],
  departmentIds: ['department-001'], traceId: 'trace-001',
};
const input: PayrollCalculationInput = {
  tenantId: tenant.tenantId, employeeId: 'employee-001', period: '2026-07',
  currency: 'CNY', engineVersion: 'engine-v1',
  rulePack: {
    id: 'rule-001', version: 1, monthlyBasicDeductionMinor: 500_000,
    taxBrackets: [{ upperBoundMinor: null, rateBps: 300, quickDeductionMinor: 0 }],
    roundingMode: 'HALF_UP',
  },
  taxableEarnings: [{ code: 'BASE', amountMinor: 1_000_000 }], nonTaxableEarnings: [],
  employeeSocialInsuranceMinor: 100_000, employeeHousingFundMinor: 50_000,
  specialAdditionalDeductionMinor: 0, otherPreTaxWithholdingMinor: 0,
  postTaxDeductionMinor: 0,
  cumulativeBefore: {
    taxableIncomeMinor: 0, basicDeductionMinor: 0, socialInsuranceMinor: 0,
    housingFundMinor: 0, specialAdditionalDeductionMinor: 0,
    otherDeductionMinor: 0, taxWithheldMinor: 0,
  },
};
const result = calculatePayroll(input);

function query<T>(value: T) { return { lean: () => ({ exec: () => Promise.resolve(value) }) }; }

function assemble(status = 'locked') {
  const context = new TenantContextService();
  const profiles = { resolveActive: vi.fn().mockResolvedValue({ employeeId: 'employee-001' }) };
  const periods = { findOne: vi.fn().mockReturnValue(query(status === 'draft' ? null : {
    id: 'period-001', activeRunId: 'run-001', updatedAt: new Date('2026-07-31T10:00:00.000Z'),
  })) };
  const inputs = { findOne: vi.fn().mockReturnValue(query({
    id: 'input-001', inputHash: payrollDigest(input),
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  })) };
  const results = { findOne: vi.fn().mockReturnValue(query({
    id: 'result-001', resultHash: result.resultHash,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  })) };
  const crypto = { unprotect: vi.fn()
    .mockReturnValueOnce(input).mockReturnValueOnce(result) };
  const service = new PayrollPayslipService(
    context, profiles as never, crypto as never, periods as never, inputs as never, results as never,
  );
  return { context, profiles, periods, inputs, results, crypto, service };
}

describe('PayrollPayslipService', () => {
  it('只用可信主体反查员工，并校验密文快照后返回本人薪资单', async () => {
    const store = assemble();
    const payslip = await store.context.run({ tenant, actor }, () =>
      store.service.getMyPayslip('2026-07'));
    expect(store.profiles.resolveActive).toHaveBeenCalledWith('tenant-001', 'actor-001');
    expect(store.inputs.findOne).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 'employee-001', runId: 'run-001', periodId: 'period-001',
    }));
    expect(payslip).toMatchObject({
      period: '2026-07', grossPayMinor: 1_000_000,
      withholdingTaxMinor: 10_500, netPayMinor: 839_500,
    });
    expect(payslip).not.toHaveProperty('employeeId');
    expect(payslip).not.toHaveProperty('cumulativeBefore');
  });

  it('未锁定周期统一表现为尚未发布且不解密员工数据', async () => {
    const store = assemble('draft');
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.getMyPayslip('2026-07'))).rejects.toMatchObject({
      response: { code: 'PAYROLL_PAYSLIP_NOT_FOUND' },
    });
    expect(store.crypto.unprotect).not.toHaveBeenCalled();
  });
});
