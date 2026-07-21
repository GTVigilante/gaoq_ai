import { Injectable } from '@nestjs/common';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { OrgApplicationService } from '../org/application/org-application.service.js';
import { ApprovalApplicationService } from '../approval/application/approval-application.service.js';
import { parseMcpIdentity, type McpIdentity } from './mcp-auth-context.js';

export type McpToolResult = CallToolResult;

type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** MCP 工具应用层；只复用业务应用服务，不直接访问数据库或上游 Token。 */
@Injectable()
export class McpToolService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly organization: OrgApplicationService,
    private readonly approvals: ApprovalApplicationService,
  ) {}

  async getMyPermissions(extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const data = {
        actorId: identity.actorId,
        roleCodes: identity.roleCodes,
        scopes: identity.scopes,
        departmentIds: identity.departmentIds,
      };
      await this.audit.record({
        action: 'mcp.tool.get_my_permissions',
        resourceType: 'mcp_tool',
        resourceId: 'get_my_permissions',
        riskLevel: 'R0',
        outcome: 'success',
        metadata: { clientId: identity.clientId, protocol: '2025-11-25' },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  async getOrgChart(extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:org:chart:read')) {
        await this.audit.record({
          action: 'mcp.tool.get_org_chart',
          resourceType: 'mcp_tool',
          resourceId: 'get_org_chart',
          riskLevel: 'R0',
          outcome: 'denied',
          metadata: { clientId: identity.clientId, protocol: '2025-11-25' },
        });
        return {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({ code: 'AUTH_INSUFFICIENT_SCOPE', message: '需要 erp:org:chart:read' }),
          }],
        };
      }
      const chart = await this.organization.getOrgChart();
      const data: Record<string, unknown> = {
        departments: chart.departments,
        employees: chart.employees,
      };
      await this.audit.record({
        action: 'mcp.tool.get_org_chart',
        resourceType: 'mcp_tool',
        resourceId: 'get_org_chart',
        riskLevel: 'R0',
        outcome: 'success',
        metadata: {
          clientId: identity.clientId,
          protocol: '2025-11-25',
          departmentCount: chart.departments.length,
          employeeCount: chart.employees.length,
        },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  async getApprovalInbox(extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:approval:instance:read')) {
        await this.auditTool(identity, 'approval_get_inbox', 'R0', 'denied');
        return scopeError('erp:approval:instance:read');
      }
      const items = await this.approvals.getInbox();
      const data: Record<string, unknown> = { items };
      await this.auditTool(identity, 'approval_get_inbox', 'R0', 'success', { count: items.length });
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  async getApprovalInstance(instanceId: string, extra: McpExtra): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      if (!identity.scopes.includes('erp:approval:instance:read')) {
        await this.auditTool(identity, 'approval_get', 'R0', 'denied');
        return scopeError('erp:approval:instance:read');
      }
      const instance = await this.approvals.getInstance(instanceId);
      const data: Record<string, unknown> = { instance };
      await this.auditTool(identity, 'approval_get', 'R0', 'success');
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
  }

  private async auditTool(
    identity: McpIdentity,
    tool: string,
    riskLevel: 'R0' | 'R1' | 'R2',
    outcome: 'success' | 'denied' | 'failure',
    metadata: Readonly<Record<string, string | number | boolean>> = {},
  ): Promise<void> {
    await this.audit.record({
      action: `mcp.tool.${tool}`,
      resourceType: 'mcp_tool',
      resourceId: tool,
      riskLevel,
      outcome,
      metadata: { clientId: identity.clientId, protocol: '2025-11-25', ...metadata },
    });
  }

  private run<T>(identity: McpIdentity, operation: () => Promise<T>): Promise<T> {
    return this.tenantContext.run(
      {
        tenant: {
          tenantId: identity.tenantId,
          source: identity.actorType === 'user' ? 'access_token' : 'service_identity',
        },
        actor: {
          actorId: identity.actorId,
          actorType: identity.actorType,
          tenantId: identity.tenantId,
          roleCodes: identity.roleCodes,
          scopes: identity.scopes,
          departmentIds: identity.departmentIds,
          traceId: identity.traceId,
        },
      },
      operation,
    );
  }
}

function scopeError(scope: string): McpToolResult {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({ code: 'AUTH_INSUFFICIENT_SCOPE', message: `需要 ${scope}` }),
    }],
  };
}
