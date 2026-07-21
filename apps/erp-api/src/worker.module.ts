import { Logger, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

import { validateEnvironment, type AppEnvironment } from './config/environment.js';
import { AuditWorkerModule } from './core/audit/audit-worker.module.js';
import { ObservabilityModule } from './core/observability/observability.module.js';
import { WorkerMetricsServer } from './core/observability/worker-metrics.server.js';
import { toBullMqConnection } from './infrastructure/redis/redis-options.js';
import { IntegrationWorkerModule } from './modules/integration/integration-worker.module.js';
import { ApprovalNotificationWorkerModule } from './modules/approval/notification/approval-notification-worker.module.js';

const mongoLogger = new Logger('WorkerMongoDB');

/** 独立后台 Worker 根模块，不监听 HTTP 端口。 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }),
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
            .catch(() => mongoLogger.warn('MongoDB 初始连接失败，Worker 等待后续重连'));
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
    IntegrationWorkerModule,
    ApprovalNotificationWorkerModule,
    AuditWorkerModule,
    ObservabilityModule,
  ],
  providers: [WorkerMetricsServer],
})
export class WorkerModule {}
