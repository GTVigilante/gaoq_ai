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
    getInstance: vi.fn().mockResolvedValue({ id: 'instance-001', formData: { remark: { redacted: true } } }),
    submitInstance: vi.fn(),
    withdrawInstance: vi.fn(),
    decideInstance: vi.fn(),
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
  const service = new McpToolService(
    context,
    audit as unknown as AuditService,
    organization as unknown as OrgApplicationService,
    approvals as unknown as ApprovalApplicationService,
    recruitmentApplications as unknown as RecruitmentApplicationService,
    recruitmentInterviews as unknown as RecruitmentInterviewService,
    recruitmentManagement as unknown as RecruitmentManagementService,
    recruitmentOffers as unknown as RecruitmentOfferService,
    confirmations as unknown as McpConfirmationService,
  );
  return {
    context, audit, organization, approvals, recruitmentApplications,
    recruitmentInterviews, recruitmentManagement, recruitmentOffers, confirmations, service,
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

  it('审批详情沿用应用层 L3/L4 脱敏投影', async () => {
    const store = assemble();
    const result = await store.service.getApprovalInstance('instance-001', extra([
      'erp:mcp:server:connect', 'erp:approval:instance:read',
    ]));
    expect(result.structuredContent).toEqual({
      instance: { id: 'instance-001', formData: { remark: { redacted: true } } },
    });
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
});
