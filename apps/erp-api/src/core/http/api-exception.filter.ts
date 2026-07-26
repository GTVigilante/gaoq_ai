import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ApiErrorResponse, ErrorDetail } from '@gaoq/shared-types';
import { createTraceId } from '@gaoq/shared-utils';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';

import type { ErpRequest } from './request-context.js';
import type { AppEnvironment } from '../../config/environment.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  /** 屏蔽未知异常细节，并返回稳定的错误代码与追踪标识。 */
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ErpRequest>();
    const response = http.getResponse<Response>();
    const traceId = request.traceId ?? createTraceId();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const error = this.toPublicError(exception, status);
    const body: ApiErrorResponse = {
      code: error.code,
      message: error.message,
      data: error.errors.length > 0 ? { errors: error.errors } : null,
      traceId,
      timestamp: new Date().toISOString(),
    };

    if (status === 401 && request.path !== '/mcp') {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }

    if ((status === 401 || status === 403) && request.path === '/mcp') {
      const metadataUrl = new URL(
        '/.well-known/oauth-protected-resource',
        this.config.get('AUTH_RESOURCE', { infer: true }),
      );
      const challenge = status === 401
        ? `Bearer resource_metadata="${metadataUrl.toString()}", scope="erp:mcp:server:connect"`
        : `Bearer error="insufficient_scope", resource_metadata="${metadataUrl.toString()}", scope="erp:mcp:server:connect"`;
      response.setHeader('WWW-Authenticate', challenge);
    }

    if (!(exception instanceof HttpException)) {
      this.logger.error(`未处理异常 traceId=${traceId}`, exception instanceof Error ? exception.stack : undefined);
    } else if (status >= 500) {
      this.logger.warn(`服务异常响应 status=${status} traceId=${traceId}`);
    }

    response.status(status).json(body);
  }

  private toPublicError(
    exception: unknown,
    status: number,
  ): { code: string; message: string; errors: readonly ErrorDetail[] } {
    if (!(exception instanceof HttpException)) {
      return { code: 'INTERNAL_ERROR', message: '服务暂时不可用', errors: [] };
    }

    const payload: unknown = exception.getResponse();
    const fallbackMessage = exception.message || '请求失败';
    if (typeof payload === 'string') {
      return { code: `HTTP_${status}`, message: payload, errors: [] };
    }
    if (typeof payload !== 'object' || payload === null) {
      return { code: `HTTP_${status}`, message: fallbackMessage, errors: [] };
    }

    const record = payload as Record<string, unknown>;
    const rawMessage = record['message'];
    const messages = Array.isArray(rawMessage)
      ? rawMessage.filter((item): item is string => typeof item === 'string')
      : [];
    const message = typeof rawMessage === 'string' ? rawMessage : (messages[0] ?? fallbackMessage);
    const errors = messages.map((item) => ({ code: `HTTP_${status}`, message: item }));
    const code = typeof record['code'] === 'string' ? record['code'] : `HTTP_${status}`;

    return { code, message, errors };
  }
}
