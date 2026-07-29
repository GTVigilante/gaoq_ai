import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { GoneException, Logger, UnauthorizedException } from '@nestjs/common';
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
import type { KnowledgeExamRunService } from '../knowledge/application/knowledge-exam-run.service.js';
import type { CareApplicationService } from '../care/application/care-application.service.js';
import type { CareOccasionApplicationService } from '../care/application/care-occasion-application.service.js';
import type { CareAlumniCleanupApplicationService } from '../care/application/care-alumni-cleanup-application.service.js';
import type { AttendanceApplicationService } from '../attendance/application/attendance-application.service.js';
import type { PayrollRunService } from '../payroll/application/payroll-run.service.js';
import type { PayrollPayslipService } from '../payroll/application/payroll-payslip.service.js';
import type { PayrollTaxFilingService } from '../payroll/application/payroll-tax-filing.service.js';
import type { PayrollReconciliationService } from '../payroll/application/payroll-reconciliation.service.js';
import type { PayrollShadowService } from '../payroll/application/payroll-shadow.service.js';
import type { PayrollAdjustmentService } from '../payroll/application/payroll-adjustment.service.js';
import type {
  PayrollAdjustmentTaxCorrectionService,
} from '../payroll/application/payroll-adjustment-tax-correction.service.js';
import type {
  PayrollAnnualReconciliationService,
} from '../payroll/application/payroll-annual-reconciliation.service.js';
import type { OpOperatingSummaryService } from '../op/application/op-operating-summary.service.js';
import type { OpApprovalBridgeService } from '../op/application/op-approval-bridge.service.js';
import type { ManagementDashboardService } from '../analytics/application/management-dashboard.service.js';
import type { AnalyticsExportService } from '../analytics/application/analytics-export.service.js';
import type { DataMigrationService } from '../data-migration/application/data-migration.service.js';
import type { TalentLifecycleService } from '../talent-lifecycle/application/talent-lifecycle.service.js';
import type { MarketingCmsService } from '../marketing-cms/marketing-cms.service.js';
import { McpToolService } from './mcp-tool.service.js';
import type { McpConfirmationService } from './mcp-confirmation.service.js';

type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function extra(
  scopes: readonly string[],
  actorType: 'user' | 'service' | 'mcp_client' | 'system_job' = 'user',
): McpExtra {
  const authInfo: AuthInfo = {
    token: 'opaque-redacted',
    clientId: 'ai-client-001',
    scopes: [...scopes],
    expiresAt: 1_900_000_000,
    resource: new URL('https://erp.example.com/mcp'),
    extra: {
      tenantId: 'tenant-001',
      actorId: 'employee-001',
      actorType,
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
  const knowledge = {
    getCourse: vi.fn(),
    getAssignment: vi.fn(),
    searchMyKnowledge: vi.fn(),
  };
  const knowledgeExamRuns = { get: vi.fn() };
  const care = { getForMcp: vi.fn() };
  const careOccasions = { getMySummaryForMcp: vi.fn() };
  const careAlumniCleanup = { getStatusForMcp: vi.fn() };
  const attendance = {
    getMyMonth: vi.fn(), validateCorrectionRequest: vi.fn(), requestCorrection: vi.fn(),
  };
  const payroll = { getPeriod: vi.fn() };
  const payslips = { getMyPayslip: vi.fn() };
  const taxFilings = { getStatus: vi.fn() };
  const reconciliations = { getStatus: vi.fn() };
  const shadows = { getCycle: vi.fn(), getReadiness: vi.fn() };
  const payrollAdjustments = { getControlStatus: vi.fn() };
  const payrollAdjustmentTaxCorrections = { getControlStatus: vi.fn() };
  const annualPayrollReconciliations = { getControlStatus: vi.fn() };
  const opSummaries = { getLatest: vi.fn() };
  const opApprovalBridges = { get: vi.fn() };
  const managementDashboard = { get: vi.fn(), validateAsOf: vi.fn() };
  const analyticsExports = { get: vi.fn(), request: vi.fn() };
  const dataMigrations = { report: vi.fn() };
  const talentLifecycle = { getForMcp: vi.fn() };
  const marketing = { getSideEffectStatus: vi.fn() };
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
    knowledgeExamRuns as unknown as KnowledgeExamRunService,
    care as unknown as CareApplicationService,
    attendance as unknown as AttendanceApplicationService,
    payroll as unknown as PayrollRunService,
    payslips as unknown as PayrollPayslipService,
    taxFilings as unknown as PayrollTaxFilingService,
    reconciliations as unknown as PayrollReconciliationService,
    shadows as unknown as PayrollShadowService,
    payrollAdjustments as unknown as PayrollAdjustmentService,
    payrollAdjustmentTaxCorrections as unknown as PayrollAdjustmentTaxCorrectionService,
    annualPayrollReconciliations as unknown as PayrollAnnualReconciliationService,
    opSummaries as unknown as OpOperatingSummaryService,
    opApprovalBridges as unknown as OpApprovalBridgeService,
    managementDashboard as unknown as ManagementDashboardService,
    analyticsExports as unknown as AnalyticsExportService,
    dataMigrations as unknown as DataMigrationService,
    talentLifecycle as unknown as TalentLifecycleService,
    marketing as unknown as MarketingCmsService,
    confirmations as unknown as McpConfirmationService,
    careOccasions as unknown as CareOccasionApplicationService,
    careAlumniCleanup as unknown as CareAlumniCleanupApplicationService,
  );
  return {
    context, audit, organization, approvals, recruitmentApplications,
    recruitmentInterviews, recruitmentManagement, recruitmentOffers, confirmations, service,
    onboarding, knowledge, knowledgeExamRuns, care, careOccasions, careAlumniCleanup,
    attendance, payroll, payslips,
    taxFilings, reconciliations, shadows,
    payrollAdjustments, payrollAdjustmentTaxCorrections, annualPayrollReconciliations,
    opSummaries, opApprovalBridges, managementDashboard, analyticsExports, dataMigrations,
    talentLifecycle,
    marketing,
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
        departments: [{
          id: 'department-001',
          tenantId: 'tenant-001',
          code: 'FIN',
          name: '财务部',
          status: 'active' as const,
          parentId: null,
          managerId: null,
          sortOrder: 0,
          version: 2,
          createdAt: '2026-07-29T00:00:00.000Z',
          updatedAt: '2026-07-29T00:00:00.000Z',
        }],
        employees: [{
          id: 'employee-001',
          tenantId: 'tenant-001',
          employeeNo: 'E001',
          displayName: '员工甲',
          status: 'active' as const,
          departmentIds: ['department-001'],
          primaryDepartmentId: 'department-001',
          positionIds: [],
          jobLevelId: null,
          version: 3,
          createdAt: '2026-07-29T00:00:00.000Z',
          updatedAt: '2026-07-29T00:00:00.000Z',
        }],
      });
    });

    const result = await store.service.getOrgChart(extra(['erp:mcp:server:connect', 'erp:org:chart:read']));

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      departments: [{
        id: 'department-001',
        code: 'FIN',
        name: '财务部',
        status: 'active',
        parentId: null,
        managerId: null,
        sortOrder: 0,
        version: 2,
      }],
      employees: [{
        id: 'employee-001',
        employeeNo: 'E001',
        displayName: '员工甲',
        status: 'active',
        departmentIds: ['department-001'],
        primaryDepartmentId: 'department-001',
        positionIds: [],
        jobLevelId: null,
        version: 3,
      }],
    });
    expect(JSON.stringify(result)).not.toContain('tenantId');
    expect(JSON.stringify(result)).not.toContain('createdAt');
    expect(JSON.stringify(result)).not.toContain('updatedAt');
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

  it('知识搜索 MCP 复用本人授权应用服务且不接受客户端租户或员工标识', async () => {
    const store = assemble();
    store.knowledge.searchMyKnowledge.mockResolvedValue({
      items: [{
        course: {
          id: 'course-001', courseCode: 'SECURITY', revision: 1, title: '安全培训',
          examRequired: false, passingScoreBps: null, status: 'published', version: 2,
        },
        snippetText: '企业信息安全基础',
        highlights: [{ start: 2, end: 6 }],
        scoreBps: 9_000,
        indexedAt: '2026-07-27T00:00:00.000Z',
      }],
      nextCursor: null,
    });
    const denied = await store.service.searchKnowledge(
      { query: '信息安全', limit: 10 },
      extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.knowledge.searchMyKnowledge).not.toHaveBeenCalled();
    const result = await store.service.searchKnowledge(
      { query: '信息安全', limit: 10 },
      extra(['erp:mcp:server:connect', 'erp:knowledge:search']),
    );
    expect(store.knowledge.searchMyKnowledge).toHaveBeenCalledWith({
      query: '信息安全',
      limit: 10,
    });
    expect(result.structuredContent).toMatchObject({
      items: [{ course: { id: 'course-001' }, snippetText: '企业信息安全基础' }],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /tenantId|employeeId|departmentIds|positionIds|contentRef|questionBank|answer/iu,
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

  it('关怀 MCP 只返回本人最小状态计数且不开放写能力', async () => {
    const store = assemble();
    store.careOccasions.getMySummaryForMcp.mockResolvedValue({
      configured: true,
      birthdayEnabled: true,
      anniversaryEnabled: false,
      unsubscribed: false,
      pendingCount: 1,
      deliveredCount: 2,
      attentionRequiredCount: 0,
    });
    const denied = await store.service.getMyCareOccasionSummary(
      extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.careOccasions.getMySummaryForMcp).not.toHaveBeenCalled();
    const result = await store.service.getMyCareOccasionSummary(extra([
      'erp:mcp:server:connect',
      'erp:care:occasion:preference:read',
    ]));
    expect(result.structuredContent).toEqual({
      occasionSummary: {
        configured: true,
        birthdayEnabled: true,
        anniversaryEnabled: false,
        unsubscribed: false,
        pendingCount: 1,
        deliveredCount: 2,
        attentionRequiredCount: 0,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /birthdayMonthDay|scheduledAt|employeeId|contact|EvidenceId|templateCode|body/iu,
    );
  });

  it('校友清理 MCP 只返回终止状态与固定计数', async () => {
    const store = assemble();
    const consentId = '01J8ZQK7V0A2M4N6P8R0T2W4C4';
    store.careAlumniCleanup.getStatusForMcp.mockResolvedValue({
      consentStatus: 'withdrawn',
      cleanupStatus: 'attention_required',
      counts: { pending: 0, dispatching: 0, completed: 2, dead: 1 },
    });
    const denied = await store.service.getCareAlumniCleanupStatus(
      consentId,
      extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.careAlumniCleanup.getStatusForMcp).not.toHaveBeenCalled();
    const result = await store.service.getCareAlumniCleanupStatus(
      consentId,
      extra(['erp:mcp:server:connect', 'erp:care:alumni:cleanup:read']),
    );
    expect(result.structuredContent).toEqual({
      cleanupStatus: {
        consentStatus: 'withdrawn',
        cleanupStatus: 'attention_required',
        counts: { pending: 0, dispatching: 0, completed: 2, dead: 1 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /person|contact|channel|target|proof|evidence|completedAt/iu,
    );
  });

  it('人才全周期 MCP 只返回阶段和待办，不返回身份或服务备注', async () => {
    const store = assemble();
    const candidateId = '01J8ZQK7V0A2M4N6P8R0T2W4E1';
    store.talentLifecycle.getForMcp.mockResolvedValue({
      candidateId,
      stage: 'recruiting',
      currentApplicationStage: 'interview',
      employeeStatus: null,
      openFollowUpCount: 1,
      nextActionAt: '2026-07-28T08:00:00.000Z',
      updatedAt: '2026-07-27T08:00:00.000Z',
    });
    const denied = await store.service.getTalentLifecycle(
      candidateId,
      extra(['erp:mcp:server:connect']),
    );
    expect(denied.isError).toBe(true);
    expect(store.talentLifecycle.getForMcp).not.toHaveBeenCalled();
    const result = await store.service.getTalentLifecycle(
      candidateId,
      extra(['erp:mcp:server:connect', 'erp:talent-lifecycle:read']),
    );
    expect(result.structuredContent).toMatchObject({
      lifecycle: { stage: 'recruiting', openFollowUpCount: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /displayName|phone|email|note|reasonCode|EvidenceId/iu,
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

  it('专业工资模式的迁移响应原样失败关闭且不误记读取成功', async () => {
    const store = assemble();
    store.payslips.getMyPayslip.mockRejectedValue(new GoneException({
      code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM',
      message: '工资能力已迁移至专业算薪系统',
      payrollWebOrigin: 'https://payroll.example.test',
    }));

    const moved = await store.service.getMyPayrollPayslip(
      '2026-07',
      extra(['erp:mcp:server:connect', 'erp:payroll:sheet:read_self']),
    );
    expect(moved.isError).toBe(true);
    const firstContent = moved.content[0];
    const text = firstContent?.type === 'text' ? firstContent.text : '';
    expect(text).toContain('PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM');
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'mcp.tool.payroll_payslip_get_self',
      outcome: 'denied',
    }));
  });

  it('不把无关的 410 异常误报为专业工资迁移', async () => {
    const store = assemble();
    store.payslips.getMyPayslip.mockRejectedValue(new GoneException({
      code: 'PAYROLL_PAYSLIP_ARCHIVED',
      message: '薪资单已归档',
    }));

    await expect(store.service.getMyPayrollPayslip(
      '2026-07',
      extra(['erp:mcp:server:connect', 'erp:payroll:sheet:read_self']),
    )).rejects.toMatchObject({
      response: { code: 'PAYROLL_PAYSLIP_ARCHIVED' },
    });
    expect(store.audit.record).not.toHaveBeenCalled();
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
    const deniedReadiness = await store.service.getPayrollCutoverReadiness(
      readinessId,
      extra(['erp:mcp:server:connect']),
    );
    expect(deniedReadiness.isError).toBe(true);
    expect(store.shadows.getReadiness).not.toHaveBeenCalled();
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
    const correctionId = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
    const annualId = '01J8ZQK7V0A2M4N6P8R0T2W4Y1';
    store.payrollAdjustments.getControlStatus.mockResolvedValue({
      id: adjustmentId, period: '2026-07', adjustmentNumber: 1,
      type: 'supplement', reasonCode: 'RETROACTIVE_SALARY_CHANGE',
      status: 'prepared', cashSettlementStatus: 'pending',
      taxCorrectionStatus: 'pending',
      version: 1, adjustmentHash: 'a'.repeat(43),
    });
    store.payrollAdjustmentTaxCorrections.getControlStatus.mockResolvedValue({
      id: correctionId,
      adjustmentId,
      period: '2026-07',
      format: 'CN_IIT_WITHHOLDING_CORRECTION_V1',
      contentHash: 'c'.repeat(43),
      objectEvidenceId: 'worm-correction-evidence-001',
      taxSubmissionEvidenceId: null,
      status: 'prepared',
      version: 2,
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
    const correction =
      await store.service.getPayrollAdjustmentTaxCorrectionStatus(
        correctionId,
        extra([
          'erp:mcp:server:connect',
          'erp:payroll:adjustment:tax_correction:read',
        ]),
      );
    expect(adjustment.structuredContent).toMatchObject({
      payrollAdjustment: {
        id: adjustmentId, status: 'prepared',
        cashSettlementStatus: 'pending', taxCorrectionStatus: 'pending',
      },
    });
    expect(annual.structuredContent).toMatchObject({
      annualPayrollReconciliation: { id: annualId, status: 'assessment_matched' },
    });
    expect(correction.structuredContent).toMatchObject({
      payrollAdjustmentTaxCorrection: {
        id: correctionId,
        adjustmentId,
        status: 'prepared',
      },
    });
    expect(JSON.stringify([adjustment, annual, correction])).not.toMatch(
      /employeeId|payableMinor|receivableMinor|assessedTax|withheld|taxableEarningsMinor/iu,
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
      summaryDate: '2026-07-22', revision: 2, currency: 'CNY',
      metrics: {
        gmvMinor: 100, paidOrderCount: 2, refundMinor: 1,
        refundOrderCount: 1, activeCustomerCount: 2,
      },
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
    store.confirmations.prepare.mockResolvedValueOnce({
      operationId: '01J8ZQK7V0A2M4N6P8R0T2W4E1', digest: 'b'.repeat(43), riskLevel: 'R2',
      expiresAt: '2026-07-22T00:10:00.000Z',
      confirmationUrl: 'https://erp.example.com/mcp/confirm?operation_id=01J8ZQK7V0A2M4N6P8R0T2W4E1',
    });
    const scopes = ['erp:analytics:management:read', 'erp:analytics:management:export'];
    const prepared = await store.service.prepareManagementDashboardExport(
      '2026-07-22', 'export-key-001', extra(scopes),
    );
    expect(store.managementDashboard.validateAsOf).toHaveBeenCalledWith('2026-07-22');
    expect(store.managementDashboard.get).not.toHaveBeenCalled();
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

  it('营销副作用 Tool 只读复用应用服务并拒绝客户端租户参数', async () => {
    const store = assemble();
    const eventId = '01J8ZQK7V0A2M4N6P8R0T2W4Y0';
    store.marketing.getSideEffectStatus.mockResolvedValue({
      eventId,
      kind: 'lead_notification',
      aggregateId: 'lead-001',
      aggregateVersion: 1,
      channel: 'email',
      status: 'dead',
      attempts: 1,
      deliveryAttempts: 6,
      nextAttemptAt: '2026-07-27T00:00:00.000Z',
      dispatchedAt: '2026-07-27T00:00:01.000Z',
      completedAt: '2026-07-27T00:01:00.000Z',
      lastErrorCode: 'MARKETING_NOTIFICATION_GATEWAY_FAILED',
    });
    const denied = await store.service.getMarketingSideEffect(eventId, extra([]));
    expect(denied.isError).toBe(true);
    expect(store.marketing.getSideEffectStatus).not.toHaveBeenCalled();

    const result = await store.service.getMarketingSideEffect(
      eventId,
      extra(['erp:marketing:operations:read']),
    );
    expect(store.marketing.getSideEffectStatus).toHaveBeenCalledWith(eventId);
    expect(result.structuredContent).toMatchObject({
      sideEffect: {
        eventId,
        status: 'dead',
        lastErrorCode: 'MARKETING_NOTIFICATION_GATEWAY_FAILED',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/tenant-001|contact|requestSummary/u);
  });

  it('招聘、考试、考勤与导出只读 Tool 均复用对应应用服务', async () => {
    const store = assemble();
    store.recruitmentApplications.getApplication.mockResolvedValue({
      id: 'application-001', stage: 'interview', version: 2,
    });
    store.recruitmentManagement.getRequisition.mockResolvedValue({
      id: 'requisition-001', status: 'approved', version: 3,
    });
    store.recruitmentManagement.getPosition.mockResolvedValue({
      id: 'position-001', status: 'open', version: 4,
    });
    store.recruitmentInterviews.get.mockResolvedValue({
      id: 'interview-001', status: 'scheduled', version: 1,
    });
    store.knowledgeExamRuns.get.mockResolvedValue({
      id: 'exam-run-001', status: 'in_progress', attemptNumber: 1,
    });
    store.attendance.getMyMonth.mockResolvedValue({
      month: '2026-07', status: 'open', workedMinutes: 9_600,
    });
    store.analyticsExports.get.mockResolvedValue({
      id: 'export-001', status: 'ready',
      resourceUri: 'erp://analytics/exports/export-001',
    });

    const application = await store.service.getRecruitmentApplication(
      'application-001',
      extra(['erp:recruitment:application:read']),
    );
    const requisition = await store.service.getRecruitmentRequisition(
      'requisition-001',
      extra(['erp:recruitment:management:read']),
    );
    const position = await store.service.getRecruitmentPosition(
      'position-001',
      extra(['erp:recruitment:management:read']),
    );
    const interview = await store.service.getRecruitmentInterview(
      'interview-001',
      extra(['erp:recruitment:interview:read']),
    );
    const examRun = await store.service.getKnowledgeExamRun(
      'exam-run-001',
      extra(['erp:knowledge:exam:read']),
    );
    const deniedAttendance = await store.service.getMyAttendanceMonth(
      '2026-07',
      extra([]),
    );
    const attendanceMonth = await store.service.getMyAttendanceMonth(
      '2026-07',
      extra(['erp:attendance:month:read_self']),
    );
    const deniedExport = await store.service.getAnalyticsExport(
      'export-001',
      extra([]),
    );
    const exportResult = await store.service.getAnalyticsExport(
      'export-001',
      extra(['erp:analytics:management:export']),
    );

    expect(application.structuredContent).toMatchObject({
      application: { stage: 'interview' },
    });
    expect(requisition.structuredContent).toMatchObject({
      requisition: { status: 'approved' },
    });
    expect(position.structuredContent).toMatchObject({
      position: { status: 'open' },
    });
    expect(interview.structuredContent).toMatchObject({
      interview: { status: 'scheduled' },
    });
    expect(examRun.structuredContent).toMatchObject({
      examRun: { status: 'in_progress' },
    });
    expect(deniedAttendance.isError).toBe(true);
    expect(attendanceMonth.structuredContent).toMatchObject({
      attendanceMonth: { month: '2026-07' },
    });
    expect(deniedExport.isError).toBe(true);
    expect(exportResult.structuredContent).toMatchObject({
      export: { status: 'ready' },
    });
  });

  it('审批详情与时间线缺少读取 Scope 时失败关闭，服务身份使用可信上下文', async () => {
    const store = assemble();
    const deniedInstance = await store.service.getApprovalInstance(
      'instance-001',
      extra([]),
    );
    const deniedTimeline = await store.service.getApprovalTimeline(
      'instance-001',
      extra([]),
    );
    expect(deniedInstance.isError).toBe(true);
    expect(deniedTimeline.isError).toBe(true);
    expect(store.approvals.getInstance).not.toHaveBeenCalled();
    expect(store.approvals.getTimeline).not.toHaveBeenCalled();

    await store.service.getMyPermissions(
      extra(['erp:mcp:server:connect'], 'system_job'),
    );
    expect(store.audit.record).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'mcp.tool.get_my_permissions',
      outcome: 'success',
    }));
  });

  it('招聘准备 Tool 对 Scope、权威状态、版本和目标状态失败关闭', async () => {
    const store = assemble();
    const denied = await store.service.prepareRecruitmentRequisitionSubmit(
      'requisition-001',
      2,
      'requisition-prepare-denied',
      extra(['erp:recruitment:management:read']),
    );
    expect(denied.isError).toBe(true);
    expect(store.recruitmentManagement.getRequisition).not.toHaveBeenCalled();

    store.recruitmentManagement.getRequisition
      .mockResolvedValueOnce({ id: 'requisition-001', status: 'approved', version: 2 })
      .mockResolvedValueOnce({ id: 'requisition-001', status: 'draft', version: 2 });
    const changed = await store.service.prepareRecruitmentRequisitionSubmit(
      'requisition-001',
      2,
      'requisition-prepare-changed',
      extra([
        'erp:recruitment:management:read',
        'erp:recruitment:requisition:submit',
      ]),
    );
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed)).toContain('RECRUITMENT_PREPARE_STATE_CHANGED');
    const prepared = await store.service.prepareRecruitmentRequisitionSubmit(
      'requisition-001',
      2,
      'requisition-prepare-ok',
      extra([
        'erp:recruitment:management:read',
        'erp:recruitment:requisition:submit',
      ]),
    );
    expect(prepared.structuredContent).toBeDefined();
    expect(store.confirmations.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: 'tenant-001' }),
      'requisition-prepare-ok',
      {
        operation: 'recruitment.requisition.submit',
        requisitionId: 'requisition-001',
        expectedVersion: 2,
      },
      'R2',
    );

    const deniedTransition = await store.service.prepareRecruitmentPositionTransition({
      positionId: 'position-001',
      expectedVersion: 3,
      targetStatus: 'open',
      prepareKey: 'position-prepare-denied',
    }, extra(['erp:recruitment:management:read']));
    expect(deniedTransition.isError).toBe(true);
    store.recruitmentManagement.getPosition
      .mockResolvedValueOnce({ id: 'position-001', status: 'draft', version: 3 })
      .mockResolvedValueOnce({ id: 'position-001', status: 'paused', version: 3 });
    const invalidTransition = await store.service.prepareRecruitmentPositionTransition({
      positionId: 'position-001',
      expectedVersion: 3,
      targetStatus: 'closed',
      prepareKey: 'position-prepare-changed',
    }, extra([
      'erp:recruitment:management:read',
      'erp:recruitment:position:transition',
    ]));
    expect(invalidTransition.isError).toBe(true);
    const validTransition = await store.service.prepareRecruitmentPositionTransition({
      positionId: 'position-001',
      expectedVersion: 3,
      targetStatus: 'open',
      prepareKey: 'position-prepare-ok',
    }, extra([
      'erp:recruitment:management:read',
      'erp:recruitment:position:transition',
    ]));
    expect(validTransition.structuredContent).toBeDefined();
    expect(store.confirmations.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorId: 'employee-001' }),
      'position-prepare-ok',
      {
        operation: 'recruitment.position.transition',
        positionId: 'position-001',
        expectedVersion: 3,
        targetStatus: 'open',
      },
      'R1',
    );

    const deniedOffer = await store.service.prepareRecruitmentOfferSend(
      'offer-001',
      4,
      'offer-prepare-denied',
      extra(['erp:recruitment:offer:read']),
    );
    expect(deniedOffer.isError).toBe(true);
    store.recruitmentOffers.get
      .mockResolvedValueOnce({ id: 'offer-001', status: 'draft', version: 4 })
      .mockResolvedValueOnce({ id: 'offer-001', status: 'approved', version: 4 });
    const changedOffer = await store.service.prepareRecruitmentOfferSend(
      'offer-001',
      4,
      'offer-prepare-changed',
      extra(['erp:recruitment:offer:read', 'erp:recruitment:offer:send']),
    );
    expect(changedOffer.isError).toBe(true);
    const preparedOffer = await store.service.prepareRecruitmentOfferSend(
      'offer-001',
      4,
      'offer-prepare-ok',
      extra(['erp:recruitment:offer:read', 'erp:recruitment:offer:send']),
    );
    expect(preparedOffer.structuredContent).toBeDefined();
  });

  it('招聘提交与职位变更执行只分派确认账本中的固化命令', async () => {
    const store = assemble();
    store.recruitmentManagement.submitRequisition.mockResolvedValue({
      requisition: { id: 'requisition-001', status: 'pending_approval', version: 3 },
    });
    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-requisition-001',
      replayResult: null,
      command: {
        operation: 'recruitment.requisition.submit',
        requisitionId: 'requisition-001',
        expectedVersion: 2,
      },
    });
    await store.service.executeRecruitmentRequisitionSubmit(
      'operation-requisition-001',
      `mcpc_${'d'.repeat(43)}`,
      extra(['erp:recruitment:requisition:submit']),
    );
    expect(store.recruitmentManagement.submitRequisition).toHaveBeenCalledWith(
      'requisition-001',
      2,
      'mcp:operation-requisition-001',
    );

    store.recruitmentManagement.transitionPosition.mockResolvedValue({
      position: { id: 'position-001', status: 'closed', version: 5 },
    });
    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-position-001',
      replayResult: null,
      command: {
        operation: 'recruitment.position.transition',
        positionId: 'position-001',
        expectedVersion: 4,
        targetStatus: 'closed',
      },
    });
    await store.service.executeRecruitmentPositionTransition(
      'operation-position-001',
      `mcpc_${'e'.repeat(43)}`,
      extra(['erp:recruitment:position:transition']),
    );
    expect(store.recruitmentManagement.transitionPosition).toHaveBeenCalledWith(
      'position-001',
      4,
      'mcp:operation-position-001',
      'closed',
    );

    const denied = await store.service.executeRecruitmentOfferSend(
      'operation-offer-denied',
      `mcpc_${'s'.repeat(43)}`,
      extra([]),
    );
    expect(denied.isError).toBe(true);

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-offer-replay',
      command: {
        operation: 'recruitment.offer.request_send',
        offerId: 'offer-001',
        expectedVersion: 2,
      },
      replayResult: {
        offer: { id: 'offer-001', status: 'sending', version: 3 },
      },
    });
    const replayed = await store.service.executeRecruitmentOfferSend(
      'operation-offer-replay',
      `mcpc_${'t'.repeat(43)}`,
      extra(['erp:recruitment:offer:send']),
    );
    expect(replayed.structuredContent).toMatchObject({
      offer: { status: 'sending' },
    });

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-offer-mismatch',
      command: {
        operation: 'recruitment.position.transition',
        positionId: 'position-001',
        expectedVersion: 4,
        targetStatus: 'closed',
      },
      replayResult: null,
    });
    await expect(store.service.executeRecruitmentOfferSend(
      'operation-offer-mismatch',
      `mcpc_${'u'.repeat(43)}`,
      extra(['erp:recruitment:offer:send']),
    )).rejects.toThrow('MCP_RECRUITMENT_COMMAND_TYPE_MISMATCH');
    expect(store.confirmations.release).toHaveBeenCalledWith(
      'operation-offer-mismatch',
    );
  });

  it('审批撤回准备与执行覆盖 Scope、状态、重放和命令错配边界', async () => {
    const store = assemble();
    const deniedPrepare = await store.service.prepareApprovalWithdraw(
      'instance-001',
      2,
      'withdraw-prepare-denied',
      extra(['erp:approval:instance:read']),
    );
    expect(deniedPrepare.isError).toBe(true);

    store.approvals.getInstance
      .mockResolvedValueOnce({
        id: 'instance-001', initiatorId: 'employee-002',
        status: 'approved', version: 2,
      })
      .mockResolvedValueOnce({
        id: 'instance-001', initiatorId: 'employee-002',
        status: 'running', version: 2,
      });
    const changed = await store.service.prepareApprovalWithdraw(
      'instance-001',
      2,
      'withdraw-prepare-changed',
      extra(['erp:approval:instance:read', 'erp:approval:instance:submit']),
    );
    expect(changed.isError).toBe(true);
    const prepared = await store.service.prepareApprovalWithdraw(
      'instance-001',
      2,
      'withdraw-prepare-ok',
      extra(['erp:approval:instance:read', 'erp:approval:instance:submit']),
    );
    expect(prepared.structuredContent).toBeDefined();

    const deniedExecute = await store.service.executeApprovalWithdraw(
      'operation-withdraw-denied',
      `mcpc_${'f'.repeat(43)}`,
      extra([]),
    );
    expect(deniedExecute.isError).toBe(true);

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-withdraw-replay',
      command: {
        operation: 'approval.withdraw',
        instanceId: 'instance-001',
        expectedVersion: 2,
      },
      replayResult: {
        instance: { id: 'instance-001', status: 'withdrawn', version: 3 },
      },
    });
    const replayed = await store.service.executeApprovalWithdraw(
      'operation-withdraw-replay',
      `mcpc_${'g'.repeat(43)}`,
      extra(['erp:approval:instance:submit']),
    );
    expect(replayed.structuredContent).toMatchObject({
      instance: { status: 'withdrawn' },
    });
    expect(store.approvals.withdrawInstance).not.toHaveBeenCalled();

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-withdraw-mismatch',
      command: {
        operation: 'approval.submit',
        instanceId: 'instance-001',
        expectedVersion: 2,
      },
      replayResult: null,
    });
    await expect(store.service.executeApprovalWithdraw(
      'operation-withdraw-mismatch',
      `mcpc_${'h'.repeat(43)}`,
      extra(['erp:approval:instance:submit']),
    )).rejects.toThrow('MCP_APPROVAL_COMMAND_TYPE_MISMATCH');
    expect(store.confirmations.release).toHaveBeenCalledWith(
      'operation-withdraw-mismatch',
    );

    store.approvals.withdrawInstance.mockResolvedValue({
      instance: { id: 'instance-001', status: 'withdrawn', version: 3 },
    });
    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-withdraw-ok',
      command: {
        operation: 'approval.withdraw',
        instanceId: 'instance-001',
        expectedVersion: 2,
      },
      replayResult: null,
    });
    const executed = await store.service.executeApprovalWithdraw(
      'operation-withdraw-ok',
      `mcpc_${'i'.repeat(43)}`,
      extra(['erp:approval:instance:submit']),
    );
    expect(executed.structuredContent).toMatchObject({
      instance: { status: 'withdrawn' },
    });
    expect(store.approvals.withdrawInstance).toHaveBeenCalledWith(
      'instance-001',
      2,
      'mcp:operation-withdraw-ok',
    );
  });

  it('分析与考勤确认执行拒绝缺失 Scope、错误命令和非法资源链接', async () => {
    const store = assemble();
    const deniedExportPrepare = await store.service.prepareManagementDashboardExport(
      '2026-07-28',
      'export-prepare-denied',
      extra(['erp:analytics:management:read']),
    );
    expect(deniedExportPrepare.isError).toBe(true);
    const deniedExportExecute = await store.service.executeManagementDashboardExport(
      'operation-export-denied',
      `mcpc_${'j'.repeat(43)}`,
      extra(['erp:analytics:management:read']),
    );
    expect(deniedExportExecute.isError).toBe(true);

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-export-replay',
      command: {
        operation: 'analytics.management_dashboard.export',
        asOf: '2026-07-28',
        format: 'json',
        expectedVersion: 1,
      },
      replayResult: {
        export: {
          id: 'export-replay',
          status: 'ready',
          resourceUri: 'erp://analytics/exports/export-replay',
        },
      },
    });
    const replayedExport = await store.service.executeManagementDashboardExport(
      'operation-export-replay',
      `mcpc_${'k'.repeat(43)}`,
      extra([
        'erp:analytics:management:read',
        'erp:analytics:management:export',
      ]),
    );
    expect(replayedExport.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'resource_link',
        uri: 'erp://analytics/exports/export-replay',
      }),
    ]));

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-export-invalid',
      command: {
        operation: 'analytics.management_dashboard.export',
        asOf: '2026-07-28',
        format: 'json',
        expectedVersion: 1,
      },
      replayResult: null,
    });
    store.analyticsExports.request.mockResolvedValueOnce({
      id: 'export-invalid',
      status: 'queued',
      resourceUri: 'https://untrusted.example/export-invalid',
    });
    await expect(store.service.executeManagementDashboardExport(
      'operation-export-invalid',
      `mcpc_${'l'.repeat(43)}`,
      extra([
        'erp:analytics:management:read',
        'erp:analytics:management:export',
      ]),
    )).rejects.toThrow('MCP_ANALYTICS_EXPORT_RESOURCE_INVALID');
    expect(store.confirmations.complete).not.toHaveBeenCalled();
    expect(store.confirmations.release).toHaveBeenCalledWith(
      'operation-export-invalid',
    );

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-export-empty',
      command: {
        operation: 'analytics.management_dashboard.export',
        asOf: '2026-07-28',
        format: 'json',
        expectedVersion: 1,
      },
      replayResult: null,
    });
    store.analyticsExports.request.mockResolvedValueOnce(null);
    await expect(store.service.executeManagementDashboardExport(
      'operation-export-empty',
      `mcpc_${'x'.repeat(43)}`,
      extra([
        'erp:analytics:management:read',
        'erp:analytics:management:export',
      ]),
    )).rejects.toThrow('MCP_ANALYTICS_EXPORT_RESOURCE_INVALID');
    expect(store.confirmations.release).toHaveBeenCalledWith(
      'operation-export-empty',
    );

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-export-mismatch',
      command: {
        operation: 'attendance.correction.request',
        sourceFactId: 'fact-001',
        expectedVersion: 1,
        workedMinutes: 480,
        leaveMinutes: 0,
        overtimeMinutes: 0,
        absentMinutes: 0,
        reasonCode: 'MISSED_PUNCH',
      },
      replayResult: null,
    });
    await expect(store.service.executeManagementDashboardExport(
      'operation-export-mismatch',
      `mcpc_${'v'.repeat(43)}`,
      extra([
        'erp:analytics:management:read',
        'erp:analytics:management:export',
      ]),
    )).rejects.toThrow('MCP_ANALYTICS_COMMAND_TYPE_MISMATCH');
    expect(store.confirmations.release).toHaveBeenCalledWith(
      'operation-export-mismatch',
    );

    const deniedAttendancePrepare =
      await store.service.prepareAttendanceCorrectionRequest({
        sourceFactId: 'fact-001',
        workedMinutes: 480,
        leaveMinutes: 0,
        overtimeMinutes: 0,
        absentMinutes: 0,
        reasonCode: 'MISSED_PUNCH',
        prepareKey: 'attendance-prepare-denied',
      }, extra(['erp:attendance:correction:request']));
    expect(deniedAttendancePrepare.isError).toBe(true);
    const deniedAttendanceExecute =
      await store.service.executeAttendanceCorrectionRequest(
        'operation-attendance-denied',
        `mcpc_${'m'.repeat(43)}`,
        extra(['erp:attendance:correction:request']),
      );
    expect(deniedAttendanceExecute.isError).toBe(true);

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-attendance-replay',
      command: {
        operation: 'attendance.correction.request',
        sourceFactId: 'fact-001',
        expectedVersion: 1,
        workedMinutes: 480,
        leaveMinutes: 0,
        overtimeMinutes: 0,
        absentMinutes: 0,
        reasonCode: 'MISSED_PUNCH',
      },
      replayResult: {
        request: {
          approvalInstanceId: 'approval-replay',
          approvalStatus: 'running',
        },
      },
    });
    const replayedAttendance =
      await store.service.executeAttendanceCorrectionRequest(
        'operation-attendance-replay',
        `mcpc_${'w'.repeat(43)}`,
        extra([
          'erp:attendance:correction:request',
          'erp:approval:instance:submit',
        ]),
      );
    expect(replayedAttendance.structuredContent).toMatchObject({
      request: { approvalStatus: 'running' },
    });

    store.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-attendance-mismatch',
      command: {
        operation: 'approval.submit',
        instanceId: 'instance-001',
        expectedVersion: 1,
      },
      replayResult: null,
    });
    await expect(store.service.executeAttendanceCorrectionRequest(
      'operation-attendance-mismatch',
      `mcpc_${'n'.repeat(43)}`,
      extra([
        'erp:attendance:correction:request',
        'erp:approval:instance:submit',
      ]),
    )).rejects.toThrow('MCP_ATTENDANCE_COMMAND_TYPE_MISMATCH');
    expect(store.confirmations.release).toHaveBeenCalledWith(
      'operation-attendance-mismatch',
    );
  });

  it('确认账本完成后的审计故障只告警，不释放或反向暴露成功终态', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const analytics = assemble();
    analytics.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-export-audit',
      command: {
        operation: 'analytics.management_dashboard.export',
        asOf: '2026-07-28',
        format: 'json',
        expectedVersion: 1,
      },
      replayResult: null,
    });
    analytics.analyticsExports.request.mockResolvedValueOnce({
      id: 'export-audit',
      status: 'queued',
      resourceUri: 'erp://analytics/exports/export-audit',
    });
    analytics.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(analytics.service.executeManagementDashboardExport(
      'operation-export-audit',
      `mcpc_${'o'.repeat(43)}`,
      extra([
        'erp:analytics:management:read',
        'erp:analytics:management:export',
      ]),
    )).resolves.toMatchObject({
      structuredContent: { export: { status: 'queued' } },
    });
    expect(analytics.confirmations.release).not.toHaveBeenCalled();

    const attendance = assemble();
    attendance.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-attendance-audit',
      command: {
        operation: 'attendance.correction.request',
        sourceFactId: 'fact-001',
        expectedVersion: 1,
        workedMinutes: 480,
        leaveMinutes: 0,
        overtimeMinutes: 0,
        absentMinutes: 0,
        reasonCode: 'MISSED_PUNCH',
      },
      replayResult: null,
    });
    attendance.attendance.requestCorrection.mockResolvedValueOnce({
      request: { approvalInstanceId: 'approval-001', approvalStatus: 'running' },
    });
    attendance.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(attendance.service.executeAttendanceCorrectionRequest(
      'operation-attendance-audit',
      `mcpc_${'p'.repeat(43)}`,
      extra([
        'erp:attendance:correction:request',
        'erp:approval:instance:submit',
      ]),
    )).resolves.toMatchObject({
      structuredContent: { request: { approvalStatus: 'running' } },
    });
    expect(attendance.confirmations.release).not.toHaveBeenCalled();

    const approval = assemble();
    approval.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-approval-audit',
      command: {
        operation: 'approval.submit',
        instanceId: 'instance-001',
        expectedVersion: 1,
      },
      replayResult: null,
    });
    approval.approvals.submitInstance.mockResolvedValueOnce({
      instance: { id: 'instance-001', status: 'running', version: 2 },
    });
    approval.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(approval.service.executeApprovalSubmit(
      'operation-approval-audit',
      `mcpc_${'q'.repeat(43)}`,
      extra(['erp:approval:instance:submit']),
    )).resolves.toMatchObject({
      structuredContent: { instance: { status: 'running' } },
    });
    expect(approval.confirmations.release).not.toHaveBeenCalled();

    const recruitment = assemble();
    recruitment.confirmations.claim.mockResolvedValueOnce({
      operationId: 'operation-recruitment-audit',
      command: {
        operation: 'recruitment.offer.request_send',
        offerId: 'offer-001',
        expectedVersion: 2,
      },
      replayResult: null,
    });
    recruitment.recruitmentOffers.requestSend.mockResolvedValueOnce({
      offer: { id: 'offer-001', status: 'sending', version: 3 },
    });
    recruitment.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(recruitment.service.executeRecruitmentOfferSend(
      'operation-recruitment-audit',
      `mcpc_${'r'.repeat(43)}`,
      extra(['erp:recruitment:offer:send']),
    )).resolves.toMatchObject({
      structuredContent: { offer: { status: 'sending' } },
    });
    expect(recruitment.confirmations.release).not.toHaveBeenCalled();

    expect(error).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      code: 'MCP_TOOL_AUDIT_AFTER_COMMIT_FAILED',
    }));
  });
});
