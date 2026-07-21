import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { OrgApplicationService } from './application/org-application.service.js';
import { OrgController } from './org.controller.js';

const EMPLOYEE_ID = '01K00000000000000000000000';

describe('OrgController 离职审计', () => {
  it('离职使用 R2 数量摘要审计且响应不暴露主体标识列表', async () => {
    const employee = {
      id: EMPLOYEE_ID, tenantId: 'tenant-001', employeeNo: 'E001', displayName: '员工',
      status: 'terminated' as const, departmentIds: ['department-001'],
      primaryDepartmentId: 'department-001', positionIds: [], jobLevelId: null,
      version: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
    };
    const transitionEmployeeStatus = vi.fn().mockResolvedValue({
      employee,
      identityTermination: {
        actorIds: ['actor-sensitive-001'],
        accessProfileDisabled: true,
        externalIdentitiesDisabled: 2,
        sessionsRevoked: 3,
        refreshTokensRevoked: 4,
      },
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new OrgController(
      { transitionEmployeeStatus } as unknown as OrgApplicationService,
      { record } as unknown as AuditService,
    );
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Response;

    const result = await controller.transitionEmployeeStatus(
      EMPLOYEE_ID,
      '"1"',
      'terminate-key-001',
      { status: 'terminated' },
      response,
    );

    expect(result).toEqual({ employee });
    expect(JSON.stringify(result)).not.toContain('actor-sensitive-001');
    expect(record).toHaveBeenCalledWith({
      action: 'org.employee.status_transition',
      resourceType: 'org_employee',
      resourceId: EMPLOYEE_ID,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        accessProfileDisabled: true,
        externalIdentitiesDisabled: 2,
        actorCount: 1,
        sessionsRevoked: 3,
        refreshTokensRevoked: 4,
      },
    });
    expect(setHeader).toHaveBeenCalledWith('ETag', '"2"');
  });
});
