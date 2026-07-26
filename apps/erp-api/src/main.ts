import 'reflect-metadata';

import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { AppModule } from './app.module.js';
import type { AppEnvironment } from './config/environment.js';

/**
 * 启动 ERP API，并统一设置安全响应头、跨域策略和输入校验。
 */
const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true, rawBody: true, bodyParser: false,
  });
  // 完整工资影子清单最多 5000 行；统一保留硬上限并继续捕获 Webhook rawBody。
  app.useBodyParser('json', { limit: '8mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });
  const config = app.get<ConfigService<AppEnvironment, true>>(ConfigService);
  // 生产 NetworkPolicy 只允许单层入口网关访问 API；据此解析最接近网关写入的客户端 IP。
  app.set('trust proxy', 1);
  const allowedOrigins = [
    config.get('WEB_ORIGIN', { infer: true }),
    config.get('MARKETING_WEBSITE_ORIGIN', { infer: true }),
    ...config
      .get('MCP_ALLOWED_ORIGINS', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ].filter((origin): origin is string => origin !== undefined);

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
      { path: '.well-known/oauth-authorization-server', method: RequestMethod.GET },
      { path: '.well-known/jwks.json', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
};

void bootstrap();
