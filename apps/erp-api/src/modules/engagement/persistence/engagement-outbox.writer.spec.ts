import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  approveEngagement, createEngagementDraft, submitEngagement, type ServiceEngagement,
} from '../domain/engagement.js';
import { EngagementOutboxWriter } from './engagement-outbox.writer.js';

const SESSION = { inTransaction: () => true };
const NOW = new Date('2026-08-11T01:00:00.000Z');

function engagement(): ServiceEngagement {
  return approveEngagement(submitEngagement(createEngagementDraft({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4Y5', tenantId: 'tenant-a',
    engagementNumber: 'ENG-6P8R0T2W4Y',
    sourcingRequestId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    supplierId: '01J8ZQK7V0A2M4N6P8R0T2W4Y9', serviceCategoryCode: 'video_editing',
    agreedAmountMinor: '400000', currency: 'CNY', responsibleDepartmentId: 'department-1',
    ownerEmployeeId: 'employee-1', performerRefs: ['performer-1'], sourcingAwardVersion: 6,
  }, NOW), NOW), 'approval-1', NOW);
}

function harness() {
  const context = new TenantContextService();
  const records = { create: vi.fn().mockResolvedValue(undefined) };
  const writer = new EngagementOutboxWriter(context, records as never);
  const trusted = {
    tenant: { tenantId: 'tenant-a', source: 'access_token' as const },
    actor: {
      actorType: 'service' as const, actorId: 'integration-worker', tenantId: 'tenant-a',
      roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-1',
    },
  };
  return { records, writer, run: <T>(handler: () => T) => context.run(trusted, handler) };
}

describe('EngagementOutboxWriter', () => {
  it('发布脱敏履约事件和独立电子签意图', async () => {
    const value = harness();
    await value.run(async () => {
      await value.writer.append(engagement(), 'approved', SESSION as never);
      await value.writer.appendSignatureRequest(engagement(), SESSION as never);
    });
    expect(value.records.create).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(value.records.create.mock.calls);
    expect(serialized).toContain('engagement.signature.requested');
    expect(serialized).toContain('approvalEvidenceRef');
    expect(serialized).not.toMatch(/phone|email|bank|token|secret/iu);
  });

  it('拒绝非事务、租户漂移和错误签署状态', async () => {
    const value = harness();
    await value.run(async () => {
      await expect(value.writer.append(
        engagement(), 'approved', { inTransaction: () => false } as never,
      )).rejects.toThrow('ENGAGEMENT_TRANSACTION_REQUIRED');
      await expect(value.writer.append(
        { ...engagement(), tenantId: 'tenant-b' }, 'approved', SESSION as never,
      )).rejects.toThrow('ENGAGEMENT_OUTBOX_TENANT_MISMATCH');
      await expect(value.writer.appendSignatureRequest(
        { ...engagement(), status: 'active' }, SESSION as never,
      )).rejects.toThrow('ENGAGEMENT_SIGNATURE_REQUEST_STATE_INVALID');
    });
  });
});
