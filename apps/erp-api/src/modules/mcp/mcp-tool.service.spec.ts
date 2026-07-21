import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { OrgApplicationService } from '../org/application/org-application.service.js';
import { McpToolService } from './mcp-tool.service.js';

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
  const service = new McpToolService(
    context,
    audit as unknown as AuditService,
    organization as unknown as OrgApplicationService,
  );
  return { context, audit, organization, service };
}

describe('McpToolService', () => {
  it('缺少 SDK AuthInfo 时拒绝建立工具身份', async () => {
    const store = assemble();

    await expect(store.service.getMyPermissions({} as McpExtra)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(store.audit.record).not.toHaveBeenCalled();
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
});
