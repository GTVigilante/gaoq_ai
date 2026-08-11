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

  it('业务已成功但持久审计失败时仍返回已提交结果', async () => {
    const submit = vi.fn().mockResolvedValue({
      requestId: '01K00000000000000000000000',
      status: 'pending',
      sensitiveExpiresAt: '2026-07-21T12:00:00.000Z',
    });
    const record = vi.fn().mockRejectedValue(new Error('审计不可用'));
    const controller = new OrgEmployeeProvisioningController(
      { submit } as unknown as OrgEmployeeProvisioningService,
      { record } as unknown as AuditService,
    );

    await expect(controller.submit('idempotency-key-001', body)).resolves.toMatchObject({
      requestId: '01K00000000000000000000000',
      status: 'pending',
    });
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('业务失败后的审计故障不得覆盖原始业务异常', async () => {
    const businessError = new Error('员工不允许开户');
    const submit = vi.fn().mockRejectedValue(businessError);
    const record = vi.fn().mockRejectedValue(new Error('审计不可用'));
    const controller = new OrgEmployeeProvisioningController(
      { submit } as unknown as OrgEmployeeProvisioningService,
      { record } as unknown as AuditService,
    );

    await expect(controller.submit('idempotency-key-001', body))
      .rejects.toBe(businessError);
    expect(record).toHaveBeenCalledOnce();
  });

  it('缺失 Idempotency-Key 时传入空串并由领域服务统一失败关闭', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('幂等键无效'));
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new OrgEmployeeProvisioningController(
      { submit } as unknown as OrgEmployeeProvisioningService,
      { record } as unknown as AuditService,
    );

    await expect(controller.submit(undefined, body)).rejects.toThrow('幂等键无效');
    expect(submit).toHaveBeenCalledWith(body, '');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      resourceId: 'employee-001',
    }));
  });

  it('状态查询只透传请求标识并复用开户应用服务', async () => {
    const getStatus = vi.fn().mockResolvedValue({
      requestId: '01K00000000000000000000000',
      status: 'succeeded',
      attempts: 1,
      lastErrorCode: null,
      sensitiveExpiresAt: '2026-07-21T12:00:00.000Z',
    });
    const controller = new OrgEmployeeProvisioningController(
      { getStatus } as unknown as OrgEmployeeProvisioningService,
      { record: vi.fn() } as unknown as AuditService,
    );

    await expect(controller.getStatus('01K00000000000000000000000')).resolves.toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
    expect(getStatus).toHaveBeenCalledWith('01K00000000000000000000000');
  });

  it('绑定状态只允许固定平台并复用应用服务', async () => {
    const listBindings = vi.fn().mockResolvedValue({
      channel: 'dingtalk', boundEmployeeIds: ['employee-001'],
    });
    const controller = new OrgEmployeeProvisioningController(
      { listBindings } as unknown as OrgEmployeeProvisioningService,
      { record: vi.fn() } as unknown as AuditService,
    );
    await expect(controller.listBindings('dingtalk')).resolves.toEqual({
      channel: 'dingtalk', boundEmployeeIds: ['employee-001'],
    });
    expect(listBindings).toHaveBeenCalledWith('dingtalk');
    expect(() => controller.listBindings('op')).toThrow('开户渠道无效');
    expect(listBindings).toHaveBeenCalledOnce();
  });
});
