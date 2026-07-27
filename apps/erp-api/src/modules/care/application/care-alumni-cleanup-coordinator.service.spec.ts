import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { CareAlumniCleanupCoordinatorService } from './care-alumni-cleanup-coordinator.service.js';

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C6';
const CONSENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C4';
const event = {
  eventId: EVENT_ID,
  tenantId: 'tenant-001',
  aggregateType: 'care',
  aggregateId: CONSENT_ID,
  aggregateVersion: 2,
  eventType: 'cn.gaoq.erp.care.alumni_consent.withdrawn.v1',
  envelope: {
    specversion: '1.0',
    id: EVENT_ID,
    source: '//gaoq-erp/care-module',
    tenantId: 'tenant-001',
    type: 'cn.gaoq.erp.care.alumni_consent.withdrawn.v1',
    subject: `tenant/tenant-001/care/${CONSENT_ID}`,
    time: '2026-07-27T00:00:00.000Z',
    datacontenttype: 'application/json',
    traceId: 'trace-001',
    idempotencyKey: `tenant-001:withdrawn:${CONSENT_ID}:2`,
    schemaVersion: '1',
    data: {
      tenantId: 'tenant-001',
      aggregateId: CONSENT_ID,
      version: 2,
      careCaseId: 'care-case-001',
      purpose: 'alumni_network',
      channels: ['email'],
      status: 'withdrawn',
      expiresAt: '2027-07-27T00:00:00.000Z',
    },
  },
  attempts: 0,
};
const target = {
  targetCode: 'crm',
  endpoint: 'https://privacy-crm.example.net',
  bearerToken: 'cleanup-token-distinct-at-least-32-characters',
  policyVersion: 'privacy-v1',
  signingKeyId: 'proof-key-v1',
  signingPublicKeyBase64: 'unused-in-coordinator-test',
  maxAttempts: 3,
  proofRetentionDays: 2_555,
};

function query<T>(value: T) {
  return {
    lean: () => ({ exec: () => Promise.resolve(value) }),
  };
}

describe('CareAlumniCleanupCoordinatorService', () => {
  it('只消费撤回/到期 Outbox，并原子扇出登记目标后用最小任务入队', async () => {
    const outbox = {
      findOneAndUpdate: vi.fn().mockReturnValue(query(event)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const tasks = {
      updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
      findOne: vi.fn(),
      aggregate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    };
    const session = {
      withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    const queue = { scheduleAlumniCleanup: vi.fn().mockResolvedValue(undefined) };
    const outboxWriter = { append: vi.fn().mockResolvedValue(undefined) };
    const metrics = {
      recordCareAlumniCleanup: vi.fn(),
      setCareAlumniCleanupBacklog: vi.fn(),
    };
    const service = new CareAlumniCleanupCoordinatorService(
      { startSession: vi.fn().mockResolvedValue(session) } as never,
      outbox as never,
      tasks as never,
      new TenantContextService(),
      {
        findById: vi.fn().mockResolvedValue({
          id: CONSENT_ID,
          tenantId: 'tenant-001',
          purpose: 'alumni_network',
          version: 2,
          status: 'withdrawn',
          withdrawnAt: '2026-07-27T00:00:00.000Z',
          expiredAt: null,
        }),
      } as never,
      { targets: vi.fn().mockReturnValue([target]) } as never,
      outboxWriter as never,
      queue as never,
      metrics as never,
    );
    await expect(service.relayBatch('worker-001', 1)).resolves.toBe(1);
    const updateCall = JSON.stringify(tasks.updateOne.mock.calls[0]);
    expect(updateCall).toContain(`"consentId":"${CONSENT_ID}"`);
    expect(updateCall).toContain('"consentVersion":2');
    expect(updateCall).toContain('"consentPurpose":"alumni_network"');
    expect(updateCall).toContain('"targetCode":"crm"');
    expect(updateCall).toContain('"policyVersion":"privacy-v1"');
    expect(updateCall).toContain('"$setOnInsert"');
    expect(updateCall).toContain('"upsert":true');
    expect(outboxWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.alumni_cleanup.scheduled' }),
      session,
    );
    const queued = JSON.stringify(queue.scheduleAlumniCleanup.mock.calls[0]?.[0]);
    expect(queued).toContain('"tenantId":"tenant-001"');
    expect(queued).toContain(`"consentId":"${CONSENT_ID}"`);
    expect(queued).toContain('"targetCode":"crm"');
    expect(queued).not.toMatch(
      /personId|consentEvidenceId|phone|emailAddress|proofObject/iu,
    );
  });
});
