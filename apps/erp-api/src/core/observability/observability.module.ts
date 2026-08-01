import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { HttpMetricsInterceptor } from './http-metrics.interceptor.js';
import { MetricsAccessGuard } from './metrics-access.guard.js';
import { MetricsAuthorizationService } from './metrics-authorization.service.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

/** API 与 Worker 共用的低基数可观测性底座。 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricsAuthorizationService,
    MetricsAccessGuard,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [MetricsService, MetricsAuthorizationService],
})
export class ObservabilityModule {}
