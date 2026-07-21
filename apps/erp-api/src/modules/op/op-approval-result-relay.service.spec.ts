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

function leanQuery<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

describe('OpApprovalResultRelayService', () => {
  it('只为 OP 来源审批终态在事务中建立最小结果投递并推进桥接版本', async () => {
    const event = {
      eventId: EVENT_ID, tenantId: 'tenant-001', aggregateId: INSTANCE_ID,
      aggregateVersion: 3, eventType: 'cn.gaoq.erp.approval_instance.decided.v1',
      envelope: {
        type: 'cn.gaoq.erp.approval_instance.decided.v1',
        time: '2026-07-22T08:00:00.000Z', tenantId: 'tenant-001',
        data: {
          tenantId: 'tenant-001', aggregateId: INSTANCE_ID, version: 3,
          resultingStatus: 'approved',
        },
      },
      attempts: 0,
    };
    const outbox = {
      findOneAndUpdate: vi.fn()
        .mockReturnValueOnce(leanQuery(event)).mockReturnValueOnce(leanQuery(null)),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const bridge = {
      tenantId: 'tenant-001', clientId: 'op-client-001',
      externalEventId: 'approval-event-001', sourceDocumentType: 'purchase_order',
      sourceDocumentId: 'po-001', approvalInstanceId: INSTANCE_ID, approvalVersion: 2,
    };
    const bridges = {
      findOne: vi.fn().mockReturnValue({
        session: () => ({ lean: () => ({ exec: () => Promise.resolve(bridge) }) }),
      }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const deliveries = { updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }) };
    const session = {
      withTransaction: vi.fn(async (callback: () => Promise<void>) => callback()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    const service = new OpApprovalResultRelayService(
      { startSession: vi.fn().mockResolvedValue(session) } as unknown as Connection,
      outbox as unknown as Model<OutboxDocument>,
      bridges as unknown as Model<OpApprovalBridgeDocument>,
      deliveries as unknown as Model<OpApprovalResultDeliveryDocument>,
    );
    await expect(service.relayBatch('worker-001', 2)).resolves.toBe(1);
    expect(deliveries.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $setOnInsert: {
        eventId: EVENT_ID, result: 'approved', approvalVersion: 3,
        status: 'pending', operatorRetryCount: 0,
      },
    });
    expect(JSON.stringify(deliveries.updateOne.mock.calls[0])).not.toMatch(/formData|payload/iu);
    expect(bridges.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { approvalStatus: 'approved', approvalVersion: 3 },
    });
    expect(outbox.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'dispatched' },
    });
  });
});
