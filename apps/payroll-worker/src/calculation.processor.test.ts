import { describe, expect, it } from 'vitest';

import { processPayrollCalculationJob } from './calculation.processor.js';

const input = {
  tenantId: 'tenant-001',
  employeeId: 'employee-001',
  period: '2026-07',
  ruleVersion: 1,
  components: [{
    code: 'base_salary',
    direction: 'earning' as const,
    amountMinor: '1000000',
    taxable: true,
  }],
  socialInsuranceEmployeeMinor: '100000',
  housingFundEmployeeMinor: '70000',
  specialDeductionMinor: '0',
  withholdingTaxMinor: '20000',
};

describe('异步算薪 Worker', () => {
  it('携带可信服务身份时执行确定性计算', () => {
    const result = processPayrollCalculationJob({
      actor: {
        tenantId: 'tenant-001',
        actorId: 'payroll-runner',
        actorType: 'system_job',
        scopes: ['erp:payroll:run:calculate'],
        traceId: 'trace-001',
      },
      input,
    });
    expect(result.netMinor).toBe('810000');
  });

  it('拒绝跨租户或缺少 Scope 的任务', () => {
    expect(() => processPayrollCalculationJob({
      actor: {
        tenantId: 'tenant-002',
        actorId: 'payroll-runner',
        actorType: 'system_job',
        scopes: ['erp:payroll:run:calculate'],
        traceId: 'trace-001',
      },
      input,
    })).toThrow('可信身份');
  });
});
