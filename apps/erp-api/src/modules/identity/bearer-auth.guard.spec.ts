import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import type { ErpRequest } from '../../core/http/request-context.js';
import { AccessTokenVerifier } from './access-token-verifier.js';
import type { VerifiedAccessToken } from './auth.types.js';
import { REQUIRED_SCOPES_KEY } from './auth.decorators.js';
import { BearerAuthGuard } from './bearer-auth.guard.js';

const handler = (): void => undefined;
class ProtectedController {}

class StubVerifier extends AccessTokenVerifier {
  override verify(): Promise<VerifiedAccessToken> {
    return Promise.resolve({
      issuer: 'https://auth.example.internal',
      subject: 'user-001',
      audience: ['gaoq-erp'],
      resource: ['https://erp.example.com/mcp'],
      tenantId: 'trusted-tenant',
      actorId: 'employee-001',
      actorType: 'user',
      clientId: 'gaoq-web',
      roleCodes: ['employee'],
      scopes: ['mcp:connect'],
      departmentIds: ['department-001'],
      sessionId: 'session-001',
      expiresAt: 4_102_444_800,
    });
  }
}

const createContext = (request: Partial<ErpRequest>): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => ProtectedController,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('BearerAuthGuard', () => {
  it('拒绝缺失 Bearer Token 的请求', async () => {
    const guard = new BearerAuthGuard(new Reflector(), new StubVerifier());
    const request = { header: () => undefined } as unknown as ErpRequest;
    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('可信令牌租户覆盖攻击者提交的租户头', async () => {
    const guard = new BearerAuthGuard(new Reflector(), new StubVerifier());
    const headers = {
      authorization: 'Bearer signed.token.value',
      'x-tenant-id': 'attacker-tenant',
    };
    const request = {
      headers,
      header(name: string): string | undefined {
        const value = headers[name.toLowerCase() as keyof typeof headers];
        return value;
      },
    } as unknown as ErpRequest;

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user?.tenantId).toBe('trusted-tenant');
  });

  it('拒绝端点要求但令牌未授予的 scope', async () => {
    const reflector = new Reflector();
    Reflect.defineMetadata(REQUIRED_SCOPES_KEY, ['org:write'], handler);
    const guard = new BearerAuthGuard(reflector, new StubVerifier());
    const request = {
      header: () => 'Bearer signed.token.value',
    } as unknown as ErpRequest;

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
