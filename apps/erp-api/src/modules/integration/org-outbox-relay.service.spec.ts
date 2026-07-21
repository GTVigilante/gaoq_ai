import type { ClientSession, Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxDocument } from '../org/persistence/outbox.schema.js';
import type { OrgDeliveryDocument } from './org-delivery.schemas.js';
import { OrgOutboxRelayService } from './org-outbox-relay.service.js';

const EVENT_ID = '01K00000000000000000000000';

const event = {
  eventId: EVENT_ID,
  tenantId: 'tenant-001',
  aggregateType: 'org.department',
  aggregateId: 'department-001',
  aggregateVersion: 2,
  eventType: 'cn.gaoq.erp.department.updated.v1',
  envelope: { data: { aggregateId: 'department-001', version: 2, name: '财务部' } },
  attempts: 0,
};

function query(result: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(result) }) };
}

function assemble(claimed: unknown = event) {
  const findOneAndUpdate = vi.fn<(filter: unknown, update: unknown, options: unknown) => unknown>()
    .mockReturnValueOnce(query(claimed))
    .mockReturnValue(query(null));
  const outboxUpdateOne = vi.fn<
    (filter: unknown, update: unknown, options?: unknown) => Promise<{ matchedCount: number }>
  >().mockResolvedValue({ matchedCount: 1 });
  const deliveryUpdateOne = vi.fn<
    (filter: unknown, update: unknown, options?: unknown) => Promise<unknown>
  >().mockResolvedValue({ matchedCount: 0, upsertedCount: 1 });
  const endSession = vi.fn().mockResolvedValue(undefined);
  const session = {
    withTransaction: vi.fn((operation: () => Promise<unknown>) => operation()),
    endSession,
  } as unknown as ClientSession;
  const connection = {
    startSession: vi.fn().mockResolvedValue(session),
  } as unknown as Connection;
  const service = new OrgOutboxRelayService(
    connection,
    { findOneAndUpdate, updateOne: outboxUpdateOne } as unknown as Model<OutboxDocument>,
    { updateOne: deliveryUpdateOne } as unknown as Model<OrgDeliveryDocument>,
  );
  return {
    service,
    session,
    endSession,
    findOneAndUpdate,
    outboxUpdateOne,
    deliveryUpdateOne,
  };
}

describe('OrgOutboxRelayService', () => {
  it('同一事务扇出钉钉和飞书，并在两条任务建立后标记 Outbox dispatched', async () => {
    const store = assemble();

    const count = await store.service.relayBatch('worker-001', 10);

    expect(count).toBe(1);
    expect(store.deliveryUpdateOne).toHaveBeenCalledTimes(2);
    expect(store.deliveryUpdateOne.mock.calls.map((call) => call[0])).toEqual([
      { eventId: EVENT_ID, channel: 'dingtalk' },
      { eventId: EVENT_ID, channel: 'feishu' },
    ]);
    for (const call of store.deliveryUpdateOne.mock.calls) {
      expect(call[2]).toMatchObject({
        upsert: true,
        session: store.session,
        runValidators: true,
        setDefaultsOnInsert: true,
      });
    }
    const dispatched = store.outboxUpdateOne.mock.calls[0];
    expect(dispatched?.[0]).toEqual({
      eventId: EVENT_ID,
      status: 'dispatching',
      lockedBy: 'worker-001',
    });
    expect(dispatched?.[1]).toMatchObject({ $set: { status: 'dispatched' } });
    expect(dispatched?.[2]).toMatchObject({ session: store.session });
    expect(store.endSession).toHaveBeenCalledOnce();
  });

  it('抢占仅扫描组织事件，并按部门类型、创建时间排序', async () => {
    const store = assemble(null);

    await store.service.relayBatch('worker-001', 1);

    const claim = store.findOneAndUpdate.mock.calls[0];
    const filter = claim?.[0];
    const options = claim?.[2];
    expect(filter).toMatchObject({
      aggregateType: {
        $in: ['org.department', 'org.employee', 'org.position', 'org.job_level'],
      },
    });
    const nextAttemptAt = (filter as { nextAttemptAt?: { $lte?: unknown } }).nextAttemptAt?.$lte;
    expect(nextAttemptAt).toBeInstanceOf(Date);
    expect(options).toMatchObject({ sort: { aggregateType: 1, createdAt: 1 } });
  });

  it('事务失败时释放抢占并按第 1 档退避，不把半成品标记成功', async () => {
    const store = assemble();
    store.deliveryUpdateOne.mockRejectedValueOnce(new Error('mongo unavailable'));

    const count = await store.service.relayBatch('worker-001', 1);

    expect(count).toBe(0);
    const release = store.outboxUpdateOne.mock.calls.at(-1);
    expect(release?.[0]).toEqual({
      eventId: EVENT_ID,
      status: 'dispatching',
      lockedBy: 'worker-001',
    });
    const releasedSet = (release?.[1] as { $set?: Record<string, unknown> } | undefined)?.$set;
    expect(releasedSet).toMatchObject({
      status: 'pending',
      attempts: 1,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: 'ORG_RELAY_TRANSACTION_FAILED',
    });
    expect(releasedSet?.['nextAttemptAt']).toBeInstanceOf(Date);
  });

  it('拒绝非法 workerId 与过大批次，避免无界扫描', async () => {
    const store = assemble(null);

    await expect(store.service.relayBatch('../worker', 1)).rejects.toThrow('workerId 非法');
    await expect(store.service.relayBatch('worker-001', 101)).rejects.toThrow('1..100');
    expect(store.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('岗位与职级事件被明确确认但不生成不受支持的平台投递，避免 Outbox 永久堆积', async () => {
    const store = assemble({
      ...event,
      aggregateType: 'org.position',
      aggregateId: 'position-001',
      eventType: 'cn.gaoq.erp.position.created.v1',
    });

    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);

    expect(store.deliveryUpdateOne).not.toHaveBeenCalled();
    expect(store.outboxUpdateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'dispatched' },
    });
  });
});
