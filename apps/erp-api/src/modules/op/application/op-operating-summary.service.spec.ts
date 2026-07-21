import type { Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OpOutboxWriter } from '../persistence/op-outbox.writer.js';
import type { OpOperatingSummaryDocument } from '../persistence/op.schemas.js';
import { OpOperatingSummaryService } from './op-operating-summary.service.js';

const envelope = {
  schemaVersion: '1.0' as const, type: 'operating.summary.published' as const,
  occurredAt: '2026-07-22T08:00:00.000Z',
  data: {
    summaryDate: '2026-07-22', revision: 1, currency: 'CNY' as const,
    metrics: {
      gmvMinor: 123_456, paidOrderCount: 12, refundMinor: 500,
      refundOrderCount: 1, activeCustomerCount: 8,
    },
  },
};

function fixture(latest: Record<string, unknown> | null = null) {
  const session = {
    withTransaction: vi.fn(async (callback: () => Promise<void>) => callback()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const findOne = vi.fn((filter: Record<string, unknown>) => {
    if ('externalEventId' in filter) {
      return { lean: () => ({ exec: () => Promise.resolve(null) }) };
    }
    return {
      sort: () => ({
        session: () => ({ lean: () => ({ exec: () => Promise.resolve(latest) }) }),
        lean: () => ({ exec: () => Promise.resolve(latest) }),
      }),
    };
  });
  const createdRecord = {
    id: '01K00000000000000000000003', tenantId: 'tenant-001',
    summaryDate: envelope.data.summaryDate, revision: envelope.data.revision,
    currency: 'CNY', ...envelope.data.metrics, clientId: 'op-client-001',
    externalEventId: 'event-20260722-001', inboxId: '01K00000000000000000000001',
    payloadHash: 'p'.repeat(43), occurredAt: new Date(envelope.occurredAt),
    receivedAt: new Date('2026-07-22T08:00:01.000Z'),
  };
  const summaries = {
    findOne,
    create: vi.fn().mockResolvedValue([{ toObject: () => createdRecord }]),
  };
  const connection = { startSession: vi.fn().mockResolvedValue(session) };
  const outbox = { appendOperatingSummary: vi.fn().mockResolvedValue(undefined) };
  const context = new TenantContextService();
  const service = new OpOperatingSummaryService(
    context, connection as unknown as Connection,
    summaries as unknown as Model<OpOperatingSummaryDocument>,
    outbox as unknown as OpOutboxWriter,
  );
  return { service, context, summaries, connection, outbox, session };
}

async function inTenant<T>(
  context: TenantContextService,
  callback: () => Promise<T>,
): Promise<T> {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: {
      actorType: 'system_job', actorId: 'system:op-test', tenantId: 'tenant-001',
      roleCodes: ['INTEGRATION_WORKER'], scopes: ['erp:op:operating_summary:ingest'],
      departmentIds: [], traceId: 'trace-op-001',
    },
  }, callback);
}

describe('OpOperatingSummaryService', () => {
  it('首版摘要与固定白名单事件在同一事务追加', async () => {
    const store = fixture();
    const result = await inTenant(store.context, () => store.service.apply({
      tenantId: 'tenant-001', clientId: 'op-client-001',
      externalEventId: 'event-20260722-001', inboxId: '01K00000000000000000000001',
      payloadHash: 'p'.repeat(43), receivedAt: new Date('2026-07-22T08:00:01.000Z'), envelope,
    }));
    expect(result).toMatchObject({ summaryDate: '2026-07-22', revision: 1 });
    expect(store.summaries.create).toHaveBeenCalledWith([
      expect.objectContaining({
        tenantId: 'tenant-001', summaryDate: '2026-07-22', revision: 1,
        gmvMinor: 123_456,
      }),
    ], { session: store.session });
    const outboxCall = store.outbox.appendOperatingSummary.mock.calls[0] as unknown as [
      { readonly tenantId: string; readonly version: number; readonly data: {
        readonly summaryDate: string; readonly payloadHash: string;
      } },
      unknown,
    ];
    expect(outboxCall[0]).toMatchObject({
      tenantId: 'tenant-001', version: 1,
      data: { summaryDate: '2026-07-22', payloadHash: 'p'.repeat(43) },
    });
    expect(outboxCall[1]).toBe(store.session);
  });

  it('拒绝跳号修订且不写摘要或事件', async () => {
    const store = fixture({ revision: 1 });
    await expect(inTenant(store.context, () => store.service.apply({
      tenantId: 'tenant-001', clientId: 'op-client-001',
      externalEventId: 'event-20260722-002', inboxId: '01K00000000000000000000002',
      payloadHash: 'q'.repeat(43), receivedAt: new Date(),
      envelope: { ...envelope, data: { ...envelope.data, revision: 3 } },
    }))).rejects.toMatchObject({
      response: { code: 'OP_OPERATING_SUMMARY_REVISION_INVALID' },
    });
    expect(store.summaries.create).not.toHaveBeenCalled();
    expect(store.outbox.appendOperatingSummary).not.toHaveBeenCalled();
  });
});
