import 'reflect-metadata';

import process from 'node:process';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import {
  connectMcpStdio,
  parseMcpStdioEnvironment,
} from './modules/mcp/mcp-stdio-bootstrap.js';

let application: INestApplicationContext | undefined;
let server: McpServer | undefined;
let stopping = false;

/** 关闭协议、数据库与队列连接；重复信号不得触发二次关闭。 */
const shutdown = async (exitCode: number): Promise<void> => {
  if (stopping) return;
  stopping = true;
  const currentExitCode =
    typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = Math.max(currentExitCode, exitCode);
  try {
    await server?.close();
  } catch {
    process.exitCode = 1;
  }
  try {
    await application?.close();
  } catch {
    process.exitCode = 1;
  }
};

/** 启动本地 MCP stdio 进程；stdout 永远只写 JSON-RPC 帧。 */
const bootstrap = async (): Promise<void> => {
  const config = parseMcpStdioEnvironment(process.env);
  // 必须在 stdio 专用环境预检后再加载 AppModule，避免配置异常由模块加载器输出堆栈。
  const { AppModule } = await import('./app.module.js');
  application = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: false,
  });
  const connection = await connectMcpStdio({
    application,
    innerTransport: new StdioServerTransport(process.stdin, process.stdout),
    config,
    onClose: () => {
      void shutdown(0);
    },
    onError: () => {
      process.stderr.write('MCP_STDIO_CONNECTION_FAILED\n');
      void shutdown(1);
    },
  });
  server = connection.server;
  process.stdin.once('end', () => {
    void shutdown(0);
  });
  process.once('SIGINT', () => {
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    void shutdown(0);
  });
};

void bootstrap().catch(() => {
  process.stderr.write('MCP_STDIO_STARTUP_FAILED\n');
  void shutdown(1);
});
