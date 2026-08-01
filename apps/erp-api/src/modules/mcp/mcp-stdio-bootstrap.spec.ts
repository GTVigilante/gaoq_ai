import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { INestApplicationContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAccessToken } from '../identity/auth.types.js';
import { AccessTokenVerifier } from '../identity/access-token-verifier.js';
import type { McpRuntimeService } from './mcp-runtime.service.js';
import {
  connectMcpStdio,
  createMcpStdioAuthProvider,
  MCP_STDIO_CONNECT_SCOPE,
  parseMcpStdioEnvironment,
} from './mcp-stdio-bootstrap.js';

const ACCESS_TOKEN =
  `${'a'.repeat(32)}.${'b'.repeat(32)}.${'c'.repeat(64)}`;
const verifiedToken: VerifiedAccessToken = {
  issuer: 'https://auth.example.com',
  subject: 'tenant-001:employee-001',
  audience: ['gaoq-erp'],
  resource: ['https://erp.example.com/mcp'],
  tenantId: 'tenant-001',
  actorId: 'employee-001',
  actorType: 'user',
  clientId: 'desktop-client',
  roleCodes: ['employee'],
  scopes: [MCP_STDIO_CONNECT_SCOPE, 'erp:org:profile:read'],
  departmentIds: ['department-001'],
  sessionId: 'session-001',
  expiresAt: 2_000_000_000,
};

class BootstrapTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  started = false;

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  send(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }

  emit(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

describe('MCP stdio 启动边界', () => {
  it('只接受短时 JWT 形态环境变量并生成稳定追踪标识', () => {
    expect(parseMcpStdioEnvironment({
      MCP_STDIO_ACCESS_TOKEN: ACCESS_TOKEN,
      MCP_STDIO_TRACE_ID: 'trace-stdio-001',
    })).toEqual({
      accessToken: ACCESS_TOKEN,
      traceId: 'trace-stdio-001',
    });
    expect(parseMcpStdioEnvironment(
      { MCP_STDIO_ACCESS_TOKEN: ACCESS_TOKEN },
      () => 'generated-trace',
    )).toEqual({
      accessToken: ACCESS_TOKEN,
      traceId: 'generated-trace',
    });
  });

  it.each([
    {},
    { MCP_STDIO_ACCESS_TOKEN: 'plaintext-secret' },
    {
      MCP_STDIO_ACCESS_TOKEN: ACCESS_TOKEN,
      MCP_STDIO_TRACE_ID: '含 空格',
    },
  ])('错误配置只返回稳定错误码且不回显输入 %#', (environment) => {
    expect(() => parseMcpStdioEnvironment(environment))
      .toThrow('MCP_STDIO_ENVIRONMENT_INVALID');
    try {
      parseMcpStdioEnvironment(environment);
    } catch (error: unknown) {
      expect(String(error)).not.toContain('plaintext-secret');
    }
  });

  it('每次调用重新验签并转换为与 HTTP 相同的 AuthInfo', async () => {
    const verify = vi.fn().mockResolvedValue(verifiedToken);
    const verifier = {
      verify,
    } as unknown as AccessTokenVerifier;
    const provider = createMcpStdioAuthProvider(verifier, {
      accessToken: ACCESS_TOKEN,
      traceId: 'trace-stdio-001',
    });

    const first = await provider();
    const second = await provider();

    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenNthCalledWith(1, ACCESS_TOKEN);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      token: ACCESS_TOKEN,
      clientId: 'desktop-client',
      scopes: [...verifiedToken.scopes],
      expiresAt: verifiedToken.expiresAt,
      resource: new URL('https://erp.example.com/mcp'),
      extra: {
        tenantId: 'tenant-001',
        actorId: 'employee-001',
        traceId: 'trace-stdio-001',
      },
    } satisfies Partial<AuthInfo>);
  });

  it('缺少连接 Scope 时在创建协议连接前失败关闭', async () => {
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        ...verifiedToken,
        scopes: ['erp:org:profile:read'],
      }),
    } as unknown as AccessTokenVerifier;
    const provider = createMcpStdioAuthProvider(verifier, {
      accessToken: ACCESS_TOKEN,
      traceId: 'trace-stdio-001',
    });

    await expect(provider()).rejects
      .toThrow('MCP_STDIO_CONNECT_SCOPE_REQUIRED');
  });

  it('连接前预检，连接后逐消息复验并保留关闭回调', async () => {
    const verify = vi.fn().mockResolvedValue(verifiedToken);
    const verifier = {
      verify,
    } as unknown as AccessTokenVerifier;
    const server = { close: vi.fn() } as unknown as McpServer;
    const connect = vi.fn(async (transport: Transport) => {
        await transport.start();
        return server;
      });
    const runtime = {
      connect,
    } as unknown as McpRuntimeService;
    const application = {
      get: vi.fn((token: unknown) =>
        token === AccessTokenVerifier ? verifier : runtime),
    } as unknown as INestApplicationContext;
    const innerTransport = new BootstrapTransport();
    const onClose = vi.fn();
    const onError = vi.fn();

    const connection = await connectMcpStdio({
      application,
      innerTransport,
      config: {
        accessToken: ACCESS_TOKEN,
        traceId: 'trace-stdio-001',
      },
      onClose,
      onError,
    });
    const onmessage = vi.fn();
    connection.transport.onmessage = onmessage;
    innerTransport.emit({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledOnce());
    await connection.transport.close();

    expect(connection.server).toBe(server);
    expect(connect).toHaveBeenCalledWith(connection.transport);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(onmessage.mock.calls[0]?.[1]).toMatchObject({
      authInfo: { clientId: 'desktop-client' },
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('预检失败时不创建 transport 或 MCP Server', async () => {
    const verifier = {
      verify: vi.fn().mockRejectedValue(new Error('AUTH_INVALID_TOKEN')),
    } as unknown as AccessTokenVerifier;
    const connect = vi.fn();
    const runtime = { connect } as unknown as McpRuntimeService;
    const application = {
      get: vi.fn((token: unknown) =>
        token === AccessTokenVerifier ? verifier : runtime),
    } as unknown as INestApplicationContext;

    await expect(connectMcpStdio({
      application,
      innerTransport: new BootstrapTransport(),
      config: {
        accessToken: ACCESS_TOKEN,
        traceId: 'trace-stdio-001',
      },
    })).rejects.toThrow('AUTH_INVALID_TOKEN');
    expect(connect).not.toHaveBeenCalled();
  });

  it('缺省关闭与错误回调时仍可建立标准连接', async () => {
    const verifier = {
      verify: vi.fn().mockResolvedValue(verifiedToken),
    } as unknown as AccessTokenVerifier;
    const server = { close: vi.fn() } as unknown as McpServer;
    const runtime = {
      connect: vi.fn().mockResolvedValue(server),
    } as unknown as McpRuntimeService;
    const application = {
      get: vi.fn((token: unknown) =>
        token === AccessTokenVerifier ? verifier : runtime),
    } as unknown as INestApplicationContext;

    const connection = await connectMcpStdio({
      application,
      innerTransport: new BootstrapTransport(),
      config: {
        accessToken: ACCESS_TOKEN,
        traceId: 'trace-stdio-001',
      },
    });

    expect(connection.server).toBe(server);
    expect(connection.transport.onclose).toBeUndefined();
    expect(connection.transport.onerror).toBeUndefined();
  });
});
