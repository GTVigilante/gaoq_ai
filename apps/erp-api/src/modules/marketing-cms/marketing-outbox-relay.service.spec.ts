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
  eventId: '01J8ZQK7V0A2M4N6P8R0T2W4Y0',
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
      {
        sideEffectEventId: record.eventId,
        tenantId: 'tenant-001',
        leadId: 'lead-001',
        aggregateVersion: 1,
        channel: 'email',
      },
      expect.objectContaining({
        jobId: `marketing-side-effect:${record.eventId}`,
        attempts: 6,
      }),
    );
    expect(JSON.stringify(notifications.add.mock.calls)).not.toContain('example.com');
    const dispatchedUpdate = records.updateOne.mock.calls[0]?.[1] as
      { readonly $set?: { readonly status?: string } } | undefined;
    expect(dispatchedUpdate?.$set?.status).toBe('dispatched');
    expect(records.updateOne.mock.calls[0]?.[0]).toEqual({
      eventId: record.eventId,
      status: 'dispatching',
      lockedBy: 'worker-001',
      attempts: 0,
    });
    const claimFilter = records.findOneAndUpdate.mock.calls[0]?.[0] as {
      readonly nextAttemptAt?: { readonly $lte?: unknown };
      readonly $or?: readonly [
        { readonly status?: string },
        {
          readonly status?: string;
          readonly lockedAt?: { readonly $lt?: unknown };
        },
      ];
    } | undefined;
    expect(claimFilter?.nextAttemptAt?.$lte).toBeInstanceOf(Date);
    expect(claimFilter?.$or?.[0]).toEqual({ status: 'pending' });
    expect(claimFilter?.$or?.[1]?.status).toBe('dispatching');
    expect(claimFilter?.$or?.[1]?.lockedAt?.$lt).toBeInstanceOf(Date);
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
    expect(records.updateOne.mock.calls.at(-1)?.[0]).toEqual({
      eventId: record.eventId,
      status: 'dispatching',
      lockedBy: 'worker-001',
      attempts: 0,
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
      sideEffectEventId: record.eventId,
      tenantId: 'tenant-001',
      contentId: 'content-001',
      aggregateVersion: 1,
    });
    const options = automation.add.mock.calls[0]?.[2] as { readonly delay?: number } | undefined;
    expect(options?.delay).toBeGreaterThan(0);
  });

  it('已到期的定时发布任务使用零延迟，通知渠道错误时拒绝入队', async () => {
    const scheduled = {
      ...record,
      kind: 'scheduled_publish' as const,
      aggregateId: 'content-001',
      channel: null,
      dueAt: new Date(Date.now() - 60_000),
    };
    const automation = { add: vi.fn().mockResolvedValue(undefined) };
    const relay = new MarketingOutboxRelayService(
      modelReturning(scheduled) as never,
      { add: vi.fn() } as never,
      automation as never,
    );
    await expect(relay.relayBatch('worker-001')).resolves.toBe(1);
    expect(automation.add.mock.calls[0]?.[2]).toMatchObject({ delay: 0 });

    const notifications = { add: vi.fn() };
    const invalidRecords = modelReturning({ ...record, channel: null });
    const invalidRelay = new MarketingOutboxRelayService(
      invalidRecords as never,
      notifications as never,
      { add: vi.fn() } as never,
    );
    await expect(invalidRelay.relayBatch('worker-002')).resolves.toBe(0);
    expect(notifications.add).not.toHaveBeenCalled();
    expect(invalidRecords.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'dead',
        lastErrorCode: 'MARKETING_OUTBOX_RECORD_INVALID',
      },
    });
  });

  it('连续入队失败达到上限时进入 dead 并保留无敏感错误码', async () => {
    const records = modelReturning({ ...record, attempts: 7 });
    const relay = new MarketingOutboxRelayService(
      records as never,
      { add: vi.fn().mockRejectedValue(new Error('upstream details')) } as never,
      { add: vi.fn() } as never,
    );
    await expect(relay.relayBatch('worker-001')).resolves.toBe(0);
    const update = records.updateOne.mock.calls.at(-1)?.[1] as {
      readonly $set?: Record<string, unknown>;
    } | undefined;
    expect(update?.$set).toMatchObject({
      status: 'dead',
      attempts: 8,
      lockedBy: null,
      lastErrorCode: 'MARKETING_OUTBOX_ENQUEUE_FAILED',
    });
    expect(update?.$set?.completedAt).toBeInstanceOf(Date);
  });

  it.each([
    [{ ...record, eventId: 'invalid' }],
    [{ ...record, tenantId: ' tenant-001' }],
    [{ ...record, aggregateId: '' }],
    [{ ...record, aggregateVersion: 0 }],
    [{ ...record, aggregateVersion: 1.5 }],
    [{ ...record, attempts: -1 }],
    [{ ...record, attempts: 1.5 }],
    [{ ...record, attempts: 8 }],
    [{ ...record, dueAt: new Date(Number.NaN) }],
    [{ ...record, kind: 'unknown', channel: null }],
    [{ ...record, kind: 'scheduled_publish', channel: 'email' }],
  ])('受损 Outbox 记录不进入外部队列 %#', async (candidate) => {
    const records = modelReturning(candidate as never);
    const notifications = { add: vi.fn() };
    const automation = { add: vi.fn() };
    const relay = new MarketingOutboxRelayService(
      records as never,
      notifications as never,
      automation as never,
    );
    await expect(relay.relayBatch('worker-corrupt', 1)).resolves.toBe(0);
    expect(notifications.add).not.toHaveBeenCalled();
    expect(automation.add).not.toHaveBeenCalled();
    expect(records.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'dead',
        lastErrorCode: 'MARKETING_OUTBOX_RECORD_INVALID',
      },
    });
  });

  it('认领与终态存储异常使用稳定错误码，入队后状态写失败可安全释放', async () => {
    const claimFailure = new MarketingOutboxRelayService(
      modelReturning(record, { claimError: new Error('mongodb details') }) as never,
      { add: vi.fn() } as never,
      { add: vi.fn() } as never,
    );
    await expect(claimFailure.relayBatch('worker-001')).rejects.toThrow(
      'MARKETING_OUTBOX_STORE_UNAVAILABLE',
    );

    const records = modelReturning(record, {
      updateSequence: [
        new Error('mongodb details'),
        { matchedCount: 1 },
      ],
    });
    const relay = new MarketingOutboxRelayService(
      records as never,
      { add: vi.fn().mockResolvedValue(undefined) } as never,
      { add: vi.fn() } as never,
    );
    await expect(relay.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(records.updateOne.mock.calls[1]?.[1]).toMatchObject({
      $set: { lastErrorCode: 'MARKETING_OUTBOX_STORE_UNAVAILABLE' },
    });
  });

  it('入队成功后认领丢失立即失败，不再改写其他 Worker 状态', async () => {
    const records = modelReturning(record, {
      updateSequence: [{ matchedCount: 0 }],
    });
    const relay = new MarketingOutboxRelayService(
      records as never,
      { add: vi.fn().mockResolvedValue(undefined) } as never,
      { add: vi.fn() } as never,
    );
    await expect(relay.relayBatch('worker-001', 1)).rejects.toThrow(
      'MARKETING_OUTBOX_CLAIM_LOST',
    );
    expect(records.updateOne).toHaveBeenCalledTimes(1);
  });

  it('失败释放丢失租约或存储不可用时失败关闭', async () => {
    const leaseLost = modelReturning(record, {
      updateSequence: [{ matchedCount: 0 }],
    });
    const leaseRelay = new MarketingOutboxRelayService(
      leaseLost as never,
      { add: vi.fn().mockRejectedValue(new Error('queue unavailable')) } as never,
      { add: vi.fn() } as never,
    );
    await expect(leaseRelay.relayBatch('worker-001', 1)).rejects.toThrow(
      'MARKETING_OUTBOX_RELEASE_LEASE_LOST',
    );

    const unavailable = modelReturning(record, {
      updateSequence: [new Error('mongodb details')],
    });
    const unavailableRelay = new MarketingOutboxRelayService(
      unavailable as never,
      { add: vi.fn().mockRejectedValue(new Error('queue unavailable')) } as never,
      { add: vi.fn() } as never,
    );
    await expect(unavailableRelay.relayBatch('worker-001', 1)).rejects.toThrow(
      'MARKETING_OUTBOX_STORE_UNAVAILABLE',
    );
  });

  it('保留受控队列错误码并把其他异常归一化', async () => {
    const controlled = modelReturning(record);
    const relay = new MarketingOutboxRelayService(
      controlled as never,
      {
        add: vi.fn().mockRejectedValue(new Error('MARKETING_QUEUE_RATE_LIMITED')),
      } as never,
      { add: vi.fn() } as never,
    );
    await expect(relay.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(controlled.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { lastErrorCode: 'MARKETING_QUEUE_RATE_LIMITED' },
    });
  });

  it.each([
    ['invalid worker', 1, 'MARKETING_OUTBOX_WORKER_INVALID'],
    ['', 1, 'MARKETING_OUTBOX_WORKER_INVALID'],
    ['w'.repeat(129), 1, 'MARKETING_OUTBOX_WORKER_INVALID'],
    ['worker-001', 0, 'MARKETING_OUTBOX_LIMIT_INVALID'],
    ['worker-001', 201, 'MARKETING_OUTBOX_LIMIT_INVALID'],
    ['worker-001', 1.5, 'MARKETING_OUTBOX_LIMIT_INVALID'],
  ])('拒绝非法 Worker 扫描参数 %#', async (workerId, limit, code) => {
    const records = modelReturning(record);
    const relay = new MarketingOutboxRelayService(
      records as never,
      { add: vi.fn() } as never,
      { add: vi.fn() } as never,
    );
    await expect(relay.relayBatch(workerId, limit)).rejects.toThrow(code);
    expect(records.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

interface ModelOptions {
  readonly claimError?: Error;
  readonly updateSequence?: readonly (
    | { readonly matchedCount: number }
    | Error
  )[];
}

function modelReturning(
  value: SideEffectFixture,
  options: ModelOptions = {},
) {
  const findOneAndUpdate = options.claimError === undefined
    ? vi.fn()
      .mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(value) })
      .mockReturnValue({ exec: vi.fn().mockResolvedValue(null) })
    : vi.fn().mockReturnValue({
      exec: vi.fn().mockRejectedValue(options.claimError),
    });
  const updateSequence = [...(options.updateSequence ?? [{ matchedCount: 1 }])];
  return {
    findOneAndUpdate,
    updateOne: vi.fn().mockImplementation(() => {
      const outcome = updateSequence.shift() ?? { matchedCount: 1 };
      return outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome);
    }),
  };
}
