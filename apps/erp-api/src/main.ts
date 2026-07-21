import 'reflect-metadata';

import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

import { AppModule } from './app.module.js';
import type { AppEnvironment } from './config/environment.js';

/**
 * 启动 ERP API，并统一设置安全响应头、跨域策略和输入校验。
 */
const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get<ConfigService<AppEnvironment, true>>(ConfigService);
  const allowedOrigins = [
    config.get('WEB_ORIGIN', { infer: true }),
    ...config
      .get('MCP_ALLOWED_ORIGINS', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ];

  app.use(helmet());
  app.enableCors({
    origin: [...new Set(allowedOrigins)],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'mcp', method: RequestMethod.ALL },
      { path: '.well-known/oauth-protected-resource', method: RequestMethod.GET },
      { path: '.well-known/jwks.json', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
};

void bootstrap();
