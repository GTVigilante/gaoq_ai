import { describe, expect, it } from 'vitest';

import { TenantContextService } from './tenant-context.service.js';

describe('TenantContextService', () => {
  it('跨异步边界传播租户上下文', async () => {
    const service = new TenantContextService();

    const tenantId = await service.run(
      {
        tenant: { tenantId: 'tenant-001', source: 'access_token' },
        actor: {
          actorId: 'employee-001',
          actorType: 'user',
          tenantId: 'tenant-001',
          roleCodes: ['employee'],
          scopes: ['profile:read'],
          departmentIds: ['department-001'],
          traceId: 'trace-001',
        },
      },
      async () => {
        await Promise.resolve();
        return service.getTenantRequired().tenantId;
      },
    );

    expect(tenantId).toBe('tenant-001');
  });

  it('在上下文外拒绝提供租户', () => {
    const service = new TenantContextService();
    expect(() => service.getRequired()).toThrow('可信租户上下文不存在');
  });
});
