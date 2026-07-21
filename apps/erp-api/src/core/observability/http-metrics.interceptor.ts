import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { finalize, tap, type Observable } from 'rxjs';

import { elapsedSeconds, MetricsService } from './metrics.service.js';

/** 仅使用编译期有界的控制器/方法标签采集 HTTP 指标，避免路径参数造成基数爆炸。 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = process.hrtime.bigint();
    let statusCode = response.statusCode;
    return next.handle().pipe(
      tap({
        next: () => {
          statusCode = response.statusCode;
        },
        error: (error: unknown) => {
          statusCode = error instanceof HttpException ? error.getStatus() : 500;
        },
      }),
      finalize(() => {
        this.metrics.recordHttpRequest({
          method: request.method,
          controller: context.getClass().name,
          handler: context.getHandler().name,
          statusCode,
          durationSeconds: elapsedSeconds(startedAt),
        });
      }),
    );
  }
}
