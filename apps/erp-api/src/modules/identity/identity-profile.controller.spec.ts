import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { IdentityProfileController } from './identity-profile.controller.js';

describe('IdentityProfileController', () => {
  it('只返回可信身份中的授权快照并记录脱敏审计', async () => {
    const context = new TenantContextService();
    const audit = { record: vi.fn() };
    const controller = new IdentityProfileController(context, audit as unknown as AuditService);
    const result = await context.run({
      tenant: { tenantId: 'tenant-001', source: 'access_token' },
      actor: {
        actorId: 'actor-001', actorType: 'user', tenantId: 'tenant-001',
        roleCodes: ['employee'], scopes: ['erp:identity:profile:read'],
        departmentIds: ['department-001'], traceId: 'trace-profile-001',
      },
    }, () => controller.get());
    expect(result).toEqual({
      actorId: 'actor-001', actorType: 'user', roleCodes: ['employee'],
      scopes: ['erp:identity:profile:read'], departmentIds: ['department-001'],
    });
    expect(result).not.toHaveProperty('tenantId');
    expect(Object.isFrozen(result.scopes)).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'identity.profile.read', resourceId: 'actor-001', riskLevel: 'R0',
      metadata: { roleCount: 1, scopeCount: 1, departmentCount: 1 },
    }));
  });
});
