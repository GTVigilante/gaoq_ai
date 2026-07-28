import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_DASHBOARD_SOURCES,
  analyticsExportArtifactSchema,
  analyticsExportViewSchema,
  managementDashboardSchema,
} from './analytics.contract.js';

function dashboard() {
  return {
    asOf: '2026-07-22',
    window: { from: '2026-06-23', to: '2026-07-22', timezone: 'Asia/Shanghai' },
    generatedAt: '2026-07-22T08:00:00.000Z',
    freshness: {
      transactional: 'live', operatingSummaryDate: '2026-07-21', payrollPeriod: '2026-07',
    },
    workforce: { activeHeadcount: 1, probationHeadcount: 0, suspendedHeadcount: 0 },
    approvals: { running: 1, overdue48h: 0, completed30d: 1, approvalRateBps: 10_000 },
    recruitment: {
      openPositionCount: 0, openHeadcount: 0,
      activeApplicationCount: 0, hired30d: 0,
    },
    learning: {
      mandatoryAssignments: 0, completedMandatoryAssignments: 0,
      expiredMandatoryAssignments: 0, completionRateBps: null,
    },
    payroll: { period: null, status: null, employeeCount: null },
    operating: {
      summaryDate: null, revision: null, currency: null,
      gmvMinor: null, paidOrderCount: null, refundMinor: null,
    },
    sources: [...ANALYTICS_DASHBOARD_SOURCES],
  };
}

describe('管理分析共享契约', () => {
  it('固定数据源顺序包含不可变审批动作，严格驾驶舱契约可供 REST 与 MCP 共用', () => {
    expect(ANALYTICS_DASHBOARD_SOURCES).toContain('approval_actions');
    expect(managementDashboardSchema.parse(dashboard()).sources)
      .toEqual(ANALYTICS_DASHBOARD_SOURCES);
    expect(() => managementDashboardSchema.parse({
      ...dashboard(), displayName: '越权字段',
    })).toThrow();
  });

  it('导出产物固定版本且拒绝嵌套个人字段', () => {
    const artifact = {
      schemaVersion: 'management-dashboard-export.v1',
      exportedAt: '2026-07-22T08:01:00.000Z',
      dashboard: dashboard(),
    };
    expect(analyticsExportArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(() => analyticsExportArtifactSchema.parse({
      ...artifact,
      dashboard: { ...dashboard(), salary: 1 },
    })).toThrow();
  });

  it('资源 URI、状态、摘要、产物与口径日必须形成一致组合', () => {
    const id = '01J8ZQK7V0A2M4N6P8R0T2W4E1';
    const artifact = {
      schemaVersion: 'management-dashboard-export.v1',
      exportedAt: '2026-07-22T08:01:00.000Z',
      dashboard: dashboard(),
    };
    const base = {
      id,
      asOf: '2026-07-22',
      format: 'json',
      status: 'ready',
      resourceUri: `erp://analytics/exports/${id}`,
      contentHash: 'a'.repeat(43),
      artifact,
      expiresAt: '2026-07-23T08:01:00.000Z',
    };
    expect(analyticsExportViewSchema.parse(base)).toMatchObject({ id, status: 'ready' });
    for (const invalid of [
      { ...base, resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E2' },
      { ...base, status: 'queued' },
      { ...base, contentHash: null },
      { ...base, artifact: null },
      {
        ...base,
        asOf: '2026-07-21',
      },
    ]) {
      expect(analyticsExportViewSchema.safeParse(invalid).success).toBe(false);
    }
    expect(analyticsExportViewSchema.parse({
      ...base, status: 'queued', contentHash: null, artifact: null,
    })).toMatchObject({ status: 'queued', artifact: null });
  });
});
