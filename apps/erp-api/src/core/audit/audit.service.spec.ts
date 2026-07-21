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

  it('后台任务显式记录系统主体且拒绝操作符形态租户', async () => {
    const context = new TenantContextService();
    const sink = new CapturingAuditSink();
    const service = new AuditService(sink, context);

    await service.recordSystem('tenant-001', {
      action: 'integration.org.reconciliation',
      resourceType: 'org_reconciliation_report',
      riskLevel: 'R1',
      outcome: 'success',
      traceId: 'trace-system-001',
    });

    expect(sink.append).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001',
      actorId: 'system:integration-worker',
      actorType: 'system_job',
      traceId: 'trace-system-001',
    }));
    await expect(service.recordSystem('$ne', {
      action: 'x', resourceType: 'x', riskLevel: 'R0', outcome: 'failure', traceId: 'trace-2',
    })).rejects.toThrow('系统审计上下文非法');
  });

  it('公共 OAuth 端点可在独立验明用户后记录可信主体审计', async () => {
    const sink = new CapturingAuditSink();
    const service = new AuditService(sink, new TenantContextService());

    await service.recordTrustedUser('tenant-001', {
      actorId: 'actor-001',
      traceId: 'trace-oauth-001',
      action: 'identity.oauth.authorize',
      resourceType: 'oauth_client',
      resourceId: 'mcp-client-001',
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { approved: true, scopeCount: 2 },
    });

    expect(sink.append).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', actorId: 'actor-001', actorType: 'user',
      traceId: 'trace-oauth-001',
    }));
    await expect(service.recordTrustedUser('$where', {
      actorId: 'actor-001', traceId: 'trace-oauth-002', action: 'x',
      resourceType: 'x', riskLevel: 'R1', outcome: 'failure',
    })).rejects.toThrow('可信用户审计上下文非法');
  });

  it('客户端凭据流使用 mcp_client 主体且拒绝不可信标识', async () => {
    const sink = new CapturingAuditSink();
    const service = new AuditService(sink, new TenantContextService());
    await service.recordTrustedService('tenant-001', {
      actorId: 'mcp-agent-001', traceId: 'trace-service-001',
      action: 'identity.oauth.service-token.issue', resourceType: 'oauth_client',
      resourceId: 'service-client-001', riskLevel: 'R1', outcome: 'success',
    });
    expect(sink.append).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', actorId: 'mcp-agent-001', actorType: 'mcp_client',
    }));
    await expect(service.recordTrustedService('tenant-001', {
      actorId: '$where', traceId: 'trace-service-002', action: 'x', resourceType: 'x',
      riskLevel: 'R1', outcome: 'failure',
    })).rejects.toThrow('可信服务审计上下文非法');
  });
});
