import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { OrgEmployeeProvisioningController } from './org-employee-provisioning.controller.js';
import type { OrgEmployeeProvisioningService } from './org-employee-provisioning.service.js';

const body = {
  employeeId: 'employee-001',
  channel: 'feishu' as const,
  contact: {
    email: 'private@example.com',
    mobile: { countryCode: '+86', subscriberNumber: '13800138000' },
  },
};

describe('OrgEmployeeProvisioningController', () => {
  it('R3 审计与响应均不包含联系方式', async () => {
    const submit = vi.fn().mockResolvedValue({
      requestId: '01K00000000000000000000000',
      status: 'pending',
      sensitiveExpiresAt: '2026-07-21T12:00:00.000Z',
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new OrgEmployeeProvisioningController(
      { submit } as unknown as OrgEmployeeProvisioningService,
      { record } as unknown as AuditService,
    );

    const result = await controller.submit('idempotency-key-001', body);

    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(JSON.stringify(result)).not.toContain('13800138000');
    expect(record).toHaveBeenCalledWith({
      action: 'integration.org_employee.provision.submit',
      resourceType: 'org_employee_provisioning',
      resourceId: '01K00000000000000000000000',
      riskLevel: 'R3',
      outcome: 'success',
      metadata: { channel: 'feishu', status: 'pending' },
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('private@example.com');
    expect(JSON.stringify(record.mock.calls)).not.toContain('13800138000');
  });

  it('失败审计只记录员工标识和渠道不记录请求体', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('失败'));
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new OrgEmployeeProvisioningController(
      { submit } as unknown as OrgEmployeeProvisioningService,
      { record } as unknown as AuditService,
    );

    await expect(controller.submit('idempotency-key-001', body)).rejects.toThrow('失败');
    expect(record).toHaveBeenCalledWith({
      action: 'integration.org_employee.provision.submit',
      resourceType: 'org_employee',
      resourceId: 'employee-001',
      riskLevel: 'R3',
      outcome: 'failure',
      metadata: { channel: 'feishu' },
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('private@example.com');
  });
});
