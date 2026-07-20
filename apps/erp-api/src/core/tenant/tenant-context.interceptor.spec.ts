import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { ErpRequest } from '../http/request-context.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';
import { TenantContextService } from './tenant-context.service.js';

const handler = (): void => undefined;
class ProtectedController {}

/** 构造最小 Nest 执行上下文，避免测试依赖 HTTP 服务器。 */
const createExecutionContext = (request: Partial<ErpRequest>): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => ProtectedController,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('TenantContextInterceptor', () => {
  it('客户端租户头不能替代已验证身份', () => {
    const interceptor = new TenantContextInterceptor(new Reflector(), new TenantContextService());
    const context = createExecutionContext({ headers: { 'x-tenant-id': 'attacker-tenant' } });
    const next: CallHandler = { handle: () => of('不应执行') };

    expect(() => interceptor.intercept(context, next)).toThrow(UnauthorizedException);
  });

  it('从可信主体建立并跨 Observable 传播租户和操作人上下文', async () => {
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(new Reflector(), tenantContext);
    const context = createExecutionContext({
      traceId: 'trace-001',
      user: {
        actorId: 'employee-001',
        actorType: 'user',
        tenantId: 'tenant-001',
        identitySource: 'access_token',
        roleCodes: ['employee'],
        scopes: ['profile:read'],
        departmentIds: ['department-001'],
      },
    });
    const next: CallHandler = {
      handle: () =>
        defer(() =>
          of({
            tenantId: tenantContext.getTenantRequired().tenantId,
            actorId: tenantContext.getActorRequired().actorId,
          }),
        ),
    };

    await expect(firstValueFrom(interceptor.intercept(context, next))).resolves.toEqual({
      tenantId: 'tenant-001',
      actorId: 'employee-001',
    });
  });
});
