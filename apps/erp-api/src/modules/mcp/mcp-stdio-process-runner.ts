import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { INestApplicationContext } from '@nestjs/common';

import {
  connectMcpStdio,
  parseMcpStdioEnvironment,
  type ConnectMcpStdioOptions,
  type McpStdioBootstrapConfig,
  type McpStdioConnection,
} from './mcp-stdio-bootstrap.js';

export const MCP_STDIO_STARTUP_FAILED = 'MCP_STDIO_STARTUP_FAILED' as const;
export const MCP_STDIO_CONNECTION_FAILED =
  'MCP_STDIO_CONNECTION_FAILED' as const;

type McpStdioStableErrorCode =
  | typeof MCP_STDIO_STARTUP_FAILED
  | typeof MCP_STDIO_CONNECTION_FAILED;

export interface McpStdioProcessLifecycle {
  readonly environment: NodeJS.ProcessEnv;
  getExitCode(): number | undefined;
  setExitCode(exitCode: number): void;
  writeError(code: McpStdioStableErrorCode): void;
  onInputEnd(listener: () => void): void;
  onSignal(signal: NodeJS.Signals, listener: () => void): void;
}

export interface McpStdioProcessRunnerDependencies {
  readonly lifecycle: McpStdioProcessLifecycle;
  readonly loadApplication: () => Promise<INestApplicationContext>;
  readonly createInnerTransport: () => Transport;
  readonly parseEnvironment?: (
    environment: NodeJS.ProcessEnv,
  ) => McpStdioBootstrapConfig;
  readonly connect?: (
    options: ConnectMcpStdioOptions,
  ) => Promise<McpStdioConnection>;
}

/**
 * 管理 MCP stdio 进程入口的启动、信号竞态与幂等资源释放。
 *
 * 入口只向 stderr 写稳定错误码；任何内部异常、配置值、Token、堆栈和文件路径均
 * 不得越过此边界。环境预检必须先于应用模块动态加载。
 */
export class McpStdioProcessRunner {
  private application: INestApplicationContext | undefined;
  private server: McpServer | undefined;
  private stopping = false;
  private connectionFailureReported = false;
  private readonly closedServers = new WeakSet<McpServer>();
  private readonly closedApplications =
    new WeakSet<INestApplicationContext>();

  private readonly parseEnvironment: (
    environment: NodeJS.ProcessEnv,
  ) => McpStdioBootstrapConfig;

  private readonly connect: (
    options: ConnectMcpStdioOptions,
  ) => Promise<McpStdioConnection>;

  constructor(
    private readonly dependencies: McpStdioProcessRunnerDependencies,
  ) {
    this.parseEnvironment =
      dependencies.parseEnvironment ?? parseMcpStdioEnvironment;
    this.connect = dependencies.connect ?? connectMcpStdio;
  }

  /** 注册生命周期监听并启动应用；启动异常只暴露固定错误码。 */
  async run(): Promise<void> {
    this.registerLifecycleListeners();
    try {
      const config = this.parseEnvironment(
        this.dependencies.lifecycle.environment,
      );
      const application = await this.dependencies.loadApplication();
      this.application = application;
      if (this.stopping) {
        await this.closeApplication(application);
        return;
      }

      const connection = await this.connect({
        application,
        innerTransport: this.dependencies.createInnerTransport(),
        config,
        onClose: () => {
          void this.shutdown(0);
        },
        onError: () => {
          this.reportConnectionFailure();
          void this.shutdown(1);
        },
      });
      this.server = connection.server;
      if (this.stopping) {
        await this.closeServer(connection.server);
      }
    } catch {
      this.writeStableError(MCP_STDIO_STARTUP_FAILED);
      await this.shutdown(1);
    }
  }

  /** 关闭协议、数据库与队列连接；重复事件不得触发二次关闭。 */
  async shutdown(exitCode: number): Promise<void> {
    this.raiseExitCode(exitCode);
    if (this.stopping) return;
    this.stopping = true;

    await this.closeServer(this.server);
    await this.closeApplication(this.application);
  }

  private registerLifecycleListeners(): void {
    const shutdownGracefully = (): void => {
      void this.shutdown(0);
    };
    this.dependencies.lifecycle.onInputEnd(shutdownGracefully);
    this.dependencies.lifecycle.onSignal('SIGINT', shutdownGracefully);
    this.dependencies.lifecycle.onSignal('SIGTERM', shutdownGracefully);
  }

  private reportConnectionFailure(): void {
    if (this.connectionFailureReported) return;
    this.connectionFailureReported = true;
    this.writeStableError(MCP_STDIO_CONNECTION_FAILED);
  }

  private writeStableError(code: McpStdioStableErrorCode): void {
    try {
      this.dependencies.lifecycle.writeError(code);
    } catch {
      this.raiseExitCode(1);
    }
  }

  private raiseExitCode(exitCode: number): void {
    const currentExitCode = this.dependencies.lifecycle.getExitCode() ?? 0;
    this.dependencies.lifecycle.setExitCode(
      Math.max(currentExitCode, exitCode),
    );
  }

  private async closeServer(server: McpServer | undefined): Promise<void> {
    if (server === undefined || this.closedServers.has(server)) return;
    this.closedServers.add(server);
    try {
      await server.close();
    } catch {
      this.raiseExitCode(1);
    }
  }

  private async closeApplication(
    application: INestApplicationContext | undefined,
  ): Promise<void> {
    if (
      application === undefined ||
      this.closedApplications.has(application)
    ) {
      return;
    }
    this.closedApplications.add(application);
    try {
      await application.close();
    } catch {
      this.raiseExitCode(1);
    }
  }
}
