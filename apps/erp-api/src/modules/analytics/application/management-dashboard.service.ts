import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  ApprovalActionRecord,
  type ApprovalActionDocument,
  ApprovalInstanceRecord,
  type ApprovalInstanceDocument,
} from '../../approval/persistence/approval.schemas.js';
import {
  KnowledgeTrainingAssignmentRecord,
  type KnowledgeTrainingAssignmentDocument,
} from '../../knowledge/persistence/knowledge.schemas.js';
import {
  OpOperatingSummaryRecord,
  type OpOperatingSummaryDocument,
} from '../../op/persistence/op.schemas.js';
import {
  OrgEmployeeRecord,
  type OrgEmployeeDocument,
} from '../../org/persistence/org.schemas.js';
import {
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
} from '../../payroll/persistence/payroll.schemas.js';
import {
  CandidateApplicationRecord,
  type CandidateApplicationDocument,
  RecruitmentPositionRecord,
  type RecruitmentPositionDocument,
} from '../../recruitment/persistence/recruitment.schemas.js';
import {
  ANALYTICS_DASHBOARD_SOURCES,
  managementDashboardSchema,
  type ManagementDashboardView,
} from '../analytics.contract.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 管理驾驶舱唯一指标口径层；固定聚合、可信租户、无个人明细和动态字段。 */
@Injectable()
export class ManagementDashboardService {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OrgEmployeeRecord.name) private readonly employees: Model<OrgEmployeeDocument>,
    @InjectModel(ApprovalInstanceRecord.name) private readonly approvals: Model<ApprovalInstanceDocument>,
    @InjectModel(ApprovalActionRecord.name)
    private readonly approvalActions: Model<ApprovalActionDocument>,
    @InjectModel(RecruitmentPositionRecord.name)
    private readonly positions: Model<RecruitmentPositionDocument>,
    @InjectModel(CandidateApplicationRecord.name)
    private readonly applications: Model<CandidateApplicationDocument>,
    @InjectModel(KnowledgeTrainingAssignmentRecord.name)
    private readonly assignments: Model<KnowledgeTrainingAssignmentDocument>,
    @InjectModel(PayrollPeriodRecord.name) private readonly payrollPeriods: Model<PayrollPeriodDocument>,
    @InjectModel(OpOperatingSummaryRecord.name)
    private readonly operatingSummaries: Model<OpOperatingSummaryDocument>,
  ) {}

  async get(asOf: string): Promise<ManagementDashboardView> {
    if (!this.context.getActorRequired().scopes.includes('erp:analytics:management:read')) {
      throw new ForbiddenException({
        code: 'ANALYTICS_MANAGEMENT_READ_DENIED',
        message: '当前身份无权读取管理驾驶舱',
      });
    }
    const range = dateRange(asOf);
    const tenantId = this.context.getTenantRequired().tenantId;
    const runningAtCutoff = {
      tenantId,
      submittedAt: { $lt: range.effectiveTo },
      $or: [
        { completedAt: null },
        { completedAt: { $gte: range.effectiveTo } },
      ],
    };
    const [active, probation, suspended, running, overdue, completed, approved,
      openPositions, activeApplications, hired, mandatory, completedMandatory, expiredMandatory,
      payroll, operating] = await Promise.all([
      this.employees.countDocuments({ tenantId, status: 'active' }),
      this.employees.countDocuments({ tenantId, status: 'probation' }),
      this.employees.countDocuments({ tenantId, status: 'suspended' }),
      this.approvals.countDocuments(runningAtCutoff),
      this.approvals.countDocuments({
        ...runningAtCutoff,
        submittedAt: { $lt: range.overdueCutoff },
      }),
      this.approvalActions.countDocuments({
        tenantId, actionType: 'instance.decided',
        resultingStatus: { $in: ['approved', 'rejected'] },
        occurredAt: { $gte: range.from, $lt: range.effectiveTo },
      }),
      this.approvalActions.countDocuments({
        tenantId, actionType: 'instance.decided', resultingStatus: 'approved',
        occurredAt: { $gte: range.from, $lt: range.effectiveTo },
      }),
      this.positions.aggregate<{ count: number; headcount: number }>([
        { $match: { tenantId, status: 'open' } },
        { $group: { _id: null, count: { $sum: 1 }, headcount: { $sum: '$headcount' } } },
        { $project: { _id: 0, count: 1, headcount: 1 } },
      ]).exec(),
      this.applications.countDocuments({ tenantId, active: true }),
      this.applications.countDocuments({
        tenantId, stage: 'hired', endedAt: { $gte: range.from, $lt: range.effectiveTo },
      }),
      this.assignments.countDocuments({ tenantId, mandatory: true }),
      this.assignments.countDocuments({ tenantId, mandatory: true, status: 'completed' }),
      this.assignments.countDocuments({ tenantId, mandatory: true, status: 'expired' }),
      this.payrollPeriods.findOne(
        { tenantId, period: { $lte: asOf.slice(0, 7) } },
        { period: 1, status: 1, employeeCount: 1, _id: 0 },
      ).sort({ period: -1 }).lean().exec(),
      this.operatingSummaries.findOne(
        { tenantId, summaryDate: { $lte: asOf } },
        {
          summaryDate: 1, revision: 1, currency: 1, gmvMinor: 1,
          paidOrderCount: 1, refundMinor: 1, _id: 0,
        },
      ).sort({ summaryDate: -1, revision: -1 }).lean().exec(),
    ]);
    const position = openPositions[0];
    const parsed = managementDashboardSchema.safeParse({
      asOf, window: Object.freeze({
        from: formatDate(range.from), to: asOf, timezone: 'Asia/Shanghai' as const,
      }),
      generatedAt: new Date().toISOString(),
      freshness: Object.freeze({
        transactional: 'live' as const,
        operatingSummaryDate: operating?.summaryDate ?? null,
        payrollPeriod: payroll?.period ?? null,
      }),
      workforce: Object.freeze({
        activeHeadcount: active, probationHeadcount: probation, suspendedHeadcount: suspended,
      }),
      approvals: Object.freeze({
        running, overdue48h: overdue, completed30d: completed,
        approvalRateBps: ratioBps(approved, completed),
      }),
      recruitment: Object.freeze({
        openPositionCount: position?.count ?? 0, openHeadcount: position?.headcount ?? 0,
        activeApplicationCount: activeApplications, hired30d: hired,
      }),
      learning: Object.freeze({
        mandatoryAssignments: mandatory,
        completedMandatoryAssignments: completedMandatory,
        expiredMandatoryAssignments: expiredMandatory,
        completionRateBps: ratioBps(completedMandatory, mandatory),
      }),
      payroll: Object.freeze({
        period: payroll?.period ?? null, status: payroll?.status ?? null,
        employeeCount: payroll?.employeeCount ?? null,
      }),
      operating: Object.freeze({
        summaryDate: operating?.summaryDate ?? null, revision: operating?.revision ?? null,
        currency: operating?.currency ?? null, gmvMinor: operating?.gmvMinor ?? null,
        paidOrderCount: operating?.paidOrderCount ?? null,
        refundMinor: operating?.refundMinor ?? null,
      }),
      sources: [...ANALYTICS_DASHBOARD_SOURCES],
    });
    if (!parsed.success) throw new Error('ANALYTICS_SOURCE_INVALID');
    return freezeDashboard(parsed.data);
  }

  validateAsOf(asOf: string): void {
    dateRange(asOf);
  }
}

function dateRange(asOf: string): {
  readonly from: Date;
  readonly effectiveTo: Date;
  readonly overdueCutoff: Date;
} {
  if (!DATE.test(asOf)) throw invalidDate();
  const start = new Date(`${asOf}T00:00:00+08:00`);
  const now = new Date();
  if (Number.isNaN(start.getTime()) || formatDate(start) !== asOf || asOf > formatDate(now)) {
    throw invalidDate();
  }
  const to = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
  const effectiveTo = Math.min(to.getTime(), now.getTime());
  return {
    from: new Date(start.getTime() - 29 * 24 * 60 * 60 * 1_000),
    effectiveTo: new Date(effectiveTo),
    overdueCutoff: new Date(effectiveTo - 48 * 60 * 60 * 1_000),
  };
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
}

function ratioBps(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round(numerator * 10_000 / denominator);
}

function invalidDate(): BadRequestException {
  return new BadRequestException({
    code: 'ANALYTICS_AS_OF_INVALID', message: 'asOf 必须是不晚于今天的有效 YYYY-MM-DD 日期',
  });
}

function freezeDashboard(value: ManagementDashboardView): ManagementDashboardView {
  Object.freeze(value.window);
  Object.freeze(value.freshness);
  Object.freeze(value.workforce);
  Object.freeze(value.approvals);
  Object.freeze(value.recruitment);
  Object.freeze(value.learning);
  Object.freeze(value.payroll);
  Object.freeze(value.operating);
  Object.freeze(value.sources);
  return Object.freeze(value);
}
