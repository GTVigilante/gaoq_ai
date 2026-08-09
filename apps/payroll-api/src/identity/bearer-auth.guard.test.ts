import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../config/environment.js';
import type { AccessTokenVerifier } from './access-token-verifier.js';
import { BearerAuthGuard } from './bearer-auth.guard.js';

describe('算薪 Bearer 发现协议', () => {
  it('未认证响应发布 RFC 9728 resource_metadata，且不尝试验签', async () => {
    const setHeader = vi.fn();
    const request = { headers: {} };
    const context = {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader }),
      }),
    } as unknown as ExecutionContext;
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const verify = vi.fn();
    const verifier = { verify } as unknown as AccessTokenVerifier;
    const config = {
      get: vi.fn().mockReturnValue('https://aio.gaoq.com/api/payroll/v1'),
    } as unknown as ConfigService<AppEnvironment, true>;
    const guard = new BearerAuthGuard(reflector, verifier, config);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer resource_metadata="https://aio.gaoq.com/.well-known/oauth-protected-resource/api/payroll/v1"',
    );
    expect(verify).not.toHaveBeenCalled();
  });
});
