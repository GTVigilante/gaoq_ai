import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { parsePayrollClaims } from './access-token-verifier.js';

const claims = {
  iss: 'https://erp.example.com',
  sub: 'actor-001',
  aud: 'gaoq-payroll-api',
  exp: 2_000_000_000,
  tenant_id: 'tenant-001',
  actor_id: 'actor-001',
  actor_type: 'user',
  client_id: 'payroll-web',
  azp: 'payroll-web',
  roles: ['payroll-specialist'],
  scope: 'erp:payroll:run:read erp:payroll:payslip:self',
  department_ids: ['department-001'],
  employee_id: 'employee-001',
  sid: 'session-001',
  resource: 'https://payroll.example.com/api',
};

describe('算薪访问令牌声明', () => {
  it('从已验签声明提取可信租户与权限', () => {
    const identity = parsePayrollClaims(claims, 'https://payroll.example.com/api');
    expect(identity.tenantId).toBe('tenant-001');
    expect(identity.employeeId).toBe('employee-001');
    expect(identity.scopes).toContain('erp:payroll:payslip:self');
  });

  it('拒绝错误资源和非算薪 Scope', () => {
    expect(() => parsePayrollClaims(claims, 'https://other.example.com/api'))
      .toThrow(UnauthorizedException);
    expect(() => parsePayrollClaims(
      { ...claims, scope: 'erp:org:write' },
      'https://payroll.example.com/api',
    )).toThrow(UnauthorizedException);
  });
});
