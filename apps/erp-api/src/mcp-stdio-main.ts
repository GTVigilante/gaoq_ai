import 'reflect-metadata';

import process from 'node:process';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NestFactory } from '@nestjs/core';

import { McpStdioProcessRunner } from './modules/mcp/mcp-stdio-process-runner.js';

const runner = new McpStdioProcessRunner({
  lifecycle: {
    environment: process.env,
    getExitCode: () =>
      typeof process.exitCode === 'number' ? process.exitCode : undefined,
    setExitCode: (exitCode) => {
      process.exitCode = exitCode;
    },
    writeError: (code) => {
      process.stderr.write(`${code}\n`);
    },
    onInputEnd: (listener) => {
      process.stdin.once('end', listener);
    },
    onSignal: (signal, listener) => {
      process.once(signal, listener);
    },
  },
  loadApplication: async () => {
    // stdio 专用环境预检由 Runner 先执行，防止模块加载异常泄漏堆栈或路径。
    const { AppModule } = await import('./app.module.js');
    return NestFactory.createApplicationContext(AppModule, {
      abortOnError: false,
      logger: false,
    });
  },
  createInnerTransport: () =>
    new StdioServerTransport(process.stdin, process.stdout),
});

void runner.run();
