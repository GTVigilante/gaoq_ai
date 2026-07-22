import type { ActorContext } from '@gaoq/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { payrollDigest } from '../domain/index.js';
import { PayrollRunService } from './payroll-run.service.js';

const tenant = { tenantId: 'tenant-001', source: 'access_token' as const };
const actor: ActorContext = {
  actorType: 'user', actorId: 'treasury-maker', tenantId: tenant.tenantId,
  roleCodes: ['treasury'], scopes: ['erp:treasury:disbursement:prepare'],
  departmentIds: [], traceId: 'trace-001',
};
const resultWithoutHash = {
  currency: 'CNY' as const, inputHash: 'a'.repeat(43), grossPayMinor: 1_000_000,
  taxableEarningsMinor: 1_000_000, withholdingTaxMinor: 10_500, netPayMinor: 839_500,
  cumulativeAfter: {
    taxableIncomeMinor: 1_000_000, basicDeductionMinor: 500_000,
    socialInsuranceMinor: 100_000, housingFundMinor: 50_000,
    specialAdditionalDeductionMinor: 0, otherDeductionMinor: 0, taxWithheldMinor: 10_500,
  },
  steps: [],
};
const result = Object.freeze({
  ...resultWithoutHash, resultHash: payrollDigest(resultWithoutHash),
});
const runHash = payrollDigest([{
  employeeId: 'employee-001', resultHash: result.resultHash,
}]);

function terminalQuery<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function sortedQuery<T>(value: T) {
  const query = { sort: vi.fn(), lean: vi.fn(), exec: vi.fn().mockResolvedValue(value) };
  query.sort.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function assemble(aggregateHash = runHash) {
  const context = new TenantContextService();
  const periods = { findOne: vi.fn().mockReturnValue(terminalQuery({
    id: 'period-001', tenantId: 'tenant-001', period: '2026-07', version: 6,
    status: 'locked', activeRunId: 'run-001', lockedBy: 'payroll-locker',
    resultHash: aggregateHash, employeeCount: 1, totalNetMinor: 839_500,
  })) };
  const calculationLines = { find: vi.fn().mockReturnValue(sortedQuery([{
    id: 'line-001', employeeId: 'employee-001', resultHash: result.resultHash,
    dataKeyId: 'key', dataIv: 'iv', dataCiphertext: 'cipher', dataAuthTag: 'tag',
  }])) };
  const crypto = { unprotect: vi.fn().mockReturnValue(result) };
  const service = new PayrollRunService(
    {} as never, context, {} as never, crypto as never, {} as never, periods as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    calculationLines as never,
  );
  return { context, periods, calculationLines, crypto, service };
}

describe('Payroll 锁定代发源端口', () => {
  it('逐行验密文结果并复核运行摘要、员工数和实发总额', async () => {
    const store = assemble();
    const source = await store.context.run({ tenant, actor }, () =>
      store.service.getLockedDisbursementSource('period-001', 6));
    expect(source).toEqual({
      periodId: 'period-001', period: '2026-07', payrollRunId: 'run-001',
      payrollLockedBy: 'payroll-locker', payrollVersion: 6,
      resultHash: runHash, totalNetMinor: 839_500,
      lines: [{
        calculationLineId: 'line-001', employeeId: 'employee-001',
        netPayMinor: 839_500, resultHash: result.resultHash,
      }],
    });
    expect(store.crypto.unprotect).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', resourceType: 'calculation_line', resourceId: 'line-001',
    }), expect.any(Object));
  });

  it('聚合摘要错位时拒绝向资金模块提供员工实发数据', async () => {
    const store = assemble('z'.repeat(43));
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.getLockedDisbursementSource('period-001', 6))).rejects.toMatchObject({
      response: { code: 'PAYROLL_DISBURSEMENT_SOURCE_INTEGRITY_FAILED' },
    });
  });
});
