import {
  Catch,
  HttpException,
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

const PUBLIC_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;
const PUBLIC_ERROR_MESSAGE_MAX_LENGTH = 512;
const PUBLIC_ERROR_DETAIL_MAX_LENGTH = 256;
const PUBLIC_ERROR_DETAIL_MAX_COUNT = 20;
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_SERVER_ERROR = 500;

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
    const requestedStatus = exception instanceof HttpException
      ? exception.getStatus()
      : HTTP_INTERNAL_SERVER_ERROR;
    const status = Number.isInteger(requestedStatus) &&
      requestedStatus >= HTTP_BAD_REQUEST &&
      requestedStatus <= 599
      ? requestedStatus
      : HTTP_INTERNAL_SERVER_ERROR;
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
    const fallbackCode = `HTTP_${status}`;
    const fallbackMessage = status >= HTTP_INTERNAL_SERVER_ERROR
      ? '服务暂时不可用'
      : normalizePublicMessage(exception.message, '请求失败', PUBLIC_ERROR_MESSAGE_MAX_LENGTH);
    if (typeof payload === 'string') {
      return {
        code: fallbackCode,
        message: status >= HTTP_INTERNAL_SERVER_ERROR
          ? fallbackMessage
          : normalizePublicMessage(payload, fallbackMessage, PUBLIC_ERROR_MESSAGE_MAX_LENGTH),
        errors: [],
      };
    }
    if (typeof payload !== 'object' || payload === null) {
      return { code: fallbackCode, message: fallbackMessage, errors: [] };
    }

    const record = payload as Record<string, unknown>;
    const code = typeof record['code'] === 'string' &&
      PUBLIC_ERROR_CODE_PATTERN.test(record['code'])
      ? record['code']
      : fallbackCode;
    if (status >= HTTP_INTERNAL_SERVER_ERROR) {
      return { code, message: fallbackMessage, errors: [] };
    }
    const rawMessage = record['message'];
    const messages = Array.isArray(rawMessage)
      ? rawMessage
        .slice(0, PUBLIC_ERROR_DETAIL_MAX_COUNT)
        .filter((item): item is string => typeof item === 'string')
        .map((item) => normalizePublicMessage(item, '', PUBLIC_ERROR_DETAIL_MAX_LENGTH))
        .filter((item) => item.length > 0)
      : [];
    const message = typeof rawMessage === 'string'
      ? normalizePublicMessage(rawMessage, fallbackMessage, PUBLIC_ERROR_MESSAGE_MAX_LENGTH)
      : (messages[0] ?? fallbackMessage);
    const errors = messages.map((item) => ({ code, message: item }));

    return { code, message, errors };
  }
}

function normalizePublicMessage(value: string, fallback: string, maximumLength: number): string {
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= maximumLength &&
    !containsControlCharacter(normalized)
    ? normalized
    : fallback;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
