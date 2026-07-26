import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { AppModule } from './app.module.js';
import type { AppEnvironment } from './config/environment.js';

/** 启动专业算薪 API，并统一启用安全头、严格输入校验和受控跨域。 */
const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ConfigService<AppEnvironment, true>>(ConfigService);
  app.use(helmet());
  app.enableCors({
    origin: [config.get('WEB_ORIGIN', { infer: true })],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));
  app.setGlobalPrefix('api/payroll/v1');
  app.enableShutdownHooks();
  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
};

void bootstrap();
