import {
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { ApiExceptionFilter } from './api-exception.filter.js';

interface ResponseDouble {
  readonly setHeader: ReturnType<typeof vi.fn>;
  readonly status: ReturnType<typeof vi.fn>;
  readonly json: ReturnType<typeof vi.fn>;
}

function createHost(path: string, traceId: string | undefined = 'trace-filter-test'): {
  readonly host: ArgumentsHost;
  readonly response: ResponseDouble;
} {
  const response: ResponseDouble = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  const request = { path, traceId };
  return {
    host: {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
        getNext: () => undefined,
      }),
    } as unknown as ArgumentsHost,
    response,
  };
}

function createFilter(): ApiExceptionFilter {
  const config = {
    get: () => 'https://erp.example.com/mcp',
  } as unknown as ConfigService<AppEnvironment, true>;
  return new ApiExceptionFilter(config);
}

describe('ApiExceptionFilter Bearer 挑战', () => {
  it('普通 REST 401 返回标准 Bearer 挑战', () => {
    const { host, response } = createHost('/api/org/chart');

    createFilter().catch(
      new UnauthorizedException({ code: 'AUTH_REQUIRED', message: '缺少访问令牌' }),
      host,
    );

    expect(response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('MCP 401 返回 RFC 9728 资源元数据挑战', () => {
    const { host, response } = createHost('/mcp');

    createFilter().catch(
      new UnauthorizedException({ code: 'AUTH_REQUIRED', message: '缺少访问令牌' }),
      host,
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer resource_metadata="https://erp.example.com/.well-known/oauth-protected-resource", scope="erp:mcp:server:connect"',
    );
  });

  it('MCP 403 返回 insufficient_scope 挑战', () => {
    const { host, response } = createHost('/mcp');

    createFilter().catch(
      new ForbiddenException({ code: 'AUTH_SCOPE_DENIED', message: '权限不足' }),
      host,
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer error="insufficient_scope", resource_metadata="https://erp.example.com/.well-known/oauth-protected-resource", scope="erp:mcp:server:connect"',
    );
    expect(response.status).toHaveBeenCalledWith(403);
  });
});

describe('ApiExceptionFilter 公开错误收敛', () => {
  it('未知异常只返回通用错误并生成追踪标识', () => {
    const { host, response } = createHost('/api/payroll', undefined);
    const filter = createFilter();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    (filter as unknown as { logger: typeof logger }).logger = logger;

    filter.catch(new Error('secret-token-value'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    const body = response.json.mock.calls[0]?.[0] as unknown as {
      readonly code: string;
      readonly message: string;
      readonly data: null;
      readonly traceId: string;
      readonly timestamp: string;
    };
    expect(body).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: '服务暂时不可用',
      data: null,
    });
    expect(body.traceId).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(Date.parse(body.timestamp)).not.toBeNaN();
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('secret-token-value');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('所有 5xx 隐藏异常正文但保留规范稳定错误码', () => {
    const { host, response } = createHost('/api/health/ready');
    const filter = createFilter();
    const logger = { error: vi.fn(), warn: vi.fn() };
    (filter as unknown as { logger: typeof logger }).logger = logger;

    filter.catch(new ServiceUnavailableException({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'mongodb://user:password@internal',
    }), host);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: '服务暂时不可用',
      data: null,
    }));
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('password');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('4xx 只接受规范 code，并限制详情数量、长度和控制字符', () => {
    const { host, response } = createHost('/api/forms');
    const messages: unknown[] = Array.from(
      { length: 24 },
      (_, index) => `字段 ${index} 无效`,
    );
    messages[1] = '包含\n换行';
    messages[2] = 123;

    createFilter().catch(new HttpException({
      code: 'invalid-code',
      message: messages,
    }, 400), host);

    const body = response.json.mock.calls[0]?.[0] as {
      readonly code: string;
      readonly message: string;
      readonly data: { readonly errors: readonly unknown[] };
    };
    expect(body.code).toBe('HTTP_400');
    expect(body.message).toBe('字段 0 无效');
    expect(body.data.errors).toHaveLength(18);
    expect(JSON.stringify(body)).not.toContain('字段 20');
    expect(JSON.stringify(body)).not.toContain('\\n');
  });

  it('处理字符串、空对象和畸形状态时使用稳定回退', () => {
    const stringCase = createHost('/api/test');
    createFilter().catch(new HttpException(' 请求无效 ', 422), stringCase.host);
    expect(stringCase.response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'HTTP_422',
      message: '请求无效',
    }));

    const objectCase = createHost('/api/test');
    createFilter().catch(new HttpException({
      code: 'VALIDATION_FAILED',
      message: '\u0000unsafe',
    }, 400), objectCase.host);
    expect(objectCase.response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'VALIDATION_FAILED',
      message: '请求失败',
    }));

    const invalidStatus = createHost('/api/test');
    const invalidStatusFilter = createFilter();
    (invalidStatusFilter as unknown as {
      logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
    }).logger = { error: vi.fn(), warn: vi.fn() };
    invalidStatusFilter.catch(new HttpException('invalid status', 700), invalidStatus.host);
    expect(invalidStatus.response.status).toHaveBeenCalledWith(500);
    expect(invalidStatus.response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'HTTP_500',
      message: '服务暂时不可用',
    }));
  });
});
