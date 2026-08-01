import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';

export type McpStdioAuthProvider = () => Promise<AuthInfo>;

/**
 * 为标准 stdio transport 注入经过统一验证的 AuthInfo。
 *
 * SDK 的原生 stdio transport 不承载 HTTP Bearer 上下文。本包装器在每一条输入
 * 消息交给协议层前重新验证短时令牌，并串行保持消息顺序；认证失败立即关闭连接，
 * 仅暴露稳定错误码，不把 Token 或验证器异常写入协议、日志或客户端。
 */
export class McpAuthenticatedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  private started = false;
  private closed = false;
  private closeNotified = false;
  private authenticationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: Transport,
    private readonly provideAuthInfo: McpStdioAuthProvider,
  ) {}

  /** 保持 SDK 协商出的协议版本向底层 transport 透传。 */
  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    if (this.started || this.closed) {
      throw new Error('MCP_STDIO_TRANSPORT_ALREADY_STARTED');
    }
    this.started = true;
    this.inner.onclose = () => {
      this.closed = true;
      this.notifyClose();
    };
    this.inner.onerror = () => {
      this.onerror?.(new Error('MCP_STDIO_TRANSPORT_ERROR'));
    };
    this.inner.onmessage = (message) => {
      const current = this.authenticationQueue.then(
        () => this.forwardAuthenticated(message),
      );
      this.authenticationQueue = current.catch(() => undefined);
    };
    try {
      await this.inner.start();
    } catch {
      this.closed = true;
      throw new Error('MCP_STDIO_TRANSPORT_START_FAILED');
    }
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (this.closed) {
      throw new Error('MCP_STDIO_TRANSPORT_CLOSED');
    }
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    if (this.closed) {
      this.notifyClose();
      return;
    }
    this.closed = true;
    try {
      await this.inner.close();
    } catch {
      this.onerror?.(new Error('MCP_STDIO_TRANSPORT_ERROR'));
    } finally {
      this.notifyClose();
    }
  }

  private async forwardAuthenticated(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    let authInfo: AuthInfo;
    try {
      authInfo = await this.provideAuthInfo();
    } catch {
      this.onerror?.(new Error('MCP_STDIO_AUTHENTICATION_FAILED'));
      await this.close();
      return;
    }
    if (this.closed) return;
    try {
      this.onmessage?.(message, { authInfo });
    } catch {
      this.onerror?.(new Error('MCP_STDIO_TRANSPORT_ERROR'));
      await this.close();
    }
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }
}
