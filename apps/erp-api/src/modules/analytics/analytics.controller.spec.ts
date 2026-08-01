import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { ManagementDashboardService } from './application/management-dashboard.service.js';
import { AnalyticsController } from './analytics.controller.js';

function fixture() {
  const dashboard = { get: vi.fn().mockResolvedValue({
    asOf: '2026-07-22', sources: ['org_employees', 'approval_actions'],
  }) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    dashboard,
    audit,
    controller: new AnalyticsController(
      dashboard as unknown as ManagementDashboardService,
      audit as unknown as AuditService,
    ),
  };
}

describe('AnalyticsController', () => {
  it('REST 与 MCP 复用同一指标服务并按服务返回的口径日审计', async () => {
    const store = fixture();
    const result = await store.controller.getManagementDashboard({ asOf: '2026-07-22' });
    expect(result).toMatchObject({ asOf: '2026-07-22' });
    expect(store.dashboard.get).toHaveBeenCalledWith('2026-07-22');
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'analytics.management_dashboard.read',
      resourceType: 'management_dashboard',
      resourceId: '2026-07-22',
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { asOf: '2026-07-22', sourceCount: 2 },
    });
  });

  it.each([
    {},
    { asOf: ['2026-07-22'] },
    { asOf: '2026-07-22', sort: 'salary' },
    { other: '2026-07-22' },
  ])('严格拒绝缺失、数组和未知查询参数 %#', async (query) => {
    const store = fixture();
    await expect(store.controller.getManagementDashboard(query)).rejects.toMatchObject({
      response: { code: 'ANALYTICS_QUERY_INVALID' },
    });
    expect(store.dashboard.get).not.toHaveBeenCalled();
  });

  it('读取失败时不写成功审计', async () => {
    const store = fixture();
    store.dashboard.get.mockRejectedValueOnce(new Error('ANALYTICS_SOURCE_INVALID'));
    await expect(store.controller.getManagementDashboard({ asOf: '2026-07-22' }))
      .rejects.toThrow('ANALYTICS_SOURCE_INVALID');
    expect(store.audit.record).not.toHaveBeenCalled();
  });
});
