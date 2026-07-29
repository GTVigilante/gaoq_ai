import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { INestApplicationContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  ConnectMcpStdioOptions,
  McpStdioBootstrapConfig,
  McpStdioConnection,
} from './mcp-stdio-bootstrap.js';
import {
  MCP_STDIO_CONNECTION_FAILED,
  MCP_STDIO_STARTUP_FAILED,
  McpStdioProcessRunner,
  type McpStdioProcessLifecycle,
} from './mcp-stdio-process-runner.js';

interface TestContext {
  readonly application: INestApplicationContext;
  readonly server: McpServer;
  readonly transport: Transport;
  readonly applicationClose: Mock<() => Promise<void>>;
  readonly serverClose: Mock<() => Promise<void>>;
  readonly lifecycle: McpStdioProcessLifecycle;
  readonly errors: string[];
  readonly inputEndListeners: Array<() => void>;
  readonly signalListeners: Map<NodeJS.Signals, () => void>;
  readonly loadApplication: Mock<
    () => Promise<INestApplicationContext>
  >;
  readonly parseEnvironment: Mock<
    (environment: NodeJS.ProcessEnv) => McpStdioBootstrapConfig
  >;
  readonly connect: Mock<
    (options: ConnectMcpStdioOptions) => Promise<McpStdioConnection>
  >;
  getExitCode(): number | undefined;
}

const config: McpStdioBootstrapConfig = {
  accessToken: 'header.payload.signature',
  traceId: 'trace-stdio-runner',
};

const createContext = (): TestContext => {
  let exitCode: number | undefined;
  const errors: string[] = [];
  const inputEndListeners: Array<() => void> = [];
  const signalListeners = new Map<NodeJS.Signals, () => void>();
  const applicationClose =
    vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const serverClose =
    vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const application = {
    close: applicationClose,
  } as unknown as INestApplicationContext;
  const server = {
    close: serverClose,
  } as unknown as McpServer;
  const transport = {} as Transport;
  const lifecycle: McpStdioProcessLifecycle = {
    environment: {
      MCP_STDIO_ACCESS_TOKEN: 'header.payload.signature',
    },
    getExitCode: () => exitCode,
    setExitCode: (nextExitCode) => {
      exitCode = nextExitCode;
    },
    writeError: (code) => {
      errors.push(code);
    },
    onInputEnd: (listener) => {
      inputEndListeners.push(listener);
    },
    onSignal: (signal, listener) => {
      signalListeners.set(signal, listener);
    },
  };
  const loadApplication =
    vi.fn<() => Promise<INestApplicationContext>>()
      .mockResolvedValue(application);
  const parseEnvironment =
    vi.fn<(environment: NodeJS.ProcessEnv) => McpStdioBootstrapConfig>()
      .mockReturnValue(config);
  const connect =
    vi.fn<
      (options: ConnectMcpStdioOptions) => Promise<McpStdioConnection>
    >().mockResolvedValue({
      server,
      transport: transport as never,
    });

  return {
    application,
    server,
    transport,
    applicationClose,
    serverClose,
    lifecycle,
    errors,
    inputEndListeners,
    signalListeners,
    loadApplication,
    parseEnvironment,
    connect,
    getExitCode: () => exitCode,
  };
};

const createRunner = (context: TestContext): McpStdioProcessRunner =>
  new McpStdioProcessRunner({
    lifecycle: context.lifecycle,
    loadApplication: context.loadApplication,
    createInnerTransport: () => context.transport,
    parseEnvironment: context.parseEnvironment,
    connect: context.connect,
  });

describe('MCP stdio 进程运行器', () => {
  let context: TestContext;

  beforeEach(() => {
    context = createContext();
  });

  it('先校验环境再加载应用并注册全部生命周期监听', async () => {
    context.parseEnvironment.mockImplementation(() => {
      expect(context.loadApplication).not.toHaveBeenCalled();
      return config;
    });
    const runner = createRunner(context);

    await runner.run();

    expect(context.parseEnvironment).toHaveBeenCalledWith(
      context.lifecycle.environment,
    );
    expect(context.loadApplication).toHaveBeenCalledOnce();
    const options = context.connect.mock.calls[0]?.[0];
    expect(options?.application).toBe(context.application);
    expect(options?.innerTransport).toBe(context.transport);
    expect(options?.config).toBe(config);
    expect(typeof options?.onClose).toBe('function');
    expect(typeof options?.onError).toBe('function');
    expect(context.inputEndListeners).toHaveLength(1);
    expect([...context.signalListeners.keys()]).toEqual([
      'SIGINT',
      'SIGTERM',
    ]);
    expect(context.errors).toEqual([]);
    expect(context.getExitCode()).toBeUndefined();
  });

  it('环境预检失败时不加载应用且只输出启动稳定码', async () => {
    context.parseEnvironment.mockImplementation(() => {
      throw new Error('包含敏感配置的内部异常');
    });
    const runner = createRunner(context);

    await runner.run();

    expect(context.loadApplication).not.toHaveBeenCalled();
    expect(context.connect).not.toHaveBeenCalled();
    expect(context.errors).toEqual([MCP_STDIO_STARTUP_FAILED]);
    expect(context.getExitCode()).toBe(1);
  });

  it('连接失败时关闭已加载应用且不暴露异常内容', async () => {
    context.connect.mockRejectedValue(new Error('数据库地址与堆栈'));
    const runner = createRunner(context);

    await runner.run();

    expect(context.errors).toEqual([MCP_STDIO_STARTUP_FAILED]);
    expect(context.applicationClose).toHaveBeenCalledOnce();
    expect(context.serverClose).not.toHaveBeenCalled();
    expect(context.getExitCode()).toBe(1);
  });

  it('输入结束与重复信号只关闭一次并保留已有较高退出码', async () => {
    const runner = createRunner(context);
    context.lifecycle.setExitCode(2);
    await runner.run();

    context.inputEndListeners[0]?.();
    context.signalListeners.get('SIGINT')?.();
    context.signalListeners.get('SIGTERM')?.();
    await vi.waitFor(() => {
      expect(context.serverClose).toHaveBeenCalledOnce();
      expect(context.applicationClose).toHaveBeenCalledOnce();
    });

    expect(context.getExitCode()).toBe(2);
    expect(context.errors).toEqual([]);
  });

  it('协议关闭回调执行优雅关闭', async () => {
    const runner = createRunner(context);
    await runner.run();
    const options = context.connect.mock.calls[0]?.[0];

    options?.onClose?.();

    await vi.waitFor(() => {
      expect(context.serverClose).toHaveBeenCalledOnce();
      expect(context.applicationClose).toHaveBeenCalledOnce();
    });
    expect(context.getExitCode()).toBe(0);
  });

  it('协议错误只报告一次连接稳定码并以失败状态关闭', async () => {
    const runner = createRunner(context);
    await runner.run();
    const options = context.connect.mock.calls[0]?.[0];

    options?.onError?.(new Error('令牌与路径不得输出'));
    options?.onError?.(new Error('重复异常'));

    await vi.waitFor(() => {
      expect(context.serverClose).toHaveBeenCalledOnce();
      expect(context.applicationClose).toHaveBeenCalledOnce();
    });
    expect(context.errors).toEqual([MCP_STDIO_CONNECTION_FAILED]);
    expect(context.getExitCode()).toBe(1);
  });

  it('应用加载期间收到终止信号时不建立连接并关闭迟到应用', async () => {
    let resolveApplication:
      | ((application: INestApplicationContext) => void)
      | undefined;
    context.loadApplication.mockReturnValue(
      new Promise<INestApplicationContext>((resolve) => {
        resolveApplication = resolve;
      }),
    );
    const runner = createRunner(context);
    const running = runner.run();

    context.signalListeners.get('SIGTERM')?.();
    resolveApplication?.(context.application);
    await running;

    expect(context.connect).not.toHaveBeenCalled();
    expect(context.applicationClose).toHaveBeenCalledOnce();
    expect(context.getExitCode()).toBe(0);
  });

  it('连接期间收到终止信号时关闭迟到协议服务', async () => {
    let resolveConnection:
      | ((connection: McpStdioConnection) => void)
      | undefined;
    context.connect.mockReturnValue(
      new Promise<McpStdioConnection>((resolve) => {
        resolveConnection = resolve;
      }),
    );
    const runner = createRunner(context);
    const running = runner.run();
    await vi.waitFor(() => {
      expect(context.connect).toHaveBeenCalledOnce();
    });

    context.signalListeners.get('SIGINT')?.();
    resolveConnection?.({
      server: context.server,
      transport: context.transport as never,
    });
    await running;

    expect(context.applicationClose).toHaveBeenCalledOnce();
    expect(context.serverClose).toHaveBeenCalledOnce();
    expect(context.getExitCode()).toBe(0);
  });

  it('资源关闭失败时保持失败退出且继续关闭另一资源', async () => {
    context.serverClose.mockRejectedValue(new Error('协议关闭失败'));
    context.applicationClose.mockRejectedValue(new Error('应用关闭失败'));
    const runner = createRunner(context);
    await runner.run();

    await runner.shutdown(0);

    expect(context.serverClose).toHaveBeenCalledOnce();
    expect(context.applicationClose).toHaveBeenCalledOnce();
    expect(context.errors).toEqual([]);
    expect(context.getExitCode()).toBe(1);
  });

  it('stderr 写入失败也转换为失败退出且不抛出', async () => {
    context.lifecycle.writeError = () => {
      throw new Error('stderr 已关闭');
    };
    context.parseEnvironment.mockImplementation(() => {
      throw new Error('启动失败');
    });
    const runner = createRunner(context);

    await expect(runner.run()).resolves.toBeUndefined();
    expect(context.getExitCode()).toBe(1);
  });
});
