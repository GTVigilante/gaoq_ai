import type { Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxDocument } from '../org/persistence/outbox.schema.js';
import { OpApprovalResultRelayService } from './op-approval-result-relay.service.js';
import type {
  OpApprovalBridgeDocument,
  OpApprovalResultDeliveryDocument,
} from './persistence/op.schemas.js';

const EVENT_ID = '01K00000000000000000000003';
const INSTANCE_ID = '01K00000000000000000000002';
const OCCURRED_AT = new Date('2026-07-22T08:00:00.000Z');

type EventFixture = {
  readonly eventId: string;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly envelope: Record<string, unknown>;
  readonly attempts: number;
};

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function sessionQuery<T>(value: T) {
  return {
    session: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
  };
}

function eventFixture(overrides: Partial<EventFixture> = {}): EventFixture {
  const eventType = overrides.eventType ??
    'cn.gaoq.erp.approval_instance.decided.v1';
  return {
    eventId: EVENT_ID,
    tenantId: 'tenant-001',
    aggregateId: INSTANCE_ID,
    aggregateVersion: 3,
    eventType,
    envelope: {
      type: eventType,
      time: OCCURRED_AT.toISOString(),
      tenantId: 'tenant-001',
      data: {
        tenantId: 'tenant-001',
        aggregateId: INSTANCE_ID,
        version: 3,
        resultingStatus: 'approved',
      },
    },
    attempts: 0,
    ...overrides,
  };
}

function bridgeFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '01K00000000000000000000004',
    tenantId: 'tenant-001',
    clientId: 'op-client-001',
    externalEventId: 'approval-event-001',
    sourceDocumentType: 'purchase_order',
    sourceDocumentId: 'po-001',
    templateCode: 'PURCHASE',
    approvalInstanceId: INSTANCE_ID,
    payloadHash: 'a'.repeat(43),
    approvalStatus: 'running' as const,
    approvalVersion: 2,
    completedAt: null,
    ...overrides,
  };
}

function deliveryFixture(
  event = eventFixture(),
  bridge = bridgeFixture(),
  overrides: Record<string, unknown> = {},
) {
  const data = event.envelope.data as { resultingStatus?: string } | undefined;
  const result = event.eventType.endsWith('.withdrawn.v1')
    ? 'withdrawn'
    : data?.resultingStatus;
  return {
    eventId: event.eventId,
    tenantId: bridge.tenantId,
    clientId: bridge.clientId,
    externalEventId: bridge.externalEventId,
    sourceDocumentType: bridge.sourceDocumentType,
    sourceDocumentId: bridge.sourceDocumentId,
    approvalInstanceId: bridge.approvalInstanceId,
    approvalVersion: event.aggregateVersion,
    result,
    occurredAt: OCCURRED_AT,
    status: 'pending',
    attempts: 0,
    operatorRetryCount: 0,
    nextAttemptAt: OCCURRED_AT,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    succeededAt: null,
    ...overrides,
  };
}

function fixture(input: {
  readonly event?: EventFixture | null;
  readonly bridge?: ReturnType<typeof bridgeFixture> | null;
  readonly delivery?: ReturnType<typeof deliveryFixture> | null;
  readonly outboxUpdates?: readonly number[];
  readonly bridgeMatchedCount?: number;
} = {}) {
  const event = input.event === undefined ? eventFixture() : input.event;
  const bridge = input.bridge === undefined ? bridgeFixture() : input.bridge;
  const delivery = input.delivery === undefined && event !== null && bridge !== null
    ? deliveryFixture(event, bridge)
    : input.delivery ?? null;
  const outboxUpdateResults = [...(input.outboxUpdates ?? [1])];
  const outbox = {
    findOneAndUpdate: vi.fn().mockReturnValue(query(event)),
    updateOne: vi.fn().mockImplementation(() => Promise.resolve({
      matchedCount: outboxUpdateResults.shift() ?? 1,
    })),
  };
  const bridges = {
    findOne: vi.fn().mockReturnValue(sessionQuery(bridge)),
    updateOne: vi.fn().mockResolvedValue({
      matchedCount: input.bridgeMatchedCount ?? 1,
    }),
  };
  const deliveries = {
    findOneAndUpdate: vi.fn().mockReturnValue(query(delivery)),
  };
  const session = {
    withTransaction: vi.fn(async (callback: () => Promise<void>) => callback()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = { startSession: vi.fn().mockResolvedValue(session) };
  const service = new OpApprovalResultRelayService(
    connection as unknown as Connection,
    outbox as unknown as Model<OutboxDocument>,
    bridges as unknown as Model<OpApprovalBridgeDocument>,
    deliveries as unknown as Model<OpApprovalResultDeliveryDocument>,
  );
  return { service, event, bridge, delivery, outbox, bridges, deliveries, session, connection };
}

function releaseUpdate(store: ReturnType<typeof fixture>) {
  return store.outbox.updateOne.mock.calls.at(-1)?.[1] as {
    readonly $set: Record<string, unknown>;
  };
}

describe('OpApprovalResultRelayService', () => {
  it.each([
    ['', 1],
    ['worker with space', 1],
    ['worker-001', 0],
    ['worker-001', 101],
    ['worker-001', 1.5],
  ])('拒绝非法 Worker 或批量参数 %#', async (workerId, limit) => {
    const store = fixture();
    await expect(store.service.relayBatch(workerId, limit))
      .rejects.toThrow('OP 审批 relay 参数非法');
    expect(store.outbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('没有待处理事件时直接返回且不创建事务', async () => {
    const store = fixture({ event: null });
    await expect(store.service.relayBatch('worker-001')).resolves.toBe(0);
    expect(store.connection.startSession).not.toHaveBeenCalled();
  });

  it('按过期租约条件认领事件并在事务中建立最小结果投递', async () => {
    const store = fixture();
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);

    const claimFilter = store.outbox.findOneAndUpdate.mock.calls[0]?.[0] as {
      readonly aggregateType: string;
      readonly $or: readonly [
        { readonly status: string },
        { readonly status: string; readonly lockedAt: { readonly $lt: Date } },
      ];
    };
    expect(claimFilter).toMatchObject({
      aggregateType: 'approval.instance',
      $or: [
        { status: 'pending' },
        { status: 'dispatching' },
      ],
    });
    expect(claimFilter.$or[1].lockedAt.$lt).toBeInstanceOf(Date);
    expect(store.deliveries.findOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
      $setOnInsert: {
        eventId: EVENT_ID,
        result: 'approved',
        approvalVersion: 3,
        status: 'pending',
        operatorRetryCount: 0,
      },
    });
    expect(JSON.stringify(store.deliveries.findOneAndUpdate.mock.calls[0]))
      .not.toMatch(/formData|payload/iu);
    expect(store.bridges.updateOne.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-001',
      approvalInstanceId: INSTANCE_ID,
      approvalStatus: 'running',
      approvalVersion: 2,
    });
    expect(store.outbox.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'dispatched', lastErrorCode: null },
    });
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it.each([
    ['rejected', 'cn.gaoq.erp.approval_instance.decided.v1'],
    ['withdrawn', 'cn.gaoq.erp.approval_instance.withdrawn.v1'],
  ])('支持 %s 终态', async (result, eventType) => {
    const base = eventFixture({ eventType });
    const event = eventType.endsWith('.withdrawn.v1')
      ? {
          ...base,
          envelope: {
            ...base.envelope,
            data: {
              tenantId: 'tenant-001',
              aggregateId: INSTANCE_ID,
              version: 3,
            },
          },
        }
      : {
          ...base,
          envelope: {
            ...base.envelope,
            data: {
              tenantId: 'tenant-001',
              aggregateId: INSTANCE_ID,
              version: 3,
              resultingStatus: result,
            },
          },
        };
    const bridge = bridgeFixture();
    const store = fixture({
      event,
      bridge,
      delivery: deliveryFixture(event, bridge, { result }),
    });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.bridges.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { approvalStatus: result, approvalVersion: 3 },
    });
  });

  it.each([
    ['非审批事件', eventFixture({ eventType: 'cn.gaoq.erp.org_employee.updated.v1' })],
    ['非终态审批事件', eventFixture({
      eventType: 'cn.gaoq.erp.approval_instance.submitted.v1',
    })],
    ['仍在运行的决定事件', {
      ...eventFixture(),
      envelope: {
        ...eventFixture().envelope,
        data: {
          tenantId: 'tenant-001',
          aggregateId: INSTANCE_ID,
          version: 3,
          resultingStatus: 'running',
        },
      },
    }],
  ])('%s 只完成本消费者状态，不创建 OP 投递', async (_name, event) => {
    const store = fixture({ event });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.bridges.findOne).not.toHaveBeenCalled();
    expect(store.deliveries.findOneAndUpdate).not.toHaveBeenCalled();
    expect(store.outbox.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'dispatched' },
    });
  });

  it('非 OP 来源审批终态不会创建结果投递', async () => {
    const store = fixture({ bridge: null, delivery: null });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.deliveries.findOneAndUpdate).not.toHaveBeenCalled();
    expect(store.bridges.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    ['信封 type', (event: EventFixture) => ({
      ...event,
      envelope: {
        ...event.envelope,
        type: 'cn.gaoq.erp.approval_instance.withdrawn.v1',
      },
    })],
    ['顶层租户', (event: EventFixture) => ({
      ...event,
      envelope: { ...event.envelope, tenantId: 'tenant-evil' },
    })],
    ['数据租户', (event: EventFixture) => ({
      ...event,
      envelope: {
        ...event.envelope,
        data: { ...(event.envelope.data as object), tenantId: 'tenant-evil' },
      },
    })],
    ['聚合标识', (event: EventFixture) => ({
      ...event,
      envelope: {
        ...event.envelope,
        data: { ...(event.envelope.data as object), aggregateId: 'other-instance' },
      },
    })],
    ['聚合版本', (event: EventFixture) => ({
      ...event,
      envelope: {
        ...event.envelope,
        data: { ...(event.envelope.data as object), version: 4 },
      },
    })],
  ])('%s 与 Outbox 元数据不一致时失败关闭', async (_name, mutate) => {
    const store = fixture({ event: mutate(eventFixture()) });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.deliveries.findOneAndUpdate).not.toHaveBeenCalled();
    expect(releaseUpdate(store).$set).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'OP_APPROVAL_RELAY_FAILED',
    });
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('非法终态信封按失败事件释放租约', async () => {
    const event = eventFixture({ envelope: { type: 'invalid' } });
    const store = fixture({ event });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(releaseUpdate(store).$set).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
  });

  it('相同桥接终态与版本允许幂等恢复缺失投递', async () => {
    const bridge = bridgeFixture({ approvalStatus: 'approved', approvalVersion: 3 });
    const event = eventFixture();
    const store = fixture({
      event,
      bridge,
      delivery: deliveryFixture(event, bridge),
    });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.deliveries.findOneAndUpdate).toHaveBeenCalledOnce();
  });

  it.each([
    ['运行桥版本不再落后', { approvalStatus: 'running', approvalVersion: 3 }],
    ['运行桥版本超前', { approvalStatus: 'running', approvalVersion: 4 }],
    ['终态结果冲突', { approvalStatus: 'rejected', approvalVersion: 3 }],
    ['终态版本冲突', { approvalStatus: 'approved', approvalVersion: 2 }],
    ['桥仍在预占阶段', { approvalStatus: 'processing', approvalVersion: 0 }],
  ])('%s 时禁止创建陈旧投递', async (_name, overrides) => {
    const store = fixture({ bridge: bridgeFixture(overrides) });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.deliveries.findOneAndUpdate).not.toHaveBeenCalled();
    expect(releaseUpdate(store).$set).toMatchObject({
      status: 'pending',
      lastErrorCode: 'OP_APPROVAL_RELAY_FAILED',
    });
  });

  it('桥接乐观锁丢失时事务失败并释放 Outbox 租约', async () => {
    const store = fixture({ bridgeMatchedCount: 0 });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.bridges.updateOne).toHaveBeenCalledOnce();
    expect(releaseUpdate(store).$set).toMatchObject({ status: 'pending' });
  });

  it.each([
    ['空记录', () => null],
    ['tenantId', (delivery: ReturnType<typeof deliveryFixture>) => ({
      ...delivery, tenantId: 'tenant-evil',
    })],
    ['clientId', (delivery: ReturnType<typeof deliveryFixture>) => ({
      ...delivery, clientId: 'other-client',
    })],
    ['externalEventId', (delivery: ReturnType<typeof deliveryFixture>) => ({
      ...delivery, externalEventId: 'other-event',
    })],
    ['sourceDocumentType', (delivery: ReturnType<typeof deliveryFixture>) => ({
      ...delivery, sourceDocumentType: 'expense',
    })],
    ['sourceDocumentId', (delivery: ReturnType<typeof deliveryFixture>) => ({
      ...delivery, sourceDocumentId: 'po-other',
    })],
    ['approvalInstanceId', (delivery: ReturnType<typeof deliveryFixture>) => ({
      ...delivery, approvalInstanceId: '01K00000000000000000000009',
    })],
    ['approvalVersion', (delivery: ReturnType<typeof deliveryFixture>) => ({
      ...delivery, approvalVersion: 4,
    })],
    ['result', (delivery: ReturnType<typeof deliveryFixture>) => ({
      ...delivery, result: 'rejected',
    })],
    ['occurredAt', (delivery: ReturnType<typeof deliveryFixture>) => ({
      ...delivery, occurredAt: new Date('2026-07-22T08:00:01.000Z'),
    })],
  ])('已存在投递的 %s 不一致时失败关闭', async (_name, mutate) => {
    const current = deliveryFixture();
    const store = fixture({
      delivery: mutate(current),
    });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.bridges.updateOne).not.toHaveBeenCalled();
    expect(releaseUpdate(store).$set).toMatchObject({ status: 'pending' });
  });

  it('Outbox 完成租约丢失时回退到可靠重试', async () => {
    const store = fixture({ outboxUpdates: [0, 1] });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.outbox.updateOne).toHaveBeenCalledTimes(2);
    expect(releaseUpdate(store).$set).toMatchObject({ status: 'pending' });
  });

  it('第六次 Relay 失败进入 dead 终态', async () => {
    const store = fixture({
      event: eventFixture({ attempts: 5, envelope: { type: 'invalid' } }),
    });
    await expect(store.service.relayBatch('worker-001', 1)).resolves.toBe(0);
    expect(releaseUpdate(store).$set).toMatchObject({
      status: 'dead',
      attempts: 6,
      lastErrorCode: 'OP_APPROVAL_RELAY_FAILED',
    });
  });

  it('释放失败事件时丢失租约必须显式报错', async () => {
    const store = fixture({
      event: eventFixture({ envelope: { type: 'invalid' } }),
      outboxUpdates: [0],
    });
    await expect(store.service.relayBatch('worker-001', 1))
      .rejects.toThrow('OP_APPROVAL_OUTBOX_LEASE_LOST');
  });
});
