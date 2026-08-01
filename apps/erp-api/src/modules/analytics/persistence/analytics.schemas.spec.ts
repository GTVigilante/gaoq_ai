import { createHash } from 'node:crypto';

import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { ANALYTICS_DASHBOARD_SOURCES } from '../analytics.contract.js';
import {
  AnalyticsManagementExportRecordSchema,
  type AnalyticsManagementExportRecord,
} from './analytics.schemas.js';

const mongoose = new Mongoose();
const ExportModel = mongoose.model<AnalyticsManagementExportRecord>(
  'SpecAnalyticsManagementExport', AnalyticsManagementExportRecordSchema,
);

function artifactJson(extraDashboard: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 'management-dashboard-export.v1',
    exportedAt: '2026-07-22T08:01:00.000Z',
    dashboard: {
      asOf: '2026-07-22',
      window: { from: '2026-06-23', to: '2026-07-22', timezone: 'Asia/Shanghai' },
      generatedAt: '2026-07-22T08:00:00.000Z',
      freshness: {
        transactional: 'live', operatingSummaryDate: '2026-07-21', payrollPeriod: '2026-07',
      },
      workforce: { activeHeadcount: 280, probationHeadcount: 15, suspendedHeadcount: 5 },
      approvals: { running: 12, overdue48h: 3, completed30d: 40, approvalRateBps: 8_000 },
      recruitment: {
        openPositionCount: 4, openHeadcount: 8,
        activeApplicationCount: 26, hired30d: 3,
      },
      learning: {
        mandatoryAssignments: 100, completedMandatoryAssignments: 85,
        expiredMandatoryAssignments: 2, completionRateBps: 8_500,
      },
      payroll: { period: '2026-07', status: 'review', employeeCount: 295 },
      operating: {
        summaryDate: '2026-07-21', revision: 2, currency: 'CNY',
        gmvMinor: 12_345_600, paidOrderCount: 321, refundMinor: 45_600,
      },
      sources: [...ANALYTICS_DASHBOARD_SOURCES],
      ...extraDashboard,
    },
  });
}

function readyFields(json = artifactJson()) {
  return {
    status: 'ready',
    artifactJson: json,
    contentHash: createHash('sha256').update(json).digest('base64url'),
  };
}

function record(): Record<string, unknown> {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    tenantId: 'tenant-001',
    requestedBy: 'actor-001',
    asOf: '2026-07-22',
    format: 'json',
    generation: 1,
    status: 'queued',
    resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
    artifactJson: null,
    contentHash: null,
    failureCode: null,
    processingStartedAt: null,
    processingJobId: null,
    processingToken: null,
    expiresAt: new Date('2026-07-23T00:00:00.000Z'),
  };
}

describe('AnalyticsManagementExportRecordSchema', () => {
  it('只保存固定聚合产物，并以所有权、代次和绝对 TTL 建模', async () => {
    await new ExportModel(record()).validate();
    expect(AnalyticsManagementExportRecordSchema.path('tenantId')).toBeDefined();
    expect(AnalyticsManagementExportRecordSchema.path('requestedBy')).toBeDefined();
    expect(AnalyticsManagementExportRecordSchema.path('generation')).toBeDefined();
    expect(AnalyticsManagementExportRecordSchema.path('employeeId')).toBeUndefined();
    expect(AnalyticsManagementExportRecordSchema.path('salary')).toBeUndefined();
    expect(AnalyticsManagementExportRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, id: 1 }, { unique: true },
    ]);
    expect(AnalyticsManagementExportRecordSchema.indexes()).toContainEqual([
      { expiresAt: 1 }, { expireAfterSeconds: 0 },
    ]);
  });

  it('就绪状态必须同时包含严格产物和匹配的 SHA-256 摘要', async () => {
    await expect(new ExportModel({ ...record(), status: 'ready' }).validate())
      .rejects.toThrow('就绪分析导出必须包含产物和摘要');
    await new ExportModel({ ...record(), ...readyFields() }).validate();
    await expect(new ExportModel({
      ...record(), ...readyFields(), contentHash: 'a'.repeat(43),
    }).validate()).rejects.toThrow('分析导出内容摘要不匹配');
    await expect(new ExportModel({
      ...record(), status: 'queued', artifactJson: '{}',
    }).validate()).rejects.toThrow('未就绪分析导出不能包含产物');
  });

  it('拒绝非法 JSON、越权扩展字段及超过 64KiB 的产物', async () => {
    const invalidJson = '{bad';
    await expect(new ExportModel({
      ...record(),
      ...readyFields(invalidJson),
    }).validate()).rejects.toThrow('分析导出产物不是有效 JSON');

    const withPii = artifactJson({ displayName: '不应持久化' });
    await expect(new ExportModel({
      ...record(),
      ...readyFields(withPii),
    }).validate()).rejects.toThrow('分析导出产物不符合固定契约');

    const oversized = JSON.stringify({
      schemaVersion: 'management-dashboard-export.v1',
      payload: 'x'.repeat(65_536),
    });
    await expect(new ExportModel({
      ...record(),
      ...readyFields(oversized),
    }).validate()).rejects.toThrow('分析导出产物超过大小上限');
  });

  it('processing 状态必须持有完整租约且其它状态不得持有', async () => {
    await expect(new ExportModel({ ...record(), status: 'processing' }).validate())
      .rejects.toThrow('处理中分析导出必须包含完整执行租约');
    await new ExportModel({
      ...record(),
      status: 'processing',
      processingStartedAt: new Date(),
      processingJobId: 'analytics_export_job_001',
      processingToken: 'a'.repeat(22),
    }).validate();
    await expect(new ExportModel({
      ...record(),
      processingStartedAt: new Date(),
      processingJobId: 'analytics_export_job_001',
      processingToken: 'a'.repeat(22),
    }).validate()).rejects.toThrow('非处理中分析导出不能持有执行租约');
  });

  it('失败状态必须包含稳定失败码，非失败状态禁止残留失败码', async () => {
    await expect(new ExportModel({ ...record(), status: 'failed' }).validate())
      .rejects.toThrow('失败分析导出必须包含失败码');
    await new ExportModel({
      ...record(), status: 'failed', failureCode: 'ANALYTICS_EXPORT_QUEUE_UNAVAILABLE',
    }).validate();
    await expect(new ExportModel({
      ...record(), failureCode: 'ANALYTICS_EXPORT_QUEUE_UNAVAILABLE',
    }).validate()).rejects.toThrow('非失败分析导出不能包含失败码');
  });

  it('资源 URI 必须与 ULID 精确绑定，并拒绝无效身份、代次与摘要编码', async () => {
    await expect(new ExportModel({
      ...record(), resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E2',
    }).validate()).rejects.toThrow('分析导出资源 URI 与导出标识不一致');
    await expect(new ExportModel({ ...record(), tenantId: '*invalid' }).validate())
      .rejects.toThrow();
    await expect(new ExportModel({ ...record(), generation: 0 }).validate())
      .rejects.toThrow();
    await expect(new ExportModel({
      ...record(), ...readyFields(), contentHash: 'not-base64url',
    }).validate()).rejects.toThrow();
  });
});
