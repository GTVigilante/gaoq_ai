import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module.js';

const logger = new Logger('IntegrationWorker');

async function bootstrap(): Promise<void> {
  const application = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  application.enableShutdownHooks();
  logger.log('组织集成 Worker 已启动');
}

void bootstrap().catch((error: unknown) => {
  void error;
  logger.error('组织集成 Worker 启动失败');
  process.exitCode = 1;
});
