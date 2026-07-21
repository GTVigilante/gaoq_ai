import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { McpController } from './mcp.controller.js';
import { McpRuntimeService } from './mcp-runtime.service.js';
import { McpToolService } from './mcp-tool.service.js';

describe('MCP Streamable HTTP 协议集成', () => {
  let app: INestApplication | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client !== undefined) await client.close();
    if (app !== undefined) await app.close();
    client = undefined;
    app = undefined;
  });

  it('官方 MCP Client 可初始化、发现资源/工具并调用 R0 工具', async () => {
    const tools = {
      getMyPermissions: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: '{"actorId":"employee-001"}' }],
        structuredContent: { actorId: 'employee-001' },
      }),
      getOrgChart: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: '{"departments":[],"employees":[]}' }],
        structuredContent: { departments: [], employees: [] },
      }),
    };
    const module = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        McpRuntimeService,
        { provide: McpToolService, useValue: tools },
        {
          provide: ConfigService,
          useValue: new ConfigService<AppEnvironment, true>({
            MCP_ALLOWED_ORIGINS: 'https://trusted-ai.example.com',
          } as AppEnvironment),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    let resourceUrl = 'http://127.0.0.1/mcp';
    app.use((request: ErpRequest, _response: Response, next: NextFunction) => {
      request.bearerToken = 'protocol-test-fixture';
      request.traceId = 'trace-protocol-001';
      request.verifiedAccessToken = {
        issuer: 'https://auth.example.com',
        subject: 'employee-001',
        audience: ['gaoq-erp'],
        resource: [resourceUrl],
        tenantId: 'tenant-001',
        actorId: 'employee-001',
        actorType: 'user',
        clientId: 'official-sdk-test-client',
        roleCodes: ['employee'],
        scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
        departmentIds: ['department-001'],
        sessionId: 'session-001',
        expiresAt: 1_900_000_000,
      };
      next();
    });
    await app.listen(0, '127.0.0.1');
    resourceUrl = `${await app.getUrl()}/mcp`;

    client = new Client({ name: 'gaoq-protocol-integration', version: '0.1.0' });
    const exchanges: Array<Record<string, unknown>> = [];
    const diagnosticFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      exchanges.push({
        method: init?.method ?? 'GET',
        status: response.status,
      });
      return response;
    };
    const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
      fetch: diagnosticFetch,
    });
    try {
      await client.connect(transport as unknown as Transport);
    } catch (error) {
      throw new Error(`MCP 初始化失败：${JSON.stringify(exchanges)}`, { cause: error });
    }
    expect(client.getServerCapabilities()?.extensions).toMatchObject({
      'io.modelcontextprotocol/oauth-client-credentials': {},
    });

    let listedTools;
    try {
      listedTools = await client.listTools();
    } catch (error) {
      throw new Error(`MCP 工具发现失败：${JSON.stringify(exchanges)}`, { cause: error });
    }
    expect(listedTools.tools.map((tool) => tool.name)).toEqual([
      'get_my_permissions',
      'get_org_chart',
    ]);
    const resources = await client.listResources();
    expect(resources.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: 'gaoq://mcp/guide' }),
    ]));

    const result = await client.callTool({ name: 'get_org_chart', arguments: {} });
    expect(result.structuredContent).toEqual({ departments: [], employees: [] });
    expect(tools.getOrgChart).toHaveBeenCalledOnce();
  });
});
