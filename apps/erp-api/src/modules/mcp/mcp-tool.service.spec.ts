import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { OrgApplicationService } from '../org/application/org-application.service.js';
import type { ApprovalApplicationService } from '../approval/application/approval-application.service.js';
import type { RecruitmentApplicationService } from '../recruitment/application/recruitment-application.service.js';
import type { RecruitmentInterviewService } from '../recruitment/application/recruitment-interview.service.js';
import type { RecruitmentManagementService } from '../recruitment/application/recruitment-management.service.js';
import type { RecruitmentOfferService } from '../recruitment/application/recruitment-offer.service.js';
import type { OnboardingApplicationService } from '../onboarding/application/onboarding-application.service.js';
import type { KnowledgeApplicationService } from '../knowledge/application/knowledge-application.service.js';
import type { CareApplicationService } from '../care/application/care-application.service.js';
import type { AttendanceApplicationService } from '../attendance/application/attendance-application.service.js';
import type { PayrollRunService } from '../payroll/application/payroll-run.service.js';
import type { PayrollPayslipService } from '../payroll/application/payroll-payslip.service.js';
import type { PayrollTaxFilingService } from '../payroll/application/payroll-tax-filing.service.js';
import type { PayrollReconciliationService } from '../payroll/application/payroll-reconciliation.service.js';
import type { PayrollShadowService } from '../payroll/application/payroll-shadow.service.js';
import type { PayrollAdjustmentService } from '../payroll/application/payroll-adjustment.service.js';
import type {
  PayrollAnnualReconciliationService,
} from '../payroll/application/payroll-annual-reconciliation.service.js';
import type { OpOperatingSummaryService } from '../op/application/op-operating-summary.service.js';
import type { OpApprovalBridgeService } from '../op/application/op-approval-bridge.service.js';
import type { ManagementDashboardService } from '../analytics/application/management-dashboard.service.js';
import type { AnalyticsExportService } from '../analytics/application/analytics-export.service.js';
import type { DataMigrationService } from '../data-migration/application/data-migration.service.js';
import { McpToolService } from './mcp-tool.service.js';
import type { McpConfirmationService } from './mcp-confirmation.service.js';

type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function extra(scopes: readonly string[]): McpExtra {
  const authInfo: AuthInfo = {
    token: 'opaque-redacted',
    clientId: 'ai-client-001',
    scopes: [...scopes],
    expiresAt: 1_900_000_000,
    resource: new URL('https://erp.example.com/mcp'),
    extra: {
      tenantId: 'tenant-001',
      actorId: 'employee-001',
      actorType: 'user',
      roleCodes: ['employee'],
      departmentIds: ['department-001'],
      traceId: 'trace-001',
    },
  };
  return { authInfo } as unknown as McpExtra;
}

function assemble() {
  const context = new TenantContextService();
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const organization = { getOrgChart: vi.fn().mockResolvedValue({ departments: [], employees: [] }) };
  const approvals = {
    getInbox: vi.fn().mockResolvedValue([]),
    listPublishedTemplateForms: vi.fn().mockResolvedValue([{ code: 'EXPENSE', fields: [] }]),
    listMyDelegations: vi.fn().mockResolvedValue([{
      id: 'delegation-001', principalApproverId: 'employee-001', delegateId: 'employee-002',
      validFrom: '2026-07-22T00:00:00.000Z', validUntil: '2026-08-01T00:00:00.000Z',
      status: 'active', version: 1,
    }]),
    getInstance: vi.fn().mockResolvedValue({ id: 'instance-001', formData: { remark: { redacted: true } } }),
    getTimeline: vi.fn().mockResolvedValue([{ actionId: '01K00000000000000000000000', actionType: 'instance.submitted' }]),
    submitInstance: vi.fn(),
    withdrawInstance: vi.fn(),
    decideConfirmedInstance: vi.fn(),
  };
  const confirmations = {
    prepare: vi.fn().mockResolvedValue({
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      digest: 'a'.repeat(43),
      riskLevel: 'R1',
      expiresAt: '2026-07-21T00:10:00.000Z',
      confirmationUrl: 'https://erp.example.com/mcp/confirm?operation_id=01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    }),
    claim: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const recruitmentApplications = { getApplication: vi.fn() };
  const recruitmentInterviews = { get: vi.fn() };
  const recruitmentManagement = {
    getRequisition: vi.fn(), getPosition: vi.fn(), submitRequisition: vi.fn(),
    transitionPosition: vi.fn(),
  };
  const recruitmentOffers = { get: vi.fn(), requestSend: vi.fn() };
  const onboarding = { get: vi.fn() };
  const knowledge = { getCourse: vi.fn(), getAssignment: vi.fn() };
  const care = { getForMcp: vi.fn() };
  const attendance = {
    getMyMonth: vi.fn(), validateCorrectionRequest: vi.fn(), requestCorrection: vi.fn(),
  };
  const payroll = { getPeriod: vi.fn() };
  const payslips = { getMyPayslip: vi.fn() };
  const taxFilings = { getStatus: vi.fn() };
  const reconciliations = { getStatus: vi.fn() };
  const shadows = { getCycle: vi.fn(), getReadiness: vi.fn() };
  const payrollAdjustments = { getControlStatus: vi.fn() };
  const annualPayrollReconciliations = { getControlStatus: vi.fn() };
  const opSummaries = { getLatest: vi.fn() };
  const opApprovalBridges = { get: vi.fn() };
  const managementDashboard = { get: vi.fn() };
  const analyticsExports = { get: vi.fn(), request: vi.fn() };
  const dataMigrations = { report: vi.fn() };
  const service = new McpToolService(
    context,
    audit as unknown as AuditService,
    organization as unknown as OrgApplicationService,
    approvals as unknown as ApprovalApplicationService,
    recruitmentApplications as unknown as RecruitmentApplicationService,
    recruitmentInterviews as unknown as RecruitmentInterviewService,
    recruitmentManagement as unknown as RecruitmentManagementService,
    recruitmentOffers as unknown as RecruitmentOfferService,
    onboarding as unknown as OnboardingApplicationService,
    knowledge as unknown as KnowledgeApplicationService,
    care as unknown as CareApplicationService,
    attendance as unknown as AttendanceApplicationService,
    payroll as unknown as PayrollRunService,
    payslips as unknown as PayrollPayslipService,
    taxFilings as unknown as PayrollTaxFilingService,
    reconciliations as unknown as PayrollReconciliationService,
    shadows as unknown as PayrollShadowService,
    payrollAdjustments as unknown as PayrollAdjustmentService,
    annualPayrollReconciliations as unknown as PayrollAnnualReconciliationService,
    opSummaries as unknown as OpOperatingSummaryService,
    opApprovalBridges as unknown as OpApprovalBridgeService,
    managementDashboard as unknown as ManagementDashboardService,
    analyticsExports as unknown as AnalyticsExportService,
    dataMigrations as unknown as DataMigrationService,
    confirmations as unknown as McpConfirmationService,
  );
  return {
    context, audit, organization, approvals, recruitmentApplications,
    recruitmentInterviews, recruitmentManagement, recruitmentOffers, confirmations, service,
    onboarding, knowledge, care, attendance, payroll, payslips, taxFilings, reconciliations, shadows,
    payrollAdjustments, annualPayrollReconciliations,
    opSummaries, opApprovalBridges, managementDashboard, analyticsExports, dataMigrations,
  };
}

describe('McpToolService', () => {
  it('缺少 SDK AuthInfo 时拒绝建立工具身份', async () => {
    const store = assemble();

    await expect(store.service.getMyPermissions({} as McpExtra)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('审批待办复用应用服务并且缺 Scope 时失败关闭', async () => {
    const store = assemble();
    const denied = await store.service.getApprovalInbox(extra(['erp:mcp:server:connect']));
    expect(denied.isError).toBe(true);
    expect(store.approvals.getInbox).not.toHaveBeenCalled();

    const result = await store.service.getApprovalInbox(extra([
      'erp:mcp:server:connect', 'erp:approval:instance:read',
    ]));
    expect(result.structuredContent).toEqual({ items: [] });
    expect(store.approvals.getInbox).toHaveBeenCalled();
  });

  it('模板目录 Resource 复用应用服务并按发起 Scope 失败关闭', async () => {
    const store = assemble();
    const denied = await store.service.getApprovalTemplateCatalog(extra(['erp:mcp:server:connect']));
    expect(denied.isError).toBe(true);
    expect(store.approvals.listPublishedTemplateForms).not.toHaveBeenCalled();
    const result = await store.service.getApprovalTemplateCatalog(extra([
      'erp:mcp:server:connect', 'erp:approval:instance:submit',
    ]));
    expect(result.structuredContent).toEqual({ templates: [{ code: 'EXPENSE', fields: [] }] });
    expect(JSON.stringify(result)).not.toContain('tenant-001');
  });

  it('委托 Resource 只读且按独立 Scope 失败关闭', async () => {
    const store = assemble();
    const denied = await store.service.getApprovalDelegations(extra(['erp:mcp:server:connect']));
    expect(denied.isError).toBe(true);
    expect(store.approvals.listMyDelegations).not.toHaveBeenCalled();
    const result = await store.service.getApprovalDelegations(extra([
      'erp:mcp:server:connect', 'erp:approval:delegation:read',
    ]));
    expect(result.structuredContent).toMatchObject({
      delegations: [{ principalApproverId: 'employee-001', delegateId: 'employee-002' }],
    });
    expect(JSON.stringify(result)).not.toContain('tenant-001');
  });

  it('审批详情沿用应用层 L3/L4 脱敏投影', async () => {
    const store = assemble();
    const result = await store.service.getApprovalInstance('instance-001', extra([
      'erp:mcp:server:connect', 'erp:approval:instance:read',
    ]));
    expect(result.structuredContent).toEqual({
      instance: { id: 'instance-001', formData: { remark: { redacted: true } } },
    });
  });

  it('审批时间线复用应用服务且不返回租户或表单正文', async () => {
    const store = assemble();
    const result = await store.service.getApprovalTimeline('01K00000000000000000000000', extra([
      'erp:mcp:server:connect', 'erp:approval:instance:read',
    ]));
    expect(result.structuredContent).toEqual({
      timeline: [{ actionId: '01K00000000000000000000000', actionType: 'instance.submitted' }],
    });
    expect(JSON.stringify(result)).not.toContain('tenant-001');
    expect(JSON.stringify(result)).not.toContain('formData');
    expect(store.approvals.getTimeline).toHaveBeenCalledWith('01K00000000000000000000000');
  });

  it('权限查询只返回服务端身份快照，不返回租户参数或访问令牌', async () => {
    const store = assemble();

    const result = await store.service.getMyPermissions(extra(['erp:mcp:server:connect']));

    expect(result.structuredContent).toEqual({
      actorId: 'employee-001',
      roleCodes: ['employee'],
      scopes: ['erp:mcp:server:connect'],
      departmentIds: ['department-001'],
    });
    expect(JSON.stringify(result)).not.toContain('opaque-redacted');
    expect(JSON.stringify(result)).not.toContain('tenant-001');
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('缺少 erp:org:chart:read 时以工具错误拒绝，且不调用组织应用服务', async () => {
    const store = assemble();

    const result = await store.service.getOrgChart(extra(['erp:mcp:server:connect']));

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(result)).toContain('AUTH_INSUFFICIENT_SCOPE');
    expect(store.organization.getOrgChart).not.toHaveBeenCalled();
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
  });

  it('组织工具复用应用服务，并传播可信租户与部门数据范围', async () => {
    const store = assemble();
    let observedTenant = '';
    let observedDepartments: readonly string[] = [];
    store.organization.getOrgChart.mockImplementation(() => {
      observedTenant = store.context.getTenantRequired().tenantId;
      observedDepartments = store.context.getActorRequired().departmentIds;
      return Promise.resolve({
        departments: [{ id: 'department-001', name: '财务部' }],
        employees: [],
      });
    });

    const result = await store.service.getOrgChart(extra(['erp:mcp:server:connect', 'erp:org:chart:read']));

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      departments: [{ id: 'department-001', name: '财务部' }],
    });
    expect(observedTenant).toBe('tenant-001');
    expect(observedDepartments).toEqual(['department-001']);
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'mcp.tool.get_org_chart',
      outcome: 'success',
    }));
  });

  it('R1 提交准备只生成服务端确认单，不直接提交审批', async () => {
    const store = assemble();
    store.approvals.getInstance.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', status: 'draft', version: 1, formData: {},
    });
    const result = await store.service.prepareApprovalSubmit(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      1,
      'prepare-key-001',
      extra(['erp:approval:instance:read', 'erp:approval:instance:submit']),
    );
    expect(result.structuredContent).toMatchObject({ riskLevel: 'R1' });
    expect(store.confirmations.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', actorId: 'employee-001' }),
      'prepare-key-001',
      {
        operation: 'approval.submit',
        instanceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
        expectedVersion: 1,
      },
      'R1',
    );
    expect(store.approvals.submitInstance).not.toHaveBeenCalled();
  });

  it('执行工具只消费确认服务返回的固化命令并使用服务端幂等键', async () => {
    const store = assemble();
    const submitInstance = vi.fn().mockResolvedValue({
      instance: { id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', status: 'running', version: 2 },
    });
    store.approvals.submitInstance = submitInstance;
    store.confirmations.claim.mockResolvedValue({
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
      command: {
        operation: 'approval.submit',
        instanceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
        expectedVersion: 1,
      },
      replayResult: null,
    });
    const result = await store.service.executeApprovalSubmit(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
      `mcpc_${'a'.repeat(43)}`,
      extra(['erp:approval:instance:submit']),
    );
    expect(submitInstance).toHaveBeenCalledWith(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      1,
      'mcp:01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    );
    const completed = store.confirmations.complete.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(completed[0]).toBe('01J8ZQK7V0A2M4N6P8R0T2W4Y7');
    expect(completed[1]).toHaveProperty('instance');
    expect(result.structuredContent).toMatchObject({ instance: { status: 'running' } });
  });

  it('R2 决策准备拒绝发起人本人或其代理形成决策', async () => {
    const store = assemble();
    store.approvals.getInstance.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      initiatorId: 'employee-001',
      status: 'running',
      version: 2,
      formData: {},
    });
    const result = await store.service.prepareApprovalDecision({
      instanceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      expectedVersion: 2,
      principalApproverId: 'approver-001',
      outcome: 'approved',
      prepareKey: 'prepare-key-002',
    }, extra(['erp:approval:instance:read', 'erp:approval:task:decide']));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('APPROVAL_R2_INDEPENDENCE_REQUIRED');
    expect(store.confirmations.prepare).not.toHaveBeenCalled();
  });

  it('R2 决策执行只调用已确认应用服务路径', async () => {
    const store = assemble();
    store.approvals.decideConfirmedInstance.mockResolvedValue({
      instance: { id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', status: 'approved', version: 3 },
    });
    store.confirmations.claim.mockResolvedValue({
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
      command: {
        operation: 'approval.decide',
        instanceId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
        expectedVersion: 2,
        principalApproverId: 'approver-001',
        outcome: 'approved',
      },
      replayResult: null,
    });
    await store.service.executeApprovalDecision(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
      `mcpc_${'a'.repeat(43)}`,
      extra(['erp:approval:task:decide']),
    );
    expect(store.approvals.decideConfirmedInstance).toHaveBeenCalledWith(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      2,
      'approver-001',
      'approved',
      'mcp:01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    );
  });

  it('招聘只读工具复用脱敏应用投影且不返回 Offer 条款', async () => {
    const store = assemble();
    store.recruitmentOffers.get.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', applicationId: 'app-001',
      status: 'approved', version: 3, approvalInstanceId: 'approval-001',
    });
    const denied = await store.service.getRecruitmentOffer(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y6', extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.recruitmentOffers.get).not.toHaveBeenCalled();
    const result = await store.service.getRecruitmentOffer(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      extra(['erp:mcp:server:connect', 'erp:recruitment:offer:read']),
    );
    expect(result.structuredContent).toMatchObject({ offer: { status: 'approved', version: 3 } });
    expect(JSON.stringify(result)).not.toMatch(/terms|salary|benefits|workLocation/iu);
  });

  it('入职 MCP 只读工具复用脱敏摘要并按 Scope 失败关闭', async () => {
    const store = assemble();
    store.onboarding.get.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', offerId: 'offer-001',
      status: 'in_progress', tasks: { identity_verified: 'pending' }, version: 2,
    });
    const denied = await store.service.getOnboarding(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y6', extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.onboarding.get).not.toHaveBeenCalled();
    const result = await store.service.getOnboarding(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
      extra(['erp:mcp:server:connect', 'erp:onboarding:read']),
    );
    expect(result.structuredContent).toMatchObject({
      onboarding: { status: 'in_progress', version: 2 },
    });
    expect(JSON.stringify(result)).not.toMatch(/identityEvidence|signedEvidence|materialsEvidence/iu);
  });

  it('知识 MCP 只读取脱敏课程与任务投影，不暴露题库、答卷或证据引用', async () => {
    const store = assemble();
    store.knowledge.getCourse.mockResolvedValue({
      id: 'course-001', courseCode: 'SECURITY', revision: 1, title: '安全培训',
      examRequired: true, passingScoreBps: 8_000, status: 'published', version: 2,
    });
    store.knowledge.getAssignment.mockResolvedValue({
      id: 'assignment-001', onboardingInstanceId: 'onboarding-001',
      courseVersionId: 'course-001', mandatory: true, examRequired: true,
      dueDate: '2026-08-31', status: 'in_progress', progressBps: 5_000, version: 2,
    });
    const denied = await store.service.getKnowledgeCourse(
      'course-001', extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.knowledge.getCourse).not.toHaveBeenCalled();
    const course = await store.service.getKnowledgeCourse(
      'course-001', extra(['erp:mcp:server:connect', 'erp:knowledge:course:read']),
    );
    const assignment = await store.service.getKnowledgeAssignment(
      'assignment-001',
      extra(['erp:mcp:server:connect', 'erp:knowledge:assignment:read']),
    );
    expect(course.structuredContent).toMatchObject({ course: { status: 'published' } });
    expect(assignment.structuredContent).toMatchObject({
      assignment: { progressBps: 5_000, status: 'in_progress' },
    });
    expect(JSON.stringify([course, assignment])).not.toMatch(
      /questionBank|contentRef|submissionRef|EvidenceId|answer/iu,
    );
  });

  it('Care MCP 只读取离职进度，不返回原因、审批或执行证据', async () => {
    const store = assemble();
    store.care.getForMcp.mockResolvedValue({
      id: 'care-001', employeeId: 'employee-001', employmentId: 'employment-001',
      lastWorkingDate: '2026-07-31', accessDisableAt: '2026-07-31T10:00:00.000Z',
      status: 'clearing', tasks: { assets_cleared: 'pending' }, version: 4,
    });
    const denied = await store.service.getCareCase(
      'care-001', extra(['erp:mcp:server:connect', 'erp:care:case:read']),
    );
    expect(denied.isError).toBe(true);
    expect(store.care.getForMcp).not.toHaveBeenCalled();
    const result = await store.service.getCareCase('care-001', extra([
      'erp:mcp:server:connect', 'erp:care:case:read', 'erp:care:employment:read',
    ]));
    expect(result.structuredContent).toMatchObject({
      careCase: { status: 'clearing', tasks: { assets_cleared: 'pending' } },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /reasonCode|separationType|approvalInstanceId|EvidenceId|execution/iu,
    );
  });

  it('Payroll MCP 只返回周期汇总，缺少财务读取 Scope 时失败关闭', async () => {
    const store = assemble();
    store.payroll.getPeriod.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4P1', period: '2026-07', status: 'review', version: 3,
      activeRunId: '01J8ZQK7V0A2M4N6P8R0T2W4P2', inputSnapshotHash: 'a'.repeat(43),
      resultHash: 'b'.repeat(43), employeeCount: 12, totalGrossMinor: 12_000_000,
      totalTaxMinor: 800_000, totalNetMinor: 9_500_000,
    });
    const denied = await store.service.getPayrollPeriod(
      '01J8ZQK7V0A2M4N6P8R0T2W4P1', extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.payroll.getPeriod).not.toHaveBeenCalled();
    const result = await store.service.getPayrollPeriod(
      '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      extra(['erp:mcp:server:connect', 'erp:payroll:period:read']),
    );
    expect(result.structuredContent).toMatchObject({
      payrollPeriod: { period: '2026-07', employeeCount: 12, status: 'review' },
    });
    expect(JSON.stringify(result)).not.toMatch(/employeeId|baseSalary|calculationLine|profile/iu);
  });

  it('薪资单 MCP 只复用本人应用服务且要求独立 L4 Scope', async () => {
    const store = assemble();
    store.payslips.getMyPayslip.mockResolvedValue({
      period: '2026-07', currency: 'CNY', taxableEarnings: [], nonTaxableEarnings: [],
      grossPayMinor: 1_000_000, employeeSocialInsuranceMinor: 100_000,
      employeeHousingFundMinor: 50_000, otherPreTaxWithholdingMinor: 0,
      specialAdditionalDeductionMinor: 0,
      postTaxDeductionMinor: 0, withholdingTaxMinor: 10_500, netPayMinor: 839_500,
      inputHash: 'a'.repeat(43), resultHash: 'b'.repeat(43),
      publishedAt: '2026-07-31T10:00:00.000Z',
    });
    const denied = await store.service.getMyPayrollPayslip(
      '2026-07', extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.payslips.getMyPayslip).not.toHaveBeenCalled();
    const result = await store.service.getMyPayrollPayslip(
      '2026-07', extra(['erp:mcp:server:connect', 'erp:payroll:sheet:read_self']),
    );
    expect(store.payslips.getMyPayslip).toHaveBeenCalledWith('2026-07');
    expect(result.structuredContent).toMatchObject({
      payslip: { period: '2026-07', netPayMinor: 839_500 },
    });
  });

  it('个税申报 MCP 只复用应用服务并返回控制摘要', async () => {
    const store = assemble();
    const filingId = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
    store.taxFilings.getStatus.mockResolvedValue({
      id: filingId, periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1',
      format: 'CN_IIT_WITHHOLDING_MANIFEST_V1', status: 'submitted', version: 4,
      contentHash: 'a'.repeat(43), employeeCount: 12,
      totalTaxableEarningsMinor: 12_000_000, totalWithholdingTaxMinor: 800_000,
      objectEvidenceId: 'tax-worm-evidence-001', taxSubmissionId: 'tax-submission-001',
      taxSubmissionEvidenceId: 'tax-evidence-001',
    });
    const denied = await store.service.getPayrollTaxFiling(
      filingId, extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.taxFilings.getStatus).not.toHaveBeenCalled();
    const result = await store.service.getPayrollTaxFiling(
      filingId, extra(['erp:mcp:server:connect', 'erp:payroll:tax:read']),
    );
    expect(result.structuredContent).toMatchObject({
      taxFiling: { id: filingId, status: 'submitted', employeeCount: 12 },
    });
    expect(JSON.stringify(result)).not.toMatch(/objectRef|identityEvidence|employeeId|preparedBy/iu);
  });

  it('四方对账 MCP 只读差异控制摘要且不暴露员工或账户', async () => {
    const store = assemble();
    const reconciliationId = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
    store.reconciliations.getStatus.mockResolvedValue({
      id: reconciliationId, periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1',
      batchId: '01J8ZQK7V0A2M4N6P8R0T2W4B1',
      bankReturnId: '01J8ZQK7V0A2M4N6P8R0T2W4N1',
      taxFilingId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', status: 'frozen',
      differences: ['PAYROLL_TAX_AMOUNT_MISMATCH'], evidenceHash: 'e'.repeat(43),
      employeeCount: 12, bankLineCount: 12, totalGrossMinor: 12_000_000,
      totalNetMinor: 9_500_000, bankSubmittedMinor: 9_500_000,
      bankReturnedMinor: 9_500_000, totalTaxableEarningsMinor: 10_000_000,
      payrollWithholdingTaxMinor: 800_000, filedWithholdingTaxMinor: 799_000, version: 1,
    });
    const denied = await store.service.getPayrollReconciliation(
      reconciliationId, extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.reconciliations.getStatus).not.toHaveBeenCalled();
    const result = await store.service.getPayrollReconciliation(
      reconciliationId,
      extra(['erp:mcp:server:connect', 'erp:payroll:reconciliation:read']),
    );
    expect(result.structuredContent).toMatchObject({
      reconciliation: { status: 'frozen', differences: ['PAYROLL_TAX_AMOUNT_MISMATCH'] },
    });
    expect(JSON.stringify(result)).not.toMatch(/employeeId|account|identityEvidence|objectRef/iu);
  });

  it('影子周期 MCP 只返回控制面与两期资格，永不读取行级差异', async () => {
    const store = assemble();
    const cycleId = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
    const readinessId = '01J8ZQK7V0A2M4N6P8R0T2W4G1';
    store.shadows.getCycle.mockResolvedValue({
      id: cycleId, periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      payrollRunId: '01J8ZQK7V0A2M4N6P8R0T2W4R1', period: '2026-07',
      sourceSystem: 'legacy-payroll', sourceManifestHash: 'm'.repeat(43),
      payrollResultHash: 'p'.repeat(43), comparisonHash: 'c'.repeat(43), status: 'signed',
      erpEmployeeCount: 12, legacyEmployeeCount: 12,
      erpTotalGrossMinor: 12_000_000, legacyTotalGrossMinor: 12_000_000,
      erpTotalTaxMinor: 800_000, legacyTotalTaxMinor: 800_000,
      erpTotalNetMinor: 9_500_000, legacyTotalNetMinor: 9_500_000,
      differenceCodes: [], differenceCount: 0, explainedDifferenceCount: 0,
      unresolvedDifferenceCount: 0, totalAbsoluteDifferenceMinor: 0,
      payrollSignoffId: '01J8ZQK7V0A2M4N6P8R0T2W4S1',
      financeSignoffId: '01J8ZQK7V0A2M4N6P8R0T2W4S2',
      cutoverReadinessId: readinessId, version: 1,
    });
    store.shadows.getReadiness.mockResolvedValue({
      id: readinessId, firstCycleId: '01J8ZQK7V0A2M4N6P8R0T2W4C0', secondCycleId: cycleId,
      startPeriod: '2026-06', endPeriod: '2026-07', evidenceHash: 'e'.repeat(43),
      status: 'eligible', version: 1,
    });
    const denied = await store.service.getPayrollShadowCycle(
      cycleId, extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.shadows.getCycle).not.toHaveBeenCalled();
    const scopes = extra(['erp:mcp:server:connect', 'erp:payroll:shadow:read']);
    const cycle = await store.service.getPayrollShadowCycle(cycleId, scopes);
    const readiness = await store.service.getPayrollCutoverReadiness(readinessId, scopes);
    expect(cycle.structuredContent).toMatchObject({
      shadowCycle: { status: 'signed', unresolvedDifferenceCount: 0 },
    });
    expect(readiness.structuredContent).toMatchObject({
      cutoverReadiness: { status: 'eligible', endPeriod: '2026-07' },
    });
    expect(JSON.stringify([cycle, readiness])).not.toMatch(
      /employeeId|deltaMinor|explanationEvidence|signedBy|strongAuthEvidence/iu,
    );
  });

  it('工资调整和年度薪税 MCP 只返回脱敏控制状态', async () => {
    const store = assemble();
    const adjustmentId = '01J8ZQK7V0A2M4N6P8R0T2W4A1';
    const annualId = '01J8ZQK7V0A2M4N6P8R0T2W4Y1';
    store.payrollAdjustments.getControlStatus.mockResolvedValue({
      id: adjustmentId, period: '2026-07', adjustmentNumber: 1,
      type: 'supplement', reasonCode: 'RETROACTIVE_SALARY_CHANGE',
      status: 'prepared', version: 1, adjustmentHash: 'a'.repeat(43),
    });
    store.annualPayrollReconciliations.getControlStatus.mockResolvedValue({
      id: annualId, taxYear: '2026', periodCount: 12,
      firstPeriod: '2026-01', lastPeriod: '2026-12',
      status: 'assessment_matched', version: 1, evidenceHash: 'e'.repeat(43),
    });
    const denied = await store.service.getPayrollAdjustmentStatus(
      adjustmentId, extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    const adjustment = await store.service.getPayrollAdjustmentStatus(
      adjustmentId,
      extra(['erp:mcp:server:connect', 'erp:payroll:adjustment:read']),
    );
    const annual = await store.service.getAnnualPayrollReconciliationStatus(
      annualId,
      extra(['erp:mcp:server:connect', 'erp:payroll:annual:read']),
    );
    expect(adjustment.structuredContent).toMatchObject({
      payrollAdjustment: { id: adjustmentId, status: 'prepared' },
    });
    expect(annual.structuredContent).toMatchObject({
      annualPayrollReconciliation: { id: annualId, status: 'assessment_matched' },
    });
    expect(JSON.stringify([adjustment, annual])).not.toMatch(
      /employeeId|payableMinor|receivableMinor|assessedTax|withheld|filingEvidence/iu,
    );
  });

  it('考勤修订准备只校验本人事实并固化 R1 命令，不直接创建审批', async () => {
    const store = assemble();
    store.attendance.validateCorrectionRequest.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F1', employeeId: 'employee-001',
      providerCode: 'dingtalk', factType: 'shift', businessDate: '2026-04-01',
    });
    const result = await store.service.prepareAttendanceCorrectionRequest({
      sourceFactId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', workedMinutes: 420,
      leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
      reasonCode: 'MISSED_BREAK', prepareKey: 'attendance-prepare-001',
    }, extra(['erp:attendance:correction:request', 'erp:approval:instance:submit']));
    expect(result.structuredContent).toMatchObject({ riskLevel: 'R1' });
    expect(store.confirmations.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', actorId: 'employee-001' }),
      'attendance-prepare-001',
      {
        operation: 'attendance.correction.request',
        sourceFactId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', expectedVersion: 1,
        workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0,
        absentMinutes: 0, reasonCode: 'MISSED_BREAK',
      },
      'R1',
    );
    expect(store.attendance.requestCorrection).not.toHaveBeenCalled();
  });

  it('考勤修订执行只消费确认账本命令并复用 Attendance 应用服务', async () => {
    const store = assemble();
    store.confirmations.claim.mockResolvedValue({
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4A1', replayResult: null,
      command: {
        operation: 'attendance.correction.request',
        sourceFactId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', expectedVersion: 1,
        workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0,
        absentMinutes: 0, reasonCode: 'MISSED_BREAK',
      },
    });
    store.attendance.requestCorrection.mockResolvedValue({
      request: {
        approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4A2', approvalStatus: 'running',
        approvalVersion: 2, sourceFactId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
        employeeId: 'employee-001', businessDate: '2026-04-01',
      },
    });
    const result = await store.service.executeAttendanceCorrectionRequest(
      '01J8ZQK7V0A2M4N6P8R0T2W4A1', `mcpc_${'a'.repeat(43)}`,
      extra(['erp:attendance:correction:request', 'erp:approval:instance:submit']),
    );
    expect(store.attendance.requestCorrection).toHaveBeenCalledWith(
      'mcp:01J8ZQK7V0A2M4N6P8R0T2W4A1',
      {
        sourceFactId: '01J8ZQK7V0A2M4N6P8R0T2W4F1',
        replacementImpact: {
          workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
        },
        reasonCode: 'MISSED_BREAK',
      },
    );
    expect(store.confirmations.complete).toHaveBeenCalledOnce();
    expect(result.structuredContent).toMatchObject({ request: { approvalStatus: 'running' } });
  });

  it('Offer 发送准备只固化标识和版本并要求 R2 确认', async () => {
    const store = assemble();
    store.confirmations.prepare.mockResolvedValue({
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', digest: 'a'.repeat(43),
      riskLevel: 'R2', expiresAt: '2026-07-21T00:10:00.000Z',
      confirmationUrl: 'https://erp.example.com/mcp/confirm?operation_id=01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    });
    store.recruitmentOffers.get.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', status: 'approved', version: 3,
    });
    const result = await store.service.prepareRecruitmentOfferSend(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y6', 3, 'offer-prepare-001',
      extra(['erp:recruitment:offer:read', 'erp:recruitment:offer:send']),
    );
    expect(result.structuredContent).toMatchObject({ riskLevel: 'R2' });
    expect(store.confirmations.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001', actorId: 'employee-001' }),
      'offer-prepare-001',
      {
        operation: 'recruitment.offer.request_send',
        offerId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', expectedVersion: 3,
      },
      'R2',
    );
    expect(store.recruitmentOffers.requestSend).not.toHaveBeenCalled();
  });

  it('招聘执行工具只消费确认账本固化命令并使用服务端幂等键', async () => {
    const store = assemble();
    store.recruitmentOffers.requestSend.mockResolvedValue({
      offer: { id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', status: 'sending', version: 4 },
    });
    store.confirmations.claim.mockResolvedValue({
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
      command: {
        operation: 'recruitment.offer.request_send',
        offerId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', expectedVersion: 3,
      },
      replayResult: null,
    });
    const result = await store.service.executeRecruitmentOfferSend(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y7', `mcpc_${'a'.repeat(43)}`,
      extra(['erp:recruitment:offer:send']),
    );
    expect(store.recruitmentOffers.requestSend).toHaveBeenCalledWith(
      '01J8ZQK7V0A2M4N6P8R0T2W4Y6', 3,
      'mcp:01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    );
    const completed = store.confirmations.complete.mock.calls[0] as unknown as [
      string,
      Readonly<Record<string, unknown>>,
    ];
    expect(completed[0]).toBe('01J8ZQK7V0A2M4N6P8R0T2W4Y7');
    expect(completed[1]).toHaveProperty('offer');
    expect(result.structuredContent).toMatchObject({ offer: { status: 'sending' } });
  });

  it('OP 经营摘要 Tool 仅凭 Scope 复用只读应用服务', async () => {
    const store = assemble();
    store.opSummaries.getLatest.mockResolvedValue({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4D1', summaryDate: '2026-07-22', revision: 2,
      payloadHash: 'o'.repeat(43), metrics: { gmvMinor: 100 },
    });
    const denied = await store.service.getOpOperatingSummary('2026-07-22', extra([]));
    expect(denied.isError).toBe(true);
    expect(store.opSummaries.getLatest).not.toHaveBeenCalled();
    const result = await store.service.getOpOperatingSummary(
      '2026-07-22', extra(['erp:op:operating_summary:read']),
    );
    expect(store.opSummaries.getLatest).toHaveBeenCalledWith('2026-07-22');
    expect(result.structuredContent).toMatchObject({
      operatingSummary: { summaryDate: '2026-07-22', revision: 2 },
    });
  });

  it('OP 审批桥 Tool 只读复用应用服务且不返回表单正文', async () => {
    const store = assemble();
    store.opApprovalBridges.get.mockResolvedValue({
      externalEventId: 'op-approval-event-001', sourceDocumentType: 'purchase_order',
      sourceDocumentId: 'po-001', approvalInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4D2',
      templateCode: 'PURCHASE_ORDER', approvalStatus: 'running', approvalVersion: 2,
      completedAt: null, updatedAt: '2026-07-22T08:00:01.000Z',
    });
    const denied = await store.service.getOpApprovalBridge('op-approval-event-001', extra([]));
    expect(denied.isError).toBe(true);
    expect(store.opApprovalBridges.get).not.toHaveBeenCalled();
    const result = await store.service.getOpApprovalBridge(
      'op-approval-event-001', extra(['erp:op:approval_bridge:read']),
    );
    expect(store.opApprovalBridges.get).toHaveBeenCalledWith('op-approval-event-001');
    expect(result.structuredContent).toMatchObject({
      approvalBridge: { approvalStatus: 'running', approvalVersion: 2 },
    });
    expect(JSON.stringify(result)).not.toMatch(/formData|payloadCiphertext/iu);
  });

  it('管理驾驶舱 Tool 复用统一指标服务且缺 Scope 时失败关闭', async () => {
    const store = assemble();
    store.managementDashboard.get.mockResolvedValue({
      asOf: '2026-07-22', sources: ['org_employees'],
      workforce: { activeHeadcount: 280 }, approvals: { running: 12 },
    });
    const denied = await store.service.getManagementDashboard('2026-07-22', extra([]));
    expect(denied.isError).toBe(true);
    expect(store.managementDashboard.get).not.toHaveBeenCalled();
    const result = await store.service.getManagementDashboard(
      '2026-07-22', extra(['erp:analytics:management:read']),
    );
    expect(store.managementDashboard.get).toHaveBeenCalledWith('2026-07-22');
    expect(result.structuredContent).toMatchObject({
      dashboard: { workforce: { activeHeadcount: 280 } },
    });
  });

  it('管理驾驶舱导出必须经 R2 确认并返回异步资源链接', async () => {
    const store = assemble();
    store.managementDashboard.get.mockResolvedValue({ asOf: '2026-07-22' });
    store.confirmations.prepare.mockResolvedValueOnce({
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4E1', digest: 'b'.repeat(43), riskLevel: 'R2',
      expiresAt: '2026-07-22T00:10:00.000Z',
      confirmationUrl: 'https://erp.example.com/mcp/confirm?operation_id=01J8ZQK7V0A2M4N6P8R0T2W4E1',
    });
    const scopes = ['erp:analytics:management:read', 'erp:analytics:management:export'];
    const prepared = await store.service.prepareManagementDashboardExport(
      '2026-07-22', 'export-key-001', extra(scopes),
    );
    expect(prepared.structuredContent).toMatchObject({ riskLevel: 'R2' });
    expect(store.confirmations.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001' }),
      'export-key-001',
      {
        operation: 'analytics.management_dashboard.export', asOf: '2026-07-22',
        format: 'json', expectedVersion: 1,
      },
      'R2',
    );

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4E1', replayResult: null,
      command: {
        operation: 'analytics.management_dashboard.export', asOf: '2026-07-22',
        format: 'json', expectedVersion: 1,
      },
    });
    store.analyticsExports.request.mockResolvedValueOnce({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4E1', asOf: '2026-07-22', format: 'json',
      status: 'queued', resourceUri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
      contentHash: null, artifact: null, expiresAt: '2026-07-23T00:00:00.000Z',
    });
    const executed = await store.service.executeManagementDashboardExport(
      '01J8ZQK7V0A2M4N6P8R0T2W4E1', `mcpc_${'c'.repeat(43)}`, extra(scopes),
    );
    expect(executed.structuredContent).toMatchObject({ export: { status: 'queued' } });
    expect(executed.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'resource_link',
        uri: 'erp://analytics/exports/01J8ZQK7V0A2M4N6P8R0T2W4E1',
      }),
    ]));
    expect(store.confirmations.complete).toHaveBeenCalledOnce();
  });

  it('迁移差异报告 Tool 只读复用控制面且不返回来源正文', async () => {
    const store = assemble();
    store.dataMigrations.report.mockResolvedValue({
      runId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', status: 'failed',
      differences: [{ code: 'REJECTED_RECORDS', severity: 'critical', count: 1 }],
      phaseSixEligible: false,
    });
    const denied = await store.service.getDataMigrationReport(
      '01J8ZQK7V0A2M4N6P8R0T2W4F1', extra([]),
    );
    expect(denied.isError).toBe(true);
    expect(store.dataMigrations.report).not.toHaveBeenCalled();
    const result = await store.service.getDataMigrationReport(
      '01J8ZQK7V0A2M4N6P8R0T2W4F1', extra(['erp:migration:read']),
    );
    expect(result.structuredContent).toMatchObject({
      report: { status: 'failed', phaseSixEligible: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/payload|attachmentContent|displayName/iu);
  });
});
