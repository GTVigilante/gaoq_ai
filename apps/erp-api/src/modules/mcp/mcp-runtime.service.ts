import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Response } from 'express';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { McpToolService } from './mcp-tool.service.js';

const permissionsOutputSchema = z.object({
  actorId: z.string(),
  roleCodes: z.array(z.string()),
  scopes: z.array(z.string()),
  departmentIds: z.array(z.string()),
});

const orgChartOutputSchema = z.object({
  departments: z.array(z.object({
    id: z.string(),
    tenantId: z.string(),
    code: z.string(),
    name: z.string(),
    status: z.enum(['active', 'inactive']),
    parentId: z.string().nullable(),
    managerId: z.string().nullable(),
    sortOrder: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
  employees: z.array(z.object({
    id: z.string(),
    tenantId: z.string(),
    employeeNo: z.string(),
    displayName: z.string(),
    status: z.enum(['probation', 'active', 'suspended', 'terminated']),
    departmentIds: z.array(z.string()),
    primaryDepartmentId: z.string(),
    positionIds: z.array(z.string()),
    jobLevelId: z.string().nullable(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
});

@Injectable()
export class McpRuntimeService {
  private readonly logger = new Logger(McpRuntimeService.name);
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppEnvironment, true>,
    @Inject(McpToolService) private readonly tools: McpToolService,
  ) {
    this.allowedOrigins = new Set(
      config
        .get('MCP_ALLOWED_ORIGINS', { infer: true })
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
  }

  /** 校验 Origin，阻止 Streamable HTTP DNS rebinding。 */
  isOriginAllowed(origin: string | undefined): boolean {
    return origin === undefined || this.allowedOrigins.has(origin);
  }

  /** 将已经过统一 JWT Guard 的请求交给官方 Streamable HTTP transport。 */
  async handle(request: ErpRequest, response: Response): Promise<void> {
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
    // SDK 1.29 明确要求无状态模式每个 HTTP 请求创建独立 transport；复用会被拒绝。
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    transport.onerror = (error) => this.logger.error(`MCP transport：${error.message}`);
    const server = this.createServer();
    await server.connect(transport);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      }
    }
    const baseUrl = token.resource[0] ?? '';
    const webRequest = new Request(new URL(request.originalUrl, baseUrl), {
      method: request.method,
      headers,
    });
    try {
      const webResponse = await transport.handleRequest(webRequest, {
        authInfo: auth,
        parsedBody: request.body,
      });
      response.status(webResponse.status);
      webResponse.headers.forEach((value, name) => response.setHeader(name, value));
      if (webResponse.body === null) {
        response.end();
        return;
      }
      const reader = webResponse.body.getReader();
      response.once('close', () => {
        if (!response.writableEnded) void reader.cancel('客户端连接已关闭');
      });
      while (!response.destroyed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        response.write(Buffer.from(chunk.value));
      }
      if (!response.writableEnded) response.end();
    } finally {
      await server.close();
    }
  }

  private createServer(): McpServer {
    const server = new McpServer(
      {
        name: 'gaoq-erp',
        version: '0.1.0',
        description: 'GaoQ-OS 企业运营 MCP 服务',
      },
      { capabilities: { logging: {} } },
    );
    this.registerCapabilities(server);
    return server;
  }

  private registerCapabilities(server: McpServer): void {
    server.registerResource(
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

    server.registerTool(
      'get_my_permissions',
      {
        title: '查询我的权限',
        description: '返回当前已验证主体的角色、Scope 与部门数据范围，不接受租户参数。',
        outputSchema: permissionsOutputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (extra) => this.tools.getMyPermissions(extra),
    );

    server.registerTool(
      'get_org_chart',
      {
        title: '查询组织架构',
        description: '按当前主体的数据权限返回部门与员工组织视图，不接受租户或越权部门参数。',
        outputSchema: orgChartOutputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (extra) => this.tools.getOrgChart(extra),
    );
  }
}
