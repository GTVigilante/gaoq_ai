import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { McpAuthenticatedStdioTransport } from './mcp-authenticated-stdio.transport.js';

const authInfo: AuthInfo = {
  token: 'opaque-test-token',
  clientId: 'mcp-client-001',
  scopes: ['erp:mcp:server:connect'],
  expiresAt: 2_000_000_000,
  resource: new URL('https://erp.example.com/mcp'),
  extra: { tenantId: 'tenant-001' },
};

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sessionId = 'stdio-session';
  readonly sent: Array<{
    message: JSONRPCMessage;
    options: TransportSendOptions | undefined;
  }> = [];
  startCount = 0;
  closeCount = 0;
  protocolVersion: string | undefined;
  startError = false;
  closeError = false;

  start(): Promise<void> {
    this.startCount += 1;
    if (this.startError) return Promise.reject(new Error('底层启动细节'));
    return Promise.resolve();
  }

  send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    this.sent.push({ message, options });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeError) return Promise.reject(new Error('底层关闭细节'));
    this.onclose?.();
    return Promise.resolve();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  emit(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

const pingRequest: JSONRPCMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'ping',
};

describe('McpAuthenticatedStdioTransport', () => {
  it('逐消息注入可信身份并透传会话、协议版本和响应', async () => {
    const inner = new FakeTransport();
    const provideAuthInfo = vi.fn().mockResolvedValue(authInfo);
    const transport = new McpAuthenticatedStdioTransport(
      inner,
      provideAuthInfo,
    );
    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    await transport.start();
    transport.setProtocolVersion('2025-11-25');
    inner.emit(pingRequest);
    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledOnce());
    await transport.send(pingRequest, { relatedRequestId: 1 });

    expect(provideAuthInfo).toHaveBeenCalledOnce();
    expect(onmessage).toHaveBeenCalledWith(pingRequest, { authInfo });
    expect(inner.protocolVersion).toBe('2025-11-25');
    expect(inner.sent).toEqual([{
      message: pingRequest,
      options: { relatedRequestId: 1 },
    }]);
  });

  it('串行认证并保持输入消息顺序', async () => {
    const inner = new FakeTransport();
    const resolvers: Array<() => void> = [];
    const provideAuthInfo = vi.fn(() => new Promise<AuthInfo>((resolve) => {
      resolvers.push(() => resolve(authInfo));
    }));
    const transport = new McpAuthenticatedStdioTransport(
      inner,
      provideAuthInfo,
    );
    const ids: Array<string | number> = [];
    transport.onmessage = (message) => {
      if ('id' in message && message.id !== undefined) ids.push(message.id);
    };
    await transport.start();

    inner.emit({ ...pingRequest, id: 1 });
    inner.emit({ ...pingRequest, id: 2 });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0]?.();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.();
    await vi.waitFor(() => expect(ids).toEqual([1, 2]));
  });

  it('认证失败只暴露稳定错误码并立即关闭', async () => {
    const inner = new FakeTransport();
    const transport = new McpAuthenticatedStdioTransport(
      inner,
      vi.fn().mockRejectedValue(new Error('包含敏感令牌的验证详情')),
    );
    const onmessage = vi.fn();
    const onerror = vi.fn();
    const onclose = vi.fn();
    transport.onmessage = onmessage;
    transport.onerror = onerror;
    transport.onclose = onclose;
    await transport.start();

    inner.emit(pingRequest);
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());

    expect(onmessage).not.toHaveBeenCalled();
    expect(inner.closeCount).toBe(1);
    expect(onerror).toHaveBeenCalledOnce();
    expect((onerror.mock.calls[0]?.[0] as Error).message)
      .toBe('MCP_STDIO_AUTHENTICATION_FAILED');
    expect(() => JSON.stringify(onerror.mock.calls)).not.toThrow();
    await expect(transport.send(pingRequest))
      .rejects.toThrow('MCP_STDIO_TRANSPORT_CLOSED');
  });

  it('协议处理器异常不冒充认证失败并立即关闭', async () => {
    const inner = new FakeTransport();
    const transport = new McpAuthenticatedStdioTransport(
      inner,
      vi.fn().mockResolvedValue(authInfo),
    );
    const onerror = vi.fn();
    const onclose = vi.fn();
    transport.onmessage = () => {
      throw new Error('协议处理细节');
    };
    transport.onerror = onerror;
    transport.onclose = onclose;
    await transport.start();

    inner.emit(pingRequest);
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());

    expect((onerror.mock.calls[0]?.[0] as Error).message)
      .toBe('MCP_STDIO_TRANSPORT_ERROR');
    expect(inner.closeCount).toBe(1);
  });

  it('底层错误被脱敏，关闭和重复关闭只通知一次', async () => {
    const inner = new FakeTransport();
    const transport = new McpAuthenticatedStdioTransport(
      inner,
      vi.fn().mockResolvedValue(authInfo),
    );
    const onerror = vi.fn();
    const onclose = vi.fn();
    transport.onerror = onerror;
    transport.onclose = onclose;
    await transport.start();

    inner.onerror?.(new Error('底层路径与敏感正文'));
    await transport.close();
    await transport.close();

    expect((onerror.mock.calls[0]?.[0] as Error).message)
      .toBe('MCP_STDIO_TRANSPORT_ERROR');
    expect(inner.closeCount).toBe(1);
    expect(onclose).toHaveBeenCalledOnce();
    await expect(transport.start())
      .rejects.toThrow('MCP_STDIO_TRANSPORT_ALREADY_STARTED');
  });

  it('底层启动失败使用稳定错误且不继续发送', async () => {
    const inner = new FakeTransport();
    inner.startError = true;
    const transport = new McpAuthenticatedStdioTransport(
      inner,
      vi.fn().mockResolvedValue(authInfo),
    );

    await expect(transport.start())
      .rejects.toThrow('MCP_STDIO_TRANSPORT_START_FAILED');
    await expect(transport.send(pingRequest))
      .rejects.toThrow('MCP_STDIO_TRANSPORT_CLOSED');
  });

  it('底层关闭失败只报告稳定错误并仍完成关闭通知', async () => {
    const inner = new FakeTransport();
    inner.closeError = true;
    const transport = new McpAuthenticatedStdioTransport(
      inner,
      vi.fn().mockResolvedValue(authInfo),
    );
    const onerror = vi.fn();
    const onclose = vi.fn();
    transport.onerror = onerror;
    transport.onclose = onclose;
    await transport.start();

    await expect(transport.close()).resolves.toBeUndefined();

    expect((onerror.mock.calls[0]?.[0] as Error).message)
      .toBe('MCP_STDIO_TRANSPORT_ERROR');
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('关闭后丢弃已排队和后续消息，缺省回调与协议透传安全为空操作', async () => {
    const inner = new FakeTransport();
    Object.defineProperty(inner, 'setProtocolVersion', {
      value: undefined,
      configurable: true,
    });
    let resolveAuth: ((value: AuthInfo) => void) | undefined;
    const transport = new McpAuthenticatedStdioTransport(
      inner,
      vi.fn(() => new Promise<AuthInfo>((resolve) => {
        resolveAuth = resolve;
      })),
    );
    await transport.start();
    transport.setProtocolVersion('2025-11-25');
    inner.emit(pingRequest);
    await vi.waitFor(() => expect(resolveAuth).toBeTypeOf('function'));
    await transport.close();
    resolveAuth?.(authInfo);
    inner.emit({ ...pingRequest, id: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inner.sent).toHaveLength(0);

    const closedBeforeStart = new McpAuthenticatedStdioTransport(
      new FakeTransport(),
      vi.fn().mockResolvedValue(authInfo),
    );
    await closedBeforeStart.close();
    await expect(closedBeforeStart.start())
      .rejects.toThrow('MCP_STDIO_TRANSPORT_ALREADY_STARTED');
  });
});
