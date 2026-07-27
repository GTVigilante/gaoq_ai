import { describe, expect, it, vi } from 'vitest';
import { MarketingOutboxRelayService } from './marketing-outbox-relay.service.js';

interface SideEffectFixture {
  readonly eventId: string;
  readonly tenantId: string;
  readonly kind: 'lead_notification' | 'scheduled_publish';
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly channel: 'email' | 'feishu' | null;
  readonly dueAt: Date;
  readonly attempts: number;
}

const record: SideEffectFixture = {
  eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y',
  tenantId: 'tenant-001',
  kind: 'lead_notification',
  aggregateId: 'lead-001',
  aggregateVersion: 1,
  channel: 'email',
  dueAt: new Date('2026-07-27T00:00:00.000Z'),
  attempts: 0,
};

describe('Marketing Outbox Relay', () => {
  it('使用无 PII 稳定 Job ID 投递并原子标记完成', async () => {
    const records = modelReturning(record);
    const notifications = { add: vi.fn().mockResolvedValue(undefined) };
    const relay = new MarketingOutboxRelayService(
      records as never,
      notifications as never,
      { add: vi.fn() } as never,
    );

    await expect(relay.relayBatch('worker-001')).resolves.toBe(1);
    expect(notifications.add).toHaveBeenCalledWith(
      'lead:email',
      { tenantId: 'tenant-001', leadId: 'lead-001', channel: 'email' },
      expect.objectContaining({
        jobId: `marketing-side-effect:${record.eventId}`,
        attempts: 6,
      }),
    );
    expect(JSON.stringify(notifications.add.mock.calls)).not.toContain('example.com');
    const dispatchedUpdate = records.updateOne.mock.calls[0]?.[1] as
      { readonly $set?: { readonly status?: string } } | undefined;
    expect(dispatchedUpdate?.$set?.status).toBe('dispatched');
  });

  it('队列不可用时释放锁并按可重放状态退避', async () => {
    const records = modelReturning(record);
    const relay = new MarketingOutboxRelayService(
      records as never,
      { add: vi.fn().mockRejectedValue(new Error('queue unavailable')) } as never,
      { add: vi.fn() } as never,
    );

    await expect(relay.relayBatch('worker-001')).resolves.toBe(0);
    const releasedUpdate = records.updateOne.mock.calls.at(-1)?.[1] as {
      readonly $set?: {
        readonly status?: string;
        readonly attempts?: number;
        readonly lastErrorCode?: string;
        readonly lockedBy?: string | null;
      };
    } | undefined;
    expect(releasedUpdate?.$set).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'MARKETING_OUTBOX_ENQUEUE_FAILED',
      lockedBy: null,
    });
  });

  it('定时发布按 dueAt 生成延迟任务', async () => {
    const scheduled = {
      ...record,
      kind: 'scheduled_publish' as const,
      aggregateId: 'content-001',
      channel: null,
      dueAt: new Date(Date.now() + 60_000),
    };
    const records = modelReturning(scheduled);
    const automation = { add: vi.fn().mockResolvedValue(undefined) };
    const relay = new MarketingOutboxRelayService(
      records as never,
      { add: vi.fn() } as never,
      automation as never,
    );
    await relay.relayBatch('worker-001');
    expect(automation.add.mock.calls[0]?.[0]).toBe('publish:scheduled');
    expect(automation.add.mock.calls[0]?.[1]).toEqual({
      tenantId: 'tenant-001',
      contentId: 'content-001',
    });
    const options = automation.add.mock.calls[0]?.[2] as { readonly delay?: number } | undefined;
    expect(options?.delay).toBeGreaterThan(0);
  });
});

function modelReturning(value: SideEffectFixture) {
  const findOneAndUpdate = vi.fn()
    .mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(value) })
    .mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
  return {
    findOneAndUpdate,
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
}
