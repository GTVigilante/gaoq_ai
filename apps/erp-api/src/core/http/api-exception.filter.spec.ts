import { UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { ApiExceptionFilter } from './api-exception.filter.js';

interface ResponseDouble {
  readonly setHeader: ReturnType<typeof vi.fn>;
  readonly status: ReturnType<typeof vi.fn>;
  readonly json: ReturnType<typeof vi.fn>;
}

function createHost(path: string): {
  readonly host: ArgumentsHost;
  readonly response: ResponseDouble;
} {
  const response: ResponseDouble = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  const request = { path, traceId: 'trace-filter-test' };
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
});
