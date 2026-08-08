import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityContextService } from '../identity/identity-context.service.js';
import type { PayrollDataCryptoService } from './payroll-data-crypto.service.js';
import { PayrollApplicationService } from './payroll-application.service.js';

const actor = {
  tenantId: 'tenant-001',
  actorId: 'payroll-runner',
  actorType: 'service' as const,
  employeeId: null,
  clientId: 'payroll-service',
  sessionId: 'credential-001',
  issuer: 'https://erp.example.com',
  subject: 'tenant-001:payroll-runner',
  audience: ['gaoq-payroll-api'],
  resource: ['https://payroll.example.com/api'],
  roleCodes: ['payroll-service'],
  scopes: [
    'erp:payroll:run:create',
    'erp:payroll:run:calculate',
    'erp:payroll:run:read',
    'erp:payroll:run:submit',
    'erp:payroll:payslip:self',
  ],
  departmentIds: [],
  traceId: 'trace-001',
  expiresAt: 2_000_000_000,
};

const query = <T>(value: T) => ({
  lean: () => ({ exec: vi.fn().mockResolvedValue(value) }),
});

const fixture = () => {
  const runs = {
    create: vi.fn().mockImplementation((value: object) => Promise.resolve({
      ...value,
      toObject: () => value,
    })),
    findOne: vi.fn().mockReturnValue(query({
      id: 'run-001',
      tenantId: 'tenant-001',
      period: '2026-07',
      status: 'draft',
      employeeCount: 0,
      totalGrossMinor: '0',
      totalNetMinor: '0',
      inputDigest: null,
      resultDigest: null,
      version: 1,
      submittedBy: null,
      lockedBy: null,
    })),
  };
  const service = new PayrollApplicationService(
    { requireScope: vi.fn().mockReturnValue(actor) } as unknown as IdentityContextService,
    {} as PayrollDataCryptoService,
    {} as never,
    {} as never,
    {} as never,
    runs as never,
    {} as never,
  );
  return { service, runs };
};

describe('专业算薪应用服务', () => {
  it('创建租户隔离的 draft 工资运行', async () => {
    const store = fixture();
    await expect(store.service.createRun({ period: '2026-07' })).resolves.toMatchObject({
      period: '2026-07',
      status: 'draft',
      version: 1,
    });
    expect(store.runs.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      totalGrossMinor: '0',
      totalNetMinor: '0',
    }));
  });

  it('拒绝同一运行重复员工输入', async () => {
    const store = fixture();
    const line = {
      employeeId: 'employee-001',
      ruleVersion: 1,
      components: [{
        code: 'base_salary',
        direction: 'earning',
        amountMinor: '1000000',
        taxable: true,
      }],
      socialInsuranceEmployeeMinor: '100000',
      housingFundEmployeeMinor: '70000',
      specialDeductionMinor: '0',
      withholdingTaxMinor: '20000',
    };
    await expect(store.service.calculateRun('run-001', {
      expectedVersion: 1,
      lines: [line, line],
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('拒绝服务主体代替用户提交工资审批', async () => {
    const store = fixture();
    await expect(store.service.submitRun('run-001', {
      expectedVersion: 2,
    })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('拒绝未绑定员工的主体读取本人工资条', async () => {
    const store = fixture();
    await expect(store.service.getSelfPayslip('2026-07'))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
