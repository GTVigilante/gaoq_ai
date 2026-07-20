import { Injectable, type NestMiddleware } from '@nestjs/common';
import { resolveTraceId } from '@gaoq/shared-utils';
import type { NextFunction, Response } from 'express';

import type { ErpRequest } from './request-context.js';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  /** 仅接收通过白名单校验的追踪标识，否则生成服务端标识。 */
  use(request: ErpRequest, response: Response, next: NextFunction): void {
    const header = request.header('x-trace-id');
    const traceId = resolveTraceId(header);
    request.traceId = traceId;
    response.setHeader('x-trace-id', traceId);
    next();
  }
}
