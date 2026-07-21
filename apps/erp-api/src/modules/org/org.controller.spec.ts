import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { OrgApplicationService } from './application/org-application.service.js';
import { OrgController } from './org.controller.js';

const EMPLOYEE_ID = '01K00000000000000000000000';

describe('OrgController 离职边界', () => {
  it('REST 在进入组织应用服务前拒绝绕过 Care 直接离职', async () => {
    const transitionEmployeeStatus = vi.fn();
    const record = vi.fn().mockResolvedValue(undefined);
    const controller = new OrgController(
      { transitionEmployeeStatus } as unknown as OrgApplicationService,
      { record } as unknown as AuditService,
    );
    await expect(controller.transitionEmployeeStatus(
      EMPLOYEE_ID,
      '"1"',
      'terminate-key-001',
      { status: 'terminated' },
      { setHeader: vi.fn() } as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(transitionEmployeeStatus).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
