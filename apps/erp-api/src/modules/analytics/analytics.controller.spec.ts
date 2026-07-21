import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { ManagementDashboardService } from './application/management-dashboard.service.js';
import { AnalyticsController } from './analytics.controller.js';

describe('AnalyticsController', () => {
  it('REST 与 MCP 复用同一指标服务并记录来源数量', async () => {
    const dashboard = { get: vi.fn().mockResolvedValue({
      asOf: '2026-07-22', sources: ['org_employees', 'approval_instances'],
    }) };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const controller = new AnalyticsController(
      dashboard as unknown as ManagementDashboardService,
      audit as unknown as AuditService,
    );
    const result = await controller.getManagementDashboard('2026-07-22');
    expect(result).toMatchObject({ asOf: '2026-07-22' });
    expect(dashboard.get).toHaveBeenCalledWith('2026-07-22');
    expect(audit.record).toHaveBeenCalledWith({
      action: 'analytics.management_dashboard.read', resourceType: 'management_dashboard',
      resourceId: '2026-07-22', riskLevel: 'R1', outcome: 'success',
      metadata: { asOf: '2026-07-22', sourceCount: 2 },
    });
  });
});
