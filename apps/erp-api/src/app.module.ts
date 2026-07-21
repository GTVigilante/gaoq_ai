import { Logger, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { validateEnvironment, type AppEnvironment } from './config/environment.js';
import { AuditModule } from './core/audit/audit.module.js';
import { ApiExceptionFilter } from './core/http/api-exception.filter.js';
import { ApiResponseInterceptor } from './core/http/api-response.interceptor.js';
import { TraceMiddlewareModule } from './core/http/trace-middleware.module.js';
import { TenantContextInterceptor } from './core/tenant/tenant-context.interceptor.js';
import { TenantContextModule } from './core/tenant/tenant-context.module.js';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { toBullMqConnection } from './infrastructure/redis/redis-options.js';
import type { Connection } from 'mongoose';
import { IdentityModule } from './modules/identity/identity.module.js';
import { BearerAuthGuard } from './modules/identity/bearer-auth.guard.js';
import { IntegrationModule } from './modules/integration/integration.module.js';
import { McpModule } from './modules/mcp/mcp.module.js';
import { McpOriginGuard } from './modules/mcp/mcp-origin.guard.js';
import { OrgModule } from './modules/org/org.module.js';

const mongoLogger = new Logger('MongoDB');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        autoIndex: config.get('NODE_ENV', { infer: true }) !== 'production',
        lazyConnection: true,
        serverSelectionTimeoutMS: 3_000,
        connectionFactory: (connection: Connection): Connection => {
          void connection
            .asPromise()
            .catch(() => mongoLogger.warn('MongoDB 初始连接失败，等待就绪探针重新连接'));
          return connection;
        },
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>) => ({
        connection: toBullMqConnection(config.get('REDIS_URL', { infer: true })),
      }),
    }),
    RedisModule,
    IdentityModule,
    IntegrationModule,
    McpModule,
    OrgModule,
    TraceMiddlewareModule,
    TenantContextModule,
    AuditModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: McpOriginGuard,
    },
    {
      provide: APP_GUARD,
      useClass: BearerAuthGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantContextInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ApiResponseInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
  ],
})
export class AppModule {}
