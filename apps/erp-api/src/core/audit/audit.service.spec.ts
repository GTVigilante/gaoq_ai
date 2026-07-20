import type { AuditEvent } from './audit.types.js';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../tenant/tenant-context.service.js';
import { AuditService } from './audit.service.js';
import { AuditEventSink } from './audit.types.js';

class CapturingAuditSink extends AuditEventSink {
  readonly append = vi.fn<(event: AuditEvent) => Promise<void>>(() => Promise.resolve());
}

describe('AuditService', () => {
  it('使用可信上下文补齐租户、主体和 traceId', async () => {
    const context = new TenantContextService();
    const sink = new CapturingAuditSink();
    const service = new AuditService(sink, context);

    await context.run(
      {
        tenant: { tenantId: 'tenant-001', source: 'access_token' },
        actor: {
          actorType: 'user',
          actorId: 'employee-001',
          tenantId: 'tenant-001',
          roleCodes: ['employee'],
          scopes: ['profile:update'],
          departmentIds: ['department-001'],
          traceId: 'trace-001',
        },
      },
      async () =>
        service.record({
          action: 'employee.profile.update',
          resourceType: 'employee',
          resourceId: 'employee-001',
          riskLevel: 'R1',
          outcome: 'success',
        }),
    );

    expect(sink.append).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        actorId: 'employee-001',
        traceId: 'trace-001',
      }),
    );
  });
});
