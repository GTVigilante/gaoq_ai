import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  McpAuthenticatedStdioTransport,
} from './mcp-authenticated-stdio.transport.js';
import { McpRuntimeService } from './mcp-runtime.service.js';
import type { McpToolService } from './mcp-tool.service.js';

class DuplexClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly readBuffer = new ReadBuffer();
  private started = false;

  constructor(
    private readonly clientToServer: PassThrough,
    private readonly serverToClient: PassThrough,
  ) {}

  start(): Promise<void> {
    if (this.started) {
      return Promise.reject(new Error('客户端 transport 已启动'));
    }
    this.started = true;
    this.serverToClient.on('data', this.handleData);
    this.serverToClient.on('error', this.handleError);
    return Promise.resolve();
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    void options;
    await new Promise<void>((resolve) => {
      if (this.clientToServer.write(serializeMessage(message))) resolve();
      else this.clientToServer.once('drain', resolve);
    });
  }

  close(): Promise<void> {
    this.serverToClient.off('data', this.handleData);
    this.serverToClient.off('error', this.handleError);
    this.readBuffer.clear();
    this.onclose?.();
    return Promise.resolve();
  }

  private readonly handleData = (chunk: Buffer): void => {
    this.readBuffer.append(chunk);
    for (;;) {
      const message = this.readBuffer.readMessage();
      if (message === null) return;
      this.onmessage?.(message);
    }
  };

  private readonly handleError = (): void => {
    this.onerror?.(new Error('MCP_STDIO_TEST_CLIENT_STREAM_ERROR'));
  };
}

const authInfo: AuthInfo = {
  token: 'verified-short-lived-token',
  clientId: 'stdio-contract-client',
  scopes: ['erp:mcp:server:connect'],
  expiresAt: 2_000_000_000,
  resource: new URL('https://erp.example.com/mcp'),
  extra: {
    tenantId: 'tenant-001',
    actorId: 'employee-001',
    actorType: 'user',
    roleCodes: ['employee'],
    departmentIds: ['department-001'],
    traceId: 'trace-stdio-contract',
  },
};

describe('MCP stdio 协议集成', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.allSettled(closeables.splice(0).map(
      async (closeable) => closeable.close(),
    ));
  });

  it('官方 Client 经原生 stdio Server transport 完成协商和能力发现', async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const serverTransport = new StdioServerTransport(
      clientToServer,
      serverToClient,
    );
    const provideAuthInfo = vi.fn().mockResolvedValue(authInfo);
    const authenticatedTransport = new McpAuthenticatedStdioTransport(
      serverTransport,
      provideAuthInfo,
    );
    const config = {
      get: vi.fn().mockReturnValue('https://agent.example.com'),
    } as unknown as ConfigService<AppEnvironment, true>;
    const runtime = new McpRuntimeService(
      config,
      {} as McpToolService,
    );
    const server = await runtime.connect(authenticatedTransport);
    closeables.push(server);

    const clientTransport = new DuplexClientTransport(
      clientToServer,
      serverToClient,
    );
    const client = new Client({
      name: 'gaoq-stdio-contract-test',
      version: '1.0.0',
    });
    closeables.push(client);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const resources = await client.listResources();
    const resourceTemplates = await client.listResourceTemplates();
    const prompts = await client.listPrompts();

    expect(client.getServerVersion()).toMatchObject({
      name: 'gaoq-erp',
      version: '0.1.0',
    });
    expect(tools.tools).toHaveLength(51);
    expect(tools.tools.map((tool) => tool.name)).toContain('performance_my_assignments');
    expect(resources.resources.map((resource) => resource.uri))
      .toContain('gaoq://mcp/guide');
    expect(resourceTemplates.resourceTemplates).toHaveLength(27);
    expect(prompts.prompts).toHaveLength(25);
    expect(provideAuthInfo.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});
