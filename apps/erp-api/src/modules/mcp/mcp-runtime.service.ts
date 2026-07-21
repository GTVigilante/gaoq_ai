import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';

import type { AppEnvironment } from '../../config/environment.js';
import { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { parseMcpIdentity } from './mcp-auth-context.js';

@Injectable()
export class McpRuntimeService implements OnApplicationShutdown {
  private readonly server = new McpServer(
    {
      name: 'gaoq-erp',
      version: '0.1.0',
      description: 'GaoQ-OS 企业运营 MCP 服务',
    },
    { capabilities: { logging: {} } },
  );
  private readonly transport = new StreamableHTTPServerTransport(
    {
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    } as unknown as StreamableHTTPServerTransportOptions,
  );
  private readonly connected: Promise<void>;
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {
    this.allowedOrigins = new Set(
      config
        .get('MCP_ALLOWED_ORIGINS', { infer: true })
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
    this.registerCapabilities();
    this.connected = this.server.connect(this.transport as unknown as Transport);
  }

  /** 校验 Origin，阻止 Streamable HTTP DNS rebinding。 */
  isOriginAllowed(origin: string | undefined): boolean {
    return origin === undefined || this.allowedOrigins.has(origin);
  }

  /** 将已经过统一 JWT Guard 的请求交给官方 Streamable HTTP transport。 */
  async handle(request: ErpRequest, response: Response): Promise<void> {
    await this.connected;
    const token = request.verifiedAccessToken;
    if (token === undefined || request.bearerToken === undefined || request.traceId === undefined) {
      throw new Error('MCP 认证上下文未建立');
    }
    const auth: AuthInfo = {
      token: request.bearerToken,
      clientId: token.clientId,
      scopes: [...token.scopes],
      expiresAt: token.expiresAt,
      resource: new URL(token.resource[0] ?? ''),
      extra: {
        tenantId: token.tenantId,
        actorId: token.actorId,
        actorType: token.actorType,
        roleCodes: [...token.roleCodes],
        departmentIds: [...token.departmentIds],
        traceId: request.traceId,
      },
    };
    const authenticatedRequest = request as Request & { auth?: AuthInfo };
    authenticatedRequest.auth = auth;
    await this.transport.handleRequest(authenticatedRequest, response, request.body);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server.close();
  }

  private registerCapabilities(): void {
    this.server.registerResource(
      'mcp-usage-guide',
      'gaoq://mcp/guide',
      {
        title: 'GaoQ-OS MCP 使用指南',
        description: '风险分级、授权边界和可用能力说明',
        mimeType: 'text/markdown',
      },
      () => ({
        contents: [
          {
            uri: 'gaoq://mcp/guide',
            mimeType: 'text/markdown',
            text: '# GaoQ-OS MCP\n\n所有调用受 OAuth Scope、租户、角色、数据范围和审计约束。R3 操作禁止 AI 直接执行。',
          },
        ],
      }),
    );

    this.server.registerTool(
      'get_my_permissions',
      {
        title: '查询我的权限',
        description: '返回当前已验证主体的角色、Scope 与部门数据范围，不接受租户参数。',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (extra) => this.getMyPermissions(extra),
    );
  }

  private async getMyPermissions(
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    structuredContent: Record<string, unknown>;
  }> {
    const identity = parseMcpIdentity(extra.authInfo);
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
      async () => {
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
      },
    );
  }
}
