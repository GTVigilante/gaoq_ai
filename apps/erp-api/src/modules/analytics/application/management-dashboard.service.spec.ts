import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  ApprovalActionDocument,
  ApprovalInstanceDocument,
} from '../../approval/persistence/approval.schemas.js';
import type { KnowledgeTrainingAssignmentDocument } from '../../knowledge/persistence/knowledge.schemas.js';
import type { OpOperatingSummaryDocument } from '../../op/persistence/op.schemas.js';
import type { OrgEmployeeDocument } from '../../org/persistence/org.schemas.js';
import type { PayrollPeriodDocument } from '../../payroll/persistence/payroll.schemas.js';
import type {
  CandidateApplicationDocument,
  RecruitmentPositionDocument,
} from '../../recruitment/persistence/recruitment.schemas.js';
import { ANALYTICS_DASHBOARD_SOURCES } from '../analytics.contract.js';
import { ManagementDashboardService } from './management-dashboard.service.js';

function latest(value: unknown) {
  return { sort: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }) };
}

function fixture(input?: {
  readonly scopes?: readonly string[];
  readonly positions?: readonly { count: number; headcount: number }[];
  readonly payroll?: unknown;
  readonly operating?: unknown;
  readonly employeeCounts?: readonly number[];
  readonly actionCounts?: readonly number[];
  readonly assignmentCounts?: readonly number[];
}) {
  const context = new TenantContextService();
  const employees = {
    countDocuments: vi.fn()
      .mockResolvedValueOnce(input?.employeeCounts?.[0] ?? 280)
      .mockResolvedValueOnce(input?.employeeCounts?.[1] ?? 15)
      .mockResolvedValueOnce(input?.employeeCounts?.[2] ?? 5),
  };
  const approvals = {
    countDocuments: vi.fn().mockResolvedValueOnce(12).mockResolvedValueOnce(3),
  };
  const approvalActions = {
    countDocuments: vi.fn()
      .mockResolvedValueOnce(input?.actionCounts?.[0] ?? 40)
      .mockResolvedValueOnce(input?.actionCounts?.[1] ?? 32),
  };
  const positions = { aggregate: vi.fn().mockReturnValue({
    exec: () => Promise.resolve(input?.positions ?? [{ count: 4, headcount: 8 }]),
  }) };
  const applications = {
    countDocuments: vi.fn().mockResolvedValueOnce(26).mockResolvedValueOnce(3),
  };
  const assignments = {
    countDocuments: vi.fn()
      .mockResolvedValueOnce(input?.assignmentCounts?.[0] ?? 100)
      .mockResolvedValueOnce(input?.assignmentCounts?.[1] ?? 85)
      .mockResolvedValueOnce(input?.assignmentCounts?.[2] ?? 2),
  };
  const payroll = { findOne: vi.fn().mockReturnValue(latest(
    input !== undefined && 'payroll' in input
      ? input.payroll
      : { period: '2026-07', status: 'review', employeeCount: 295 },
  )) };
  const operating = { findOne: vi.fn().mockReturnValue(latest(
    input !== undefined && 'operating' in input
      ? input.operating
      : {
          summaryDate: '2026-07-21', revision: 2, currency: 'CNY',
          gmvMinor: 12_345_600, paidOrderCount: 321, refundMinor: 45_600,
        },
  )) };
  const service = new ManagementDashboardService(
    context,
    employees as unknown as Model<OrgEmployeeDocument>,
    approvals as unknown as Model<ApprovalInstanceDocument>,
    approvalActions as unknown as Model<ApprovalActionDocument>,
    positions as unknown as Model<RecruitmentPositionDocument>,
    applications as unknown as Model<CandidateApplicationDocument>,
    assignments as unknown as Model<KnowledgeTrainingAssignmentDocument>,
    payroll as unknown as Model<PayrollPeriodDocument>,
    operating as unknown as Model<OpOperatingSummaryDocument>,
  );
  const run = <T>(action: () => T): T => context.run({
    tenant: { tenantId: 'tenant-001', source: 'access_token' },
    actor: {
      actorId: 'actor-001',
      actorType: 'user',
      tenantId: 'tenant-001',
      roleCodes: ['management'],
      scopes: [...(input?.scopes ?? ['erp:analytics:management:read'])],
      departmentIds: [],
      traceId: 'trace-001',
    },
  }, action);
  return {
    service, run, employees, approvals, approvalActions, positions,
    applications, assignments, payroll, operating,
  };
}

describe('ManagementDashboardService', () => {
  it('以可信租户固定口径汇总 KPI，并使用不可变审批动作计算最终结果', async () => {
    const store = fixture();
    const result = await store.run(() => store.service.get('2026-07-22'));
    expect(result).toMatchObject({
      asOf: '2026-07-22',
      window: { from: '2026-06-23', to: '2026-07-22', timezone: 'Asia/Shanghai' },
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
        mandatoryAssignments: 100,
        completedMandatoryAssignments: 85,
        expiredMandatoryAssignments: 2,
        completionRateBps: 8_500,
      },
      payroll: { period: '2026-07', status: 'review', employeeCount: 295 },
      operating: {
        summaryDate: '2026-07-21', revision: 2, currency: 'CNY',
        gmvMinor: 12_345_600, paidOrderCount: 321, refundMinor: 45_600,
      },
      sources: [...ANALYTICS_DASHBOARD_SOURCES],
    });
    expect(store.approvals.countDocuments).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-001',
      submittedAt: { $lt: expect.any(Date) as unknown },
      $or: [
        { completedAt: null },
        { completedAt: { $gte: expect.any(Date) as unknown } },
      ],
    });
    expect(store.approvalActions.countDocuments).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-001',
      actionType: 'instance.decided',
      resultingStatus: { $in: ['approved', 'rejected'] },
      occurredAt: {
        $gte: expect.any(Date) as unknown,
        $lt: expect.any(Date) as unknown,
      },
    });
    for (const call of store.employees.countDocuments.mock.calls) {
      expect(call[0]).toMatchObject({ tenantId: 'tenant-001' });
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sources)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/displayName|title|formData|salary|candidateId/iu);
  });

  it('在无分母和缺少可选快照时返回 null 或零，不伪造业务数据', async () => {
    const store = fixture({
      positions: [],
      payroll: null,
      operating: null,
      actionCounts: [0, 0],
      assignmentCounts: [0, 0, 0],
    });
    const result = await store.run(() => store.service.get('2026-07-22'));
    expect(result.approvals.approvalRateBps).toBeNull();
    expect(result.learning.completionRateBps).toBeNull();
    expect(result.recruitment).toMatchObject({ openPositionCount: 0, openHeadcount: 0 });
    expect(result.payroll).toEqual({ period: null, status: null, employeeCount: null });
    expect(result.operating).toEqual({
      summaryDate: null, revision: null, currency: null,
      gmvMinor: null, paidOrderCount: null, refundMinor: null,
    });
  });

  it('应用服务拒绝缺少读取范围的调用，即使绕过 REST 装饰器也失败关闭', async () => {
    const store = fixture({ scopes: [] });
    await expect(store.run(() => store.service.get('2026-07-22'))).rejects.toMatchObject({
      response: { code: 'ANALYTICS_MANAGEMENT_READ_DENIED' },
    });
    expect(store.employees.countDocuments).not.toHaveBeenCalled();
  });

  it.each(['2026-02-30', '2026/07/22', ''])(
    '拒绝非法口径日 %s 且不访问数据源',
    async (asOf) => {
      const store = fixture();
      await expect(store.run(() => store.service.get(asOf))).rejects.toMatchObject({
        response: { code: 'ANALYTICS_AS_OF_INVALID' },
      });
      expect(store.employees.countDocuments).not.toHaveBeenCalled();
    },
  );

  it('拒绝未来口径日，避免把当前快照伪装成未来数据', async () => {
    const store = fixture();
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000);
    const asOf = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(future);
    await expect(store.run(() => store.service.get(asOf))).rejects.toMatchObject({
      response: { code: 'ANALYTICS_AS_OF_INVALID' },
    });
    expect(store.employees.countDocuments).not.toHaveBeenCalled();
  });

  it('来源返回负数等越界值时由共享契约拒绝，禁止污染 REST、MCP 与导出', async () => {
    const store = fixture({ employeeCounts: [-1, 0, 0] });
    await expect(store.run(() => store.service.get('2026-07-22')))
      .rejects.toThrow('ANALYTICS_SOURCE_INVALID');
  });

  it('仅校验口径日时不读取聚合源，供 R2 prepare 阶段复用', () => {
    const store = fixture();
    expect(() => store.service.validateAsOf('2026-07-22')).not.toThrow();
    expect(() => store.service.validateAsOf('2026-02-30')).toThrow();
    expect(store.employees.countDocuments).not.toHaveBeenCalled();
  });
});
