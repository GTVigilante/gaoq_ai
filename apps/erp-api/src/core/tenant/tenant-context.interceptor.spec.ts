import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

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
  it('公开路由不要求身份且不建立租户上下文', async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const interceptor = new TenantContextInterceptor(reflector, new TenantContextService());
    const next: CallHandler = { handle: () => of('public') };
    await expect(firstValueFrom(interceptor.intercept(
      createExecutionContext({}),
      next,
    ))).resolves.toBe('public');
  });

  it('客户端租户头不能替代已验证身份', () => {
    const interceptor = new TenantContextInterceptor(new Reflector(), new TenantContextService());
    const context = createExecutionContext({ headers: { 'x-tenant-id': 'attacker-tenant' } });
    const next: CallHandler = { handle: () => of('不应执行') };

    expect(() => interceptor.intercept(context, next)).toThrow(UnauthorizedException);
  });

  it.each([
    { tenantId: '' },
    { actorId: '' },
    { roleCodes: null },
    { scopes: null },
    { departmentIds: null },
  ])('拒绝字段缺失或类型损坏的认证主体 %#', (patch) => {
    const interceptor = new TenantContextInterceptor(new Reflector(), new TenantContextService());
    const user = {
      actorId: 'employee-001',
      actorType: 'user',
      tenantId: 'tenant-001',
      identitySource: 'access_token',
      roleCodes: ['employee'],
      scopes: ['erp:identity:profile:read'],
      departmentIds: ['department-001'],
      ...patch,
    };
    const next: CallHandler = { handle: () => of('不应执行') };
    expect(() => interceptor.intercept(
      createExecutionContext({ user: user as never }),
      next,
    )).toThrow(UnauthorizedException);
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
        scopes: ['erp:identity:profile:read'],
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

  it('缺少入口 traceId 时生成服务端追踪标识', async () => {
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(new Reflector(), tenantContext);
    const context = createExecutionContext({
      user: {
        actorId: 'service-001',
        actorType: 'service',
        tenantId: 'tenant-001',
        identitySource: 'service_identity',
        roleCodes: [],
        scopes: ['erp:org:read'],
        departmentIds: [],
      },
    });
    const next: CallHandler = {
      handle: () => defer(() => of(tenantContext.getActorRequired().traceId)),
    };
    await expect(firstValueFrom(interceptor.intercept(context, next)))
      .resolves.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
