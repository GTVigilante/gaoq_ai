import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalInstanceDocument } from '../../approval/persistence/approval.schemas.js';
import type { KnowledgeTrainingAssignmentDocument } from '../../knowledge/persistence/knowledge.schemas.js';
import type { OpOperatingSummaryDocument } from '../../op/persistence/op.schemas.js';
import type { OrgEmployeeDocument } from '../../org/persistence/org.schemas.js';
import type { PayrollPeriodDocument } from '../../payroll/persistence/payroll.schemas.js';
import type {
  CandidateApplicationDocument,
  RecruitmentPositionDocument,
} from '../../recruitment/persistence/recruitment.schemas.js';
import { ManagementDashboardService } from './management-dashboard.service.js';

function latest(value: unknown) {
  return { sort: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }) };
}

function fixture() {
  const employees = { countDocuments: vi.fn()
    .mockResolvedValueOnce(280).mockResolvedValueOnce(15).mockResolvedValueOnce(5) };
  const approvals = { countDocuments: vi.fn()
    .mockResolvedValueOnce(12).mockResolvedValueOnce(3)
    .mockResolvedValueOnce(40).mockResolvedValueOnce(32) };
  const positions = { aggregate: vi.fn().mockReturnValue({
    exec: () => Promise.resolve([{ count: 4, headcount: 8 }]),
  }) };
  const applications = { countDocuments: vi.fn()
    .mockResolvedValueOnce(26).mockResolvedValueOnce(3) };
  const assignments = { countDocuments: vi.fn()
    .mockResolvedValueOnce(100).mockResolvedValueOnce(85).mockResolvedValueOnce(2) };
  const payroll = { findOne: vi.fn().mockReturnValue(latest({
    period: '2026-07', status: 'review', employeeCount: 295,
  })) };
  const operating = { findOne: vi.fn().mockReturnValue(latest({
    summaryDate: '2026-07-21', revision: 2, currency: 'CNY',
    gmvMinor: 12_345_600, paidOrderCount: 321, refundMinor: 45_600,
  })) };
  const service = new ManagementDashboardService(
    { getTenantRequired: () => ({ tenantId: 'tenant-001' }) } as TenantContextService,
    employees as unknown as Model<OrgEmployeeDocument>,
    approvals as unknown as Model<ApprovalInstanceDocument>,
    positions as unknown as Model<RecruitmentPositionDocument>,
    applications as unknown as Model<CandidateApplicationDocument>,
    assignments as unknown as Model<KnowledgeTrainingAssignmentDocument>,
    payroll as unknown as Model<PayrollPeriodDocument>,
    operating as unknown as Model<OpOperatingSummaryDocument>,
  );
  return { service, employees, approvals, positions, applications, assignments, payroll, operating };
}

describe('ManagementDashboardService', () => {
  it('以固定租户口径汇总管理 KPI，所有比例使用基点且不返回个人明细', async () => {
    const store = fixture();
    const result = await store.service.get('2026-07-22');
    expect(result).toMatchObject({
      asOf: '2026-07-22', window: { from: '2026-06-23', to: '2026-07-22' },
      freshness: {
        transactional: 'live', operatingSummaryDate: '2026-07-21', payrollPeriod: '2026-07',
      },
      workforce: { activeHeadcount: 280, probationHeadcount: 15, suspendedHeadcount: 5 },
      approvals: { running: 12, overdue48h: 3, completed30d: 40, approvalRateBps: 8_000 },
      recruitment: { openPositionCount: 4, openHeadcount: 8, activeApplicationCount: 26 },
      learning: { mandatoryAssignments: 100, completionRateBps: 8_500 },
      payroll: { period: '2026-07', status: 'review', employeeCount: 295 },
      operating: { summaryDate: '2026-07-21', revision: 2, gmvMinor: 12_345_600 },
    });
    for (const call of store.employees.countDocuments.mock.calls) {
      expect(call[0]).toMatchObject({ tenantId: 'tenant-001' });
    }
    expect(JSON.stringify(result)).not.toMatch(/displayName|title|formData|salary|candidateId/iu);
  });

  it('拒绝不存在的日历日期且不访问数据源', async () => {
    const store = fixture();
    await expect(store.service.get('2026-02-30')).rejects.toMatchObject({
      response: { code: 'ANALYTICS_AS_OF_INVALID' },
    });
    expect(store.employees.countDocuments).not.toHaveBeenCalled();
  });

  it('拒绝未来口径日，避免把当前快照伪装成未来数据', async () => {
    const store = fixture();
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000);
    const asOf = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(future);
    await expect(store.service.get(asOf)).rejects.toMatchObject({
      response: { code: 'ANALYTICS_AS_OF_INVALID' },
    });
    expect(store.employees.countDocuments).not.toHaveBeenCalled();
  });
});
