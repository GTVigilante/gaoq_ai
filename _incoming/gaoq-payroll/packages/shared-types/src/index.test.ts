import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ActorContext,
  ApiErrorResponse,
  ApiResponse,
  ApiSuccessResponse,
  CloudEvent,
  ErrorDetail,
  IdempotencyContext,
  Money,
  RiskLevel,
  TenantContext,
} from './index.js';
import { RISK_LEVELS } from './index.js';

describe('RiskLevel', () => {
  it('按 R0 到 R3 顺序导出全部等级', () => {
    expect(RISK_LEVELS).toEqual(['R0', 'R1', 'R2', 'R3']);
  });
});

describe('TenantContext / ActorContext', () => {
  it('TenantContext 来源只允许已验证身份，不接受客户端头回退', () => {
    expectTypeOf<TenantContext['source']>().toEqualTypeOf<
      'access_token' | 'service_identity'
    >();
  });

  it('ActorContext 携带租户、角色、scope 与 traceId', () => {
    const actor: ActorContext = {
      actorType: 'mcp_client',
      actorId: 'mcp-001',
      tenantId: 'tenant-1',
      roleCodes: ['hr_admin'],
      scopes: ['payroll:read'],
      departmentIds: ['dept-1'],
      traceId: 'trace-1',
    };
    expect(actor.tenantId).toBe('tenant-1');
    expectTypeOf<ActorContext['actorType']>().toEqualTypeOf<
      'user' | 'service' | 'mcp_client' | 'system_job'
    >();
  });
});

describe('Money', () => {
  it('amountMinor 为十进制字符串而非 number', () => {
    const money: Money = { amountMinor: '12345', currency: 'CNY' };
    expect(money.amountMinor).toBe('12345');
    expectTypeOf<Money['amountMinor']>().toEqualTypeOf<string>();
  });
});

describe('API 响应信封', () => {
  it('成功与失败响应可判别联合', () => {
    const ok: ApiResponse<{ id: string }> = {
      code: 'SUCCESS',
      message: '成功',
      data: { id: '1' },
      traceId: 'trace-1',
      timestamp: '2026-07-21T00:00:00.000Z',
    };
    const fail: ApiResponse<never> = {
      code: 'TENANT_NOT_FOUND',
      message: '租户不存在',
      data: null,
      traceId: 'trace-1',
      timestamp: '2026-07-21T00:00:00.000Z',
    };
    expect(ok.code).toBe('SUCCESS');
    expect(fail.code).toBe('TENANT_NOT_FOUND');
    expectTypeOf<ApiSuccessResponse<{ id: string }>['data']>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<NonNullable<ApiErrorResponse['data']>['errors'][number]>().toEqualTypeOf<ErrorDetail>();
  });
});

describe('CloudEvent', () => {
  it('tenantId/traceId/idempotencyKey 为顶层扩展属性', () => {
    const event: CloudEvent<{ orderId: string }> = {
      specversion: '1.0',
      id: 'evt-1',
      source: '/payroll/cycles',
      type: 'os.gaoq.payroll.cycle.locked',
      time: '2026-07-20T00:00:00.000Z',
      datacontenttype: 'application/json',
      subject: 'cycle-1',
      data: { orderId: 'o-1' },
      tenantId: 'tenant-1',
      traceId: 'trace-1',
      idempotencyKey: 'idem-1',
    };
    expect(event.specversion).toBe('1.0');
    expectTypeOf<CloudEvent['specversion']>().toEqualTypeOf<'1.0'>();
  });
});

describe('IdempotencyContext', () => {
  it('幂等键限定在租户与业务作用域内', () => {
    const ctx: IdempotencyContext = {
      key: 'idem-1',
      tenantId: 'tenant-1',
      scope: 'payroll.payout',
    };
    expect(ctx.scope).toBe('payroll.payout');
    const risk: RiskLevel = 'R3';
    expect(RISK_LEVELS).toContain(risk);
  });
});
