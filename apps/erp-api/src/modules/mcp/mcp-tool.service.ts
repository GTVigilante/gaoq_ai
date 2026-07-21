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
import {
  McpConfirmationService,
  type ApprovalMcpCommand,
  type McpPreparedOperation,
} from './mcp-confirmation.service.js';
import type { McpApprovalOperation } from './mcp-confirmation.schema.js';

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
    private readonly confirmations: McpConfirmationService,
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

  async prepareApprovalSubmit(
    instanceId: string,
    expectedVersion: number,
    prepareKey: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.prepareApprovalOperation(
      extra,
      ['erp:approval:instance:read', 'erp:approval:instance:submit'],
      { operation: 'approval.submit', instanceId, expectedVersion },
      prepareKey,
      'R1',
      ['draft'],
    );
  }

  async prepareApprovalWithdraw(
    instanceId: string,
    expectedVersion: number,
    prepareKey: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.prepareApprovalOperation(
      extra,
      ['erp:approval:instance:read', 'erp:approval:instance:submit'],
      { operation: 'approval.withdraw', instanceId, expectedVersion },
      prepareKey,
      'R1',
      ['draft', 'running'],
    );
  }

  async prepareApprovalDecision(
    input: {
      readonly instanceId: string;
      readonly expectedVersion: number;
      readonly principalApproverId: string;
      readonly outcome: 'approved' | 'rejected';
      readonly prepareKey: string;
    },
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.prepareApprovalOperation(
      extra,
      ['erp:approval:instance:read', 'erp:approval:task:decide'],
      {
        operation: 'approval.decide',
        instanceId: input.instanceId,
        expectedVersion: input.expectedVersion,
        principalApproverId: input.principalApproverId,
        outcome: input.outcome,
      },
      input.prepareKey,
      'R2',
      ['running'],
    );
  }

  async executeApprovalSubmit(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.executeApprovalOperation(
      extra,
      'approval.submit',
      ['erp:approval:instance:submit'],
      operationId,
      confirmationCredential,
    );
  }

  async executeApprovalWithdraw(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.executeApprovalOperation(
      extra,
      'approval.withdraw',
      ['erp:approval:instance:submit'],
      operationId,
      confirmationCredential,
    );
  }

  async executeApprovalDecision(
    operationId: string,
    confirmationCredential: string,
    extra: McpExtra,
  ): Promise<McpToolResult> {
    return this.executeApprovalOperation(
      extra,
      'approval.decide',
      ['erp:approval:task:decide'],
      operationId,
      confirmationCredential,
    );
  }

  private async prepareApprovalOperation(
    extra: McpExtra,
    requiredScopes: readonly string[],
    command: ApprovalMcpCommand,
    prepareKey: string,
    riskLevel: 'R1' | 'R2',
    allowedStatuses: readonly string[],
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    return this.run(identity, async () => {
      const missing = requiredScopes.find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, `${command.operation.replace('.', '_')}_prepare`, riskLevel, 'denied');
        return scopeError(missing);
      }
      const instance = await this.approvals.getInstance(command.instanceId);
      const independentDecision = command.operation !== 'approval.decide' || (
        command.principalApproverId !== instance.initiatorId &&
        identity.actorId !== instance.initiatorId
      );
      if (instance.version !== command.expectedVersion || !allowedStatuses.includes(instance.status)) {
        await this.auditTool(
          identity,
          `${command.operation.replace('.', '_')}_prepare`,
          riskLevel,
          'failure',
          { stateChanged: true },
        );
        return businessError('APPROVAL_PREPARE_STATE_CHANGED', '审批状态或版本已变化，请刷新后重试');
      }
      if (!independentDecision) {
        await this.auditTool(
          identity,
          `${command.operation.replace('.', '_')}_prepare`,
          riskLevel,
          'denied',
          { independentApproval: false },
        );
        return businessError('APPROVAL_R2_INDEPENDENCE_REQUIRED', 'R2 决策必须由发起人之外的独立审批人处理');
      }
      const prepared = await this.confirmations.prepare(identity, prepareKey, command, riskLevel);
      await this.auditTool(
        identity,
        `${command.operation.replace('.', '_')}_prepare`,
        riskLevel,
        'success',
        { operationId: prepared.operationId, digest: prepared.digest },
      );
      return preparedResult(prepared);
    });
  }

  private async executeApprovalOperation(
    extra: McpExtra,
    operation: McpApprovalOperation,
    requiredScopes: readonly string[],
    operationId: string,
    confirmationCredential: string,
  ): Promise<McpToolResult> {
    const identity = parseMcpIdentity(extra.authInfo);
    const riskLevel = operation === 'approval.decide' ? 'R2' : 'R1';
    return this.run(identity, async () => {
      const missing = requiredScopes.find((scope) => !identity.scopes.includes(scope));
      if (missing !== undefined) {
        await this.auditTool(identity, `${operation.replace('.', '_')}_execute`, riskLevel, 'denied');
        return scopeError(missing);
      }
      const claimed = await this.confirmations.claim(
        identity,
        operation,
        operationId,
        confirmationCredential,
      );
      if (claimed.replayResult !== null) {
        await this.auditTool(
          identity,
          `${operation.replace('.', '_')}_execute`,
          riskLevel,
          'success',
          { operationId, replayed: true },
        );
        return structuredResult(claimed.replayResult);
      }
      try {
        const result = await this.dispatchApprovalCommand(claimed.command, operationId);
        await this.confirmations.complete(operationId, result);
        await this.auditTool(
          identity,
          `${operation.replace('.', '_')}_execute`,
          riskLevel,
          'success',
          { operationId, replayed: false },
        );
        return structuredResult(result);
      } catch (error) {
        await this.confirmations.release(operationId);
        await this.auditTool(
          identity,
          `${operation.replace('.', '_')}_execute`,
          riskLevel,
          'failure',
          { operationId },
        );
        throw error;
      }
    });
  }

  private async dispatchApprovalCommand(
    command: ApprovalMcpCommand,
    operationId: string,
  ): Promise<Record<string, unknown>> {
    const idempotencyKey = `mcp:${operationId}`;
    switch (command.operation) {
      case 'approval.submit':
        return this.approvals.submitInstance(
          command.instanceId, command.expectedVersion, idempotencyKey,
        );
      case 'approval.withdraw':
        return this.approvals.withdrawInstance(
          command.instanceId, command.expectedVersion, idempotencyKey,
        );
      case 'approval.decide':
        return this.approvals.decideInstance(
          command.instanceId,
          command.expectedVersion,
          command.principalApproverId,
          command.outcome,
          idempotencyKey,
        );
    }
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

function businessError(code: string, message: string): McpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
  };
}

function preparedResult(prepared: McpPreparedOperation): McpToolResult {
  const data: Record<string, unknown> = { ...prepared };
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function structuredResult(data: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}
