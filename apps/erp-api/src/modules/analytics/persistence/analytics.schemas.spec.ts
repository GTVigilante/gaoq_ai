import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  AnalyticsManagementExportRecordSchema,
  type AnalyticsManagementExportRecord,
} from './analytics.schemas.js';

const mongoose = new Mongoose();
const ExportModel = mongoose.model<AnalyticsManagementExportRecord>(
  'SpecAnalyticsManagementExport', AnalyticsManagementExportRecordSchema,
);

function record(): Record<string, unknown> {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4E1', tenantId: 'tenant-001', requestedBy: 'actor-001',
    asOf: '2026-07-22', format: 'json', status: 'queued',
    resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
    artifactJson: null, contentHash: null, failureCode: null,
    processingStartedAt: null,
    expiresAt: new Date('2026-07-23T00:00:00.000Z'),
  };
}

describe('AnalyticsManagementExportRecordSchema', () => {
  it('只保存固定聚合产物并以租户所有权和绝对 TTL 约束', async () => {
    await new ExportModel(record()).validate();
    expect(AnalyticsManagementExportRecordSchema.path('tenantId')).toBeDefined();
    expect(AnalyticsManagementExportRecordSchema.path('requestedBy')).toBeDefined();
    expect(AnalyticsManagementExportRecordSchema.path('employeeId')).toBeUndefined();
    expect(AnalyticsManagementExportRecordSchema.path('salary')).toBeUndefined();
    expect(AnalyticsManagementExportRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, id: 1 }, { unique: true },
    ]);
    expect(AnalyticsManagementExportRecordSchema.indexes()).toContainEqual([
      { expiresAt: 1 }, { expireAfterSeconds: 0 },
    ]);
  });

  it('就绪状态必须同时包含产物和内容摘要', async () => {
    await expect(new ExportModel({ ...record(), status: 'ready' }).validate())
      .rejects.toThrow('就绪分析导出必须包含产物和摘要');
    await new ExportModel({
      ...record(), status: 'ready', artifactJson: '{"schemaVersion":"v1"}',
      contentHash: 'a'.repeat(43),
    }).validate();
    await expect(new ExportModel({ ...record(), artifactJson: '{}' }).validate())
      .rejects.toThrow('未就绪分析导出不能包含产物');
  });

  it('processing 状态必须持有可恢复执行租约且其它状态不得持有', async () => {
    await expect(new ExportModel({ ...record(), status: 'processing' }).validate())
      .rejects.toThrow('处理中分析导出必须包含执行租约');
    await new ExportModel({
      ...record(), status: 'processing', processingStartedAt: new Date(),
    }).validate();
    await expect(new ExportModel({ ...record(), processingStartedAt: new Date() }).validate())
      .rejects.toThrow('非处理中分析导出不能持有执行租约');
  });
});
