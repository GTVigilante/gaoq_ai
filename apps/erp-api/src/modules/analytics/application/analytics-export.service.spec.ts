import { createHash } from 'node:crypto';

import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../../core/audit/audit.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { ANALYTICS_DASHBOARD_SOURCES } from '../analytics.contract.js';
import {
  ANALYTICS_GENERATE_EXPORT_JOB,
  type AnalyticsExportJobData,
  createAnalyticsExportJobId,
} from '../analytics-export.queue.js';
import type { AnalyticsManagementExportDocument } from '../persistence/analytics.schemas.js';
import { AnalyticsExportService } from './analytics-export.service.js';
import type { ManagementDashboardService } from './management-dashboard.service.js';

const EXPORT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E1';
const AS_OF = '2026-07-22';

function dashboard() {
  return {
    asOf: AS_OF,
    window: { from: '2026-06-23', to: AS_OF, timezone: 'Asia/Shanghai' as const },
    generatedAt: '2026-07-22T08:00:00.000Z',
    freshness: {
      transactional: 'live' as const,
      operatingSummaryDate: '2026-07-21',
      payrollPeriod: '2026-07',
    },
    workforce: { activeHeadcount: 280, probationHeadcount: 15, suspendedHeadcount: 5 },
    approvals: { running: 12, overdue48h: 3, completed30d: 40, approvalRateBps: 8_000 },
    recruitment: {
      openPositionCount: 4, openHeadcount: 8,
      activeApplicationCount: 26, hired30d: 3,
    },
    learning: {
      mandatoryAssignments: 100,
      completedMandatoryAssignments: 85,
      expiredMandatoryAssignments: 2,
      completionRateBps: 8_500,
    },
    payroll: { period: '2026-07', status: 'review' as const, employeeCount: 295 },
    operating: {
      summaryDate: '2026-07-21', revision: 2, currency: 'CNY' as const,
      gmvMinor: 12_345_600, paidOrderCount: 321, refundMinor: 45_600,
    },
    sources: [...ANALYTICS_DASHBOARD_SOURCES] as [
      'org_employees',
      'approval_instances',
      'approval_actions',
      'recruitment_positions',
      'recruitment_applications',
      'knowledge_training_assignments',
      'payroll_periods',
      'op_operating_summaries',
    ],
  };
}

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT_ID,
    tenantId: 'tenant-001',
    requestedBy: 'actor-001',
    asOf: AS_OF,
    format: 'json' as const,
    generation: 1,
    status: 'queued' as const,
    resourceUri: `erp://analytics/exports/${EXPORT_ID}`,
    artifactJson: null,
    contentHash: null,
    failureCode: null,
    processingStartedAt: null,
    processingJobId: null,
    processingToken: null,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function trusted<T>(
  context: TenantContextService,
  action: () => T,
  input?: { readonly scopes?: readonly string[]; readonly actorType?: 'user' | 'system_job' },
): T {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'access_token' },
    actor: {
      actorId: 'actor-001',
      actorType: input?.actorType ?? 'user',
      tenantId: 'tenant-001',
      roleCodes: ['management'],
      scopes: [...(input?.scopes ?? [
        'erp:analytics:management:read',
        'erp:analytics:management:export',
      ])],
      departmentIds: [],
      traceId: 'trace-001',
    },
  }, action);
}

function serviceFixture(input?: {
  readonly records?: Record<string, unknown>;
  readonly queue?: Record<string, unknown>;
  readonly dashboard?: Record<string, unknown>;
  readonly audit?: Record<string, unknown>;
}) {
  const context = new TenantContextService();
  const records = input?.records ?? {
    create: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  };
  const queue = input?.queue ?? { add: vi.fn().mockResolvedValue(undefined) };
  const dashboardService = input?.dashboard ?? {
    validateAsOf: vi.fn(),
    get: vi.fn().mockResolvedValue(dashboard()),
  };
  const audit = input?.audit ?? { recordSystem: vi.fn().mockResolvedValue(undefined) };
  return {
    context,
    records,
    queue,
    dashboard: dashboardService,
    audit,
    service: new AnalyticsExportService(
      context,
      records as unknown as Model<AnalyticsManagementExportDocument>,
      queue as unknown as Queue<AnalyticsExportJobData>,
      dashboardService as unknown as ManagementDashboardService,
      audit as unknown as AuditService,
    ),
  };
}

describe('AnalyticsExportService', () => {
  it('使用可信租户与当前用户创建 24 小时异步资源，并按代次绑定任务 ID', async () => {
    const store = serviceFixture();
    const result = await trusted(store.context, () => store.service.request(EXPORT_ID, AS_OF));
    expect(store.dashboard.validateAsOf).toHaveBeenCalledWith(AS_OF);
    expect(store.dashboard.get).not.toHaveBeenCalled();
    expect(store.records.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      requestedBy: 'actor-001',
      generation: 1,
      status: 'queued',
      artifactJson: null,
      processingJobId: null,
      processingToken: null,
      resourceUri: `erp://analytics/exports/${EXPORT_ID}`,
      expiresAt: expect.any(Date) as unknown,
    }));
    const data: AnalyticsExportJobData = {
      exportId: EXPORT_ID,
      tenantId: 'tenant-001',
      requestedBy: 'actor-001',
      generation: 1,
    };
    expect(store.queue.add).toHaveBeenCalledWith(
      ANALYTICS_GENERATE_EXPORT_JOB,
      data,
      expect.objectContaining({ jobId: createAnalyticsExportJobId(data), attempts: 4 }),
    );
    expect(result).toMatchObject({ status: 'queued', artifact: null, contentHash: null });
  });

  it.each([
    { scopes: ['erp:analytics:management:export'], actorType: 'user' as const },
    { scopes: ['erp:analytics:management:read'], actorType: 'user' as const },
    {
      scopes: ['erp:analytics:management:read', 'erp:analytics:management:export'],
      actorType: 'system_job' as const,
    },
  ])('发起导出必须是同时具备读写范围的当前用户 %#', async (identity) => {
    const store = serviceFixture();
    await expect(trusted(
      store.context,
      () => store.service.request(EXPORT_ID, AS_OF),
      identity,
    )).rejects.toMatchObject({ response: { code: 'ANALYTICS_EXPORT_REQUEST_DENIED' } });
    expect(store.records.create).not.toHaveBeenCalled();
  });

  it('在写库前拒绝非法 ULID，并复用口径日轻量校验', async () => {
    const store = serviceFixture();
    await expect(trusted(store.context, () => store.service.request('bad', AS_OF)))
      .rejects.toMatchObject({ response: { code: 'ANALYTICS_EXPORT_ID_INVALID' } });
    expect(store.dashboard.validateAsOf).not.toHaveBeenCalled();
  });

  it('相同请求幂等返回，失败记录递增代次后生成全新 BullMQ 任务', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
    const requeued = baseRecord({ generation: 2, status: 'queued' });
    const records = {
      create: vi.fn().mockRejectedValue(duplicate),
      findOne: vi.fn().mockReturnValue(query(baseRecord({
        status: 'failed', failureCode: 'ANALYTICS_EXPORT_GENERATION_FAILED',
      }))),
      findOneAndUpdate: vi.fn().mockReturnValue(query(requeued)),
      updateOne: vi.fn(),
    };
    const store = serviceFixture({ records });
    const result = await trusted(store.context, () => store.service.request(EXPORT_ID, AS_OF));
    const data = {
      exportId: EXPORT_ID, tenantId: 'tenant-001', requestedBy: 'actor-001', generation: 2,
    };
    expect(records.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1, status: 'failed' }),
      expect.objectContaining({ $inc: { generation: 1 } }),
      expect.objectContaining({ runValidators: true }),
    );
    expect(store.queue.add).toHaveBeenCalledWith(
      ANALYTICS_GENERATE_EXPORT_JOB,
      data,
      expect.objectContaining({ jobId: createAnalyticsExportJobId(data) }),
    );
    expect(result.status).toBe('queued');
  });

  it('重复标识绑定不同口径日时稳定冲突，非重复持久化异常原样抛出', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
    const duplicateStore = serviceFixture({ records: {
      create: vi.fn().mockRejectedValue(duplicate),
      findOne: vi.fn().mockReturnValue(query(baseRecord({ asOf: '2026-07-21' }))),
    } });
    await expect(trusted(
      duplicateStore.context,
      () => duplicateStore.service.request(EXPORT_ID, AS_OF),
    )).rejects.toMatchObject({ response: { code: 'ANALYTICS_EXPORT_ID_REUSED' } });

    const storageError = new Error('storage down');
    const failureStore = serviceFixture({ records: {
      create: vi.fn().mockRejectedValue(storageError),
    } });
    await expect(trusted(
      failureStore.context,
      () => failureStore.service.request(EXPORT_ID, AS_OF),
    )).rejects.toBe(storageError);
  });

  it('同一已排队请求可补偿入队，已就绪请求不重复入队', async () => {
    for (const status of ['queued', 'ready'] as const) {
      const artifact = status === 'ready'
        ? JSON.stringify({
            schemaVersion: 'management-dashboard-export.v1',
            exportedAt: '2026-07-22T08:01:00.000Z',
            dashboard: dashboard(),
          })
        : null;
      const records = {
        create: vi.fn().mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 })),
        findOne: vi.fn().mockReturnValue(query(baseRecord({
          status,
          artifactJson: artifact,
          contentHash: artifact === null
            ? null
            : createHash('sha256').update(artifact).digest('base64url'),
        }))),
      };
      const store = serviceFixture({ records });
      await trusted(store.context, () => store.service.request(EXPORT_ID, AS_OF));
      expect(store.queue.add).toHaveBeenCalledTimes(status === 'queued' ? 1 : 0);
    }
  });

  it('队列不可用时只把同租户同代次 queued 记录标记失败', async () => {
    const queueError = new Error('queue down');
    const updateExec = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    const records = {
      create: vi.fn().mockResolvedValue(undefined),
      updateOne: vi.fn().mockReturnValue({ exec: updateExec }),
    };
    const store = serviceFixture({
      records,
      queue: { add: vi.fn().mockRejectedValue(queueError) },
    });
    await expect(trusted(store.context, () => store.service.request(EXPORT_ID, AS_OF)))
      .rejects.toBe(queueError);
    expect(records.updateOne).toHaveBeenCalledWith(
      { id: EXPORT_ID, tenantId: 'tenant-001', generation: 1, status: 'queued' },
      { $set: expect.objectContaining({
        status: 'failed',
        failureCode: 'ANALYTICS_EXPORT_QUEUE_UNAVAILABLE',
      }) as unknown },
      { runValidators: true },
    );
  });

  it('Worker 在 system_job 可信上下文生成严格聚合并以租约 fencing 提交终态', async () => {
    const data: AnalyticsExportJobData = {
      exportId: EXPORT_ID, tenantId: 'tenant-001', requestedBy: 'actor-001', generation: 1,
    };
    const jobId = createAnalyticsExportJobId(data);
    const claimed = baseRecord({
      status: 'processing',
      processingStartedAt: new Date(),
      processingJobId: jobId,
      processingToken: 'a'.repeat(22),
    });
    const records = {
      findOneAndUpdate: vi.fn()
        .mockReturnValueOnce(query(claimed))
        .mockReturnValueOnce(query(baseRecord({ status: 'ready' }))),
      updateOne: vi.fn(),
    };
    const dashboardService = {
      validateAsOf: vi.fn(),
      get: vi.fn().mockImplementation(() => {
        const actor = store.context.getActorRequired();
        expect(actor).toMatchObject({
          actorId: 'system:analytics-export',
          actorType: 'system_job',
          tenantId: 'tenant-001',
          scopes: ['erp:analytics:management:read'],
        });
        return Promise.resolve(dashboard());
      }),
    };
    const store = serviceFixture({ records, dashboard: dashboardService });
    await store.service.process(data, jobId);

    const claimCall = records.findOneAndUpdate.mock.calls[0];
    expect(claimCall?.[0]).toMatchObject({
      id: EXPORT_ID,
      tenantId: 'tenant-001',
      requestedBy: 'actor-001',
      generation: 1,
      expiresAt: { $gt: expect.any(Date) as unknown },
      $or: expect.arrayContaining([
        { status: { $in: ['queued', 'failed'] } },
        { status: 'processing', processingJobId: jobId },
      ]) as unknown,
    });
    const claimToken = (claimCall?.[1] as { $set: { processingToken: string } })
      .$set.processingToken;
    expect(claimToken).toMatch(/^[A-Za-z0-9_-]{22}$/u);

    const finalCall = records.findOneAndUpdate.mock.calls[1];
    expect(finalCall?.[0]).toMatchObject({
      status: 'processing', processingJobId: jobId, processingToken: claimToken,
    });
    expect(finalCall?.[1]).toMatchObject({
      $set: {
        status: 'ready',
        processingStartedAt: null,
        processingJobId: null,
        processingToken: null,
        failureCode: null,
      },
    });
    const set = (finalCall?.[1] as { $set: Record<string, unknown> }).$set;
    expect(set.contentHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(String(set.artifactJson)).toContain('management-dashboard-export.v1');
    expect(String(set.artifactJson)).not.toMatch(/tenantId|requestedBy|salary|displayName/iu);
    expect(store.audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({
        action: 'analytics.management_dashboard.export.generate',
        outcome: 'success',
        metadata: expect.objectContaining({
          generation: 1, contentHash: set.contentHash,
        }) as unknown,
      }),
    );
  });

  it('无法取得租约时幂等结束，非法或重放任务在访问数据前失败', async () => {
    const data: AnalyticsExportJobData = {
      exportId: EXPORT_ID, tenantId: 'tenant-001', requestedBy: 'actor-001', generation: 1,
    };
    const noClaim = serviceFixture({ records: {
      findOneAndUpdate: vi.fn().mockReturnValue(query(null)),
    } });
    await expect(noClaim.service.process(data, createAnalyticsExportJobId(data)))
      .resolves.toBeUndefined();

    for (const [invalidData, jobId] of [
      [{ ...data, generation: 0 }, createAnalyticsExportJobId(data)],
      [data, 'replayed_job'],
      [{ ...data, tenantId: '*invalid' }, createAnalyticsExportJobId(data)],
    ] as const) {
      const store = serviceFixture();
      await expect(store.service.process(invalidData, jobId))
        .rejects.toThrow('ANALYTICS_EXPORT_JOB_INVALID');
      expect(store.records.findOneAndUpdate).not.toHaveBeenCalled();
    }
  });

  it('生成失败时先按 token 决议失败终态，再进行最佳努力审计且保留原异常', async () => {
    const data: AnalyticsExportJobData = {
      exportId: EXPORT_ID, tenantId: 'tenant-001', requestedBy: 'actor-001', generation: 1,
    };
    const jobId = createAnalyticsExportJobId(data);
    const records = {
      findOneAndUpdate: vi.fn().mockReturnValue(query(baseRecord({
        status: 'processing',
        processingStartedAt: new Date(),
        processingJobId: jobId,
        processingToken: 'a'.repeat(22),
      }))),
      updateOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ modifiedCount: 1 }),
      }),
    };
    const original = new Error('upstream failed');
    const store = serviceFixture({
      records,
      dashboard: { validateAsOf: vi.fn(), get: vi.fn().mockRejectedValue(original) },
      audit: { recordSystem: vi.fn().mockRejectedValue(new Error('audit down')) },
    });
    await expect(store.service.process(data, jobId)).rejects.toBe(original);
    expect(records.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 1,
        status: 'processing',
        processingJobId: jobId,
        processingToken: expect.any(String) as unknown,
      }),
      { $set: expect.objectContaining({
        status: 'failed',
        failureCode: 'ANALYTICS_EXPORT_GENERATION_FAILED',
        processingJobId: null,
        processingToken: null,
      }) as unknown },
      { runValidators: true },
    );
    expect(store.audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ outcome: 'failure' }),
    );
  });

  it('租约丢失时禁止旧 Worker 覆盖，新终态审计失败也不回写业务失败', async () => {
    const data: AnalyticsExportJobData = {
      exportId: EXPORT_ID, tenantId: 'tenant-001', requestedBy: 'actor-001', generation: 1,
    };
    const jobId = createAnalyticsExportJobId(data);
    const claimed = baseRecord({
      status: 'processing',
      processingStartedAt: new Date(),
      processingJobId: jobId,
      processingToken: 'a'.repeat(22),
    });
    const lostStore = serviceFixture({ records: {
      findOneAndUpdate: vi.fn()
        .mockReturnValueOnce(query(claimed))
        .mockReturnValueOnce(query(null)),
    } });
    await expect(lostStore.service.process(data, jobId))
      .rejects.toThrow('ANALYTICS_EXPORT_LEASE_LOST');
    expect(lostStore.audit.recordSystem).not.toHaveBeenCalled();

    const committedStore = serviceFixture({
      records: {
        findOneAndUpdate: vi.fn()
          .mockReturnValueOnce(query(claimed))
          .mockReturnValueOnce(query(baseRecord({ status: 'ready' }))),
      },
      audit: { recordSystem: vi.fn().mockRejectedValue(new Error('audit down')) },
    });
    await expect(committedStore.service.process(data, jobId)).resolves.toBeUndefined();
  });

  it('失败决议无法更新时报告租约丢失，不产生虚假的失败审计', async () => {
    const data: AnalyticsExportJobData = {
      exportId: EXPORT_ID, tenantId: 'tenant-001', requestedBy: 'actor-001', generation: 1,
    };
    const jobId = createAnalyticsExportJobId(data);
    const store = serviceFixture({
      records: {
        findOneAndUpdate: vi.fn().mockReturnValue(query(baseRecord({
          status: 'processing',
          processingStartedAt: new Date(),
          processingJobId: jobId,
          processingToken: 'a'.repeat(22),
        }))),
        updateOne: vi.fn().mockReturnValue({
          exec: () => Promise.resolve({ modifiedCount: 0 }),
        }),
      },
      dashboard: { validateAsOf: vi.fn(), get: vi.fn().mockRejectedValue(new Error('bad')) },
    });
    await expect(store.service.process(data, jobId))
      .rejects.toThrow('ANALYTICS_EXPORT_LEASE_LOST');
    expect(store.audit.recordSystem).not.toHaveBeenCalled();
  });

  it('读取只允许当前租户发起人，并对严格产物校验摘要、结构和深冻结', async () => {
    const artifactJson = JSON.stringify({
      schemaVersion: 'management-dashboard-export.v1',
      exportedAt: '2026-07-22T08:01:00.000Z',
      dashboard: dashboard(),
    });
    const record = baseRecord({
      status: 'ready',
      artifactJson,
      contentHash: createHash('sha256').update(artifactJson).digest('base64url'),
    });
    const records = { findOne: vi.fn().mockReturnValue(query(record)) };
    const store = serviceFixture({ records });
    const result = await trusted(store.context, () => store.service.get(EXPORT_ID));
    expect(records.findOne).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      requestedBy: 'actor-001',
      expiresAt: { $gt: expect.any(Date) as unknown },
    }));
    expect(result.status).toBe('ready');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifact?.dashboard)).toBe(true);
  });

  it.each([
    { artifactJson: '{"schemaVersion":"tampered"}', contentHash: 'a'.repeat(43) },
    {
      artifactJson: '{bad json',
      contentHash: createHash('sha256').update('{bad json').digest('base64url'),
    },
    {
      artifactJson: JSON.stringify({
        schemaVersion: 'management-dashboard-export.v1',
        exportedAt: '2026-07-22T08:01:00.000Z',
        dashboard: { ...dashboard(), tenantId: 'tenant-001' },
      }),
      contentHash: '',
    },
  ])('读取时失败关闭被篡改、非法或越权扩展的产物 %#', async (input) => {
    const contentHash = input.contentHash === ''
      ? createHash('sha256').update(input.artifactJson).digest('base64url')
      : input.contentHash;
    const store = serviceFixture({ records: {
      findOne: vi.fn().mockReturnValue(query(baseRecord({
        status: 'ready', artifactJson: input.artifactJson, contentHash,
      }))),
    } });
    await expect(trusted(store.context, () => store.service.get(EXPORT_ID)))
      .rejects.toThrow(/ANALYTICS_EXPORT_(INTEGRITY_FAILED|ARTIFACT_INVALID|RECORD_INVALID)/u);
  });

  it('缺少导出读取范围、非法标识、过期或不存在时失败关闭', async () => {
    const store = serviceFixture({ records: {
      findOne: vi.fn().mockReturnValue(query(null)),
    } });
    await expect(trusted(
      store.context,
      () => store.service.get(EXPORT_ID),
      { scopes: ['erp:analytics:management:read'] },
    )).rejects.toMatchObject({ response: { code: 'ANALYTICS_EXPORT_READ_DENIED' } });
    await expect(trusted(store.context, () => store.service.get('bad')))
      .rejects.toMatchObject({ status: 404 });
    await expect(trusted(store.context, () => store.service.get(EXPORT_ID)))
      .rejects.toMatchObject({ response: { code: 'ANALYTICS_EXPORT_NOT_FOUND' } });
  });

  it('记录日期损坏或 ready 状态缺少产物时拒绝返回', async () => {
    for (const record of [
      baseRecord({ expiresAt: 'invalid' }),
      baseRecord({ status: 'ready' }),
    ]) {
      const store = serviceFixture({ records: {
        findOne: vi.fn().mockReturnValue(query(record)),
      } });
      await expect(trusted(store.context, () => store.service.get(EXPORT_ID)))
        .rejects.toThrow('ANALYTICS_EXPORT_RECORD_INVALID');
    }
  });
});
