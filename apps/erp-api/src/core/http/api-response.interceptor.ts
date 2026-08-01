import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { ApiSuccessResponse } from '@gaoq/shared-types';
import { createTraceId } from '@gaoq/shared-utils';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';

import type { ErpRequest } from './request-context.js';
import { RAW_RESPONSE_KEY } from './public-route.decorator.js';

@Injectable()
export class ApiResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T>> {
  constructor(private readonly reflector: Reflector) {}

  /** 将成功响应统一包装，确保客户端和 MCP 适配层使用同一契约。 */
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T>> {
    const rawResponse = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (rawResponse === true) {
      return next.handle() as Observable<ApiSuccessResponse<T>>;
    }
    const request = context.switchToHttp().getRequest<ErpRequest>();
    const traceId = request.traceId ?? createTraceId();

    return next.handle().pipe(
      map((data) => ({
        code: 'SUCCESS',
        message: '成功',
        data,
        traceId,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
