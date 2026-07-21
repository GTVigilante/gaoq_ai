import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../../core/audit/audit.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AnalyticsExportJobData } from '../analytics-export.queue.js';
import type { AnalyticsManagementExportDocument } from '../persistence/analytics.schemas.js';
import { AnalyticsExportService } from './analytics-export.service.js';
import type { ManagementDashboardService } from './management-dashboard.service.js';

function trusted<T>(context: TenantContextService, action: () => T): T {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'access_token' },
    actor: {
      actorId: 'actor-001', actorType: 'user', tenantId: 'tenant-001',
      roleCodes: ['management'], scopes: ['erp:analytics:management:export'],
      departmentIds: [], traceId: 'trace-001',
    },
  }, action);
}

describe('AnalyticsExportService', () => {
  it('使用可信租户与发起人创建 24 小时异步资源任务', async () => {
    const context = new TenantContextService();
    const records = { create: vi.fn().mockResolvedValue(undefined) };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const dashboard = { get: vi.fn().mockResolvedValue({ asOf: '2026-07-22' }) };
    const service = new AnalyticsExportService(
      context,
      records as unknown as Model<AnalyticsManagementExportDocument>,
      queue as unknown as Queue<AnalyticsExportJobData>,
      dashboard as unknown as ManagementDashboardService,
      { recordSystem: vi.fn() } as unknown as AuditService,
    );
    const result = await trusted(context, () => service.request(
      '01J8ZQK7V0A2M4N6P8R0T2W4E1', '2026-07-22',
    ));
    expect(records.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', requestedBy: 'actor-001', status: 'queued',
      artifactJson: null, resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
    }));
    expect(queue.add).toHaveBeenCalledWith(
      'analytics.generate-management-dashboard-export',
      {
        exportId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
        tenantId: 'tenant-001', requestedBy: 'actor-001',
      },
      expect.objectContaining({ jobId: '01J8ZQK7V0A2M4N6P8R0T2W4E1', attempts: 4 }),
    );
    expect(result).toMatchObject({ status: 'queued', artifact: null, contentHash: null });
  });

  it('Worker 在可信租户上下文生成固定聚合并写入 SHA-256 摘要', async () => {
    const context = new TenantContextService();
    const claimed = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4E1', tenantId: 'tenant-001', requestedBy: 'actor-001',
      asOf: '2026-07-22', format: 'json' as const, status: 'processing' as const,
      resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
      artifactJson: null, contentHash: null, expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      processingStartedAt: new Date(),
    };
    const finalUpdate = vi.fn().mockResolvedValue(claimed);
    const claimUpdate = vi.fn().mockResolvedValue(claimed);
    const records = {
      findOneAndUpdate: vi.fn()
        .mockReturnValueOnce({ lean: () => ({ exec: claimUpdate }) })
        .mockReturnValueOnce({ lean: () => ({ exec: finalUpdate }) }),
      updateOne: vi.fn(),
    };
    const dashboard = { get: vi.fn().mockImplementation(() => {
      expect(context.getTenantRequired().tenantId).toBe('tenant-001');
      return Promise.resolve({ asOf: '2026-07-22', sources: ['org_employees'] });
    }) };
    const service = new AnalyticsExportService(
      context,
      records as unknown as Model<AnalyticsManagementExportDocument>,
      { add: vi.fn() } as unknown as Queue<AnalyticsExportJobData>,
      dashboard as unknown as ManagementDashboardService,
      { recordSystem: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService,
    );
    await service.process({
      exportId: claimed.id, tenantId: claimed.tenantId, requestedBy: claimed.requestedBy,
    });
    const finalCall = records.findOneAndUpdate.mock.calls[1];
    expect(finalCall?.[1]).toMatchObject({
      $set: { status: 'ready', processingStartedAt: null, failureCode: null },
    });
    const set = (finalCall?.[1] as { $set: Record<string, unknown> }).$set;
    expect(set.contentHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(String(set.artifactJson)).toContain('management-dashboard-export.v1');
    expect(String(set.artifactJson)).not.toMatch(/tenantId|requestedBy/iu);
  });

  it('读取就绪产物时校验内容摘要，篡改后失败关闭', async () => {
    const context = new TenantContextService();
    const record = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4E1', tenantId: 'tenant-001', requestedBy: 'actor-001',
      asOf: '2026-07-22', format: 'json' as const, status: 'ready' as const,
      resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
      artifactJson: '{"schemaVersion":"tampered"}', contentHash: 'a'.repeat(43),
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    };
    const records = { findOne: vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(record) }),
    }) };
    const service = new AnalyticsExportService(
      context,
      records as unknown as Model<AnalyticsManagementExportDocument>,
      { add: vi.fn() } as unknown as Queue<AnalyticsExportJobData>,
      { get: vi.fn() } as unknown as ManagementDashboardService,
      { recordSystem: vi.fn() } as unknown as AuditService,
    );
    await expect(trusted(context, () => service.get(record.id)))
      .rejects.toThrow('ANALYTICS_EXPORT_INTEGRITY_FAILED');
    expect(records.findOne).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', requestedBy: 'actor-001',
    }));
  });
});
