import { Logger, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

import { validateWorkerEnvironment, type AppEnvironment } from './config/environment.js';
import { AuditWorkerModule } from './core/audit/audit-worker.module.js';
import { ObservabilityModule } from './core/observability/observability.module.js';
import { WorkerMetricsServer } from './core/observability/worker-metrics.server.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { toBullMqConnection } from './infrastructure/redis/redis-options.js';
import { IntegrationWorkerModule } from './modules/integration/integration-worker.module.js';
import { ApprovalNotificationWorkerModule } from './modules/approval/notification/approval-notification-worker.module.js';
import { CareWorkerModule } from './modules/care/care-worker.module.js';
import { AnalyticsWorkerModule } from './modules/analytics/analytics-worker.module.js';
import { DataMigrationWorkerModule } from './modules/data-migration/data-migration-worker.module.js';
import { MarketingCmsWorkerModule } from './modules/marketing-cms/marketing-cms-worker.module.js';
import { RecruitmentResumeWorkerModule } from './modules/recruitment/recruitment-resume-worker.module.js';
import { KnowledgeSearchWorkerModule } from './modules/knowledge/knowledge-search-worker.module.js';

const mongoLogger = new Logger('WorkerMongoDB');

/** 独立后台 Worker 根模块，不监听 HTTP 端口。 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateWorkerEnvironment }),
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
    RedisModule,
    IntegrationWorkerModule,
    ApprovalNotificationWorkerModule,
    CareWorkerModule,
    AnalyticsWorkerModule,
    DataMigrationWorkerModule,
    MarketingCmsWorkerModule,
    RecruitmentResumeWorkerModule,
    KnowledgeSearchWorkerModule,
    AuditWorkerModule,
    ObservabilityModule,
  ],
  providers: [WorkerMetricsServer],
})
export class WorkerModule {}
