import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OutboxDocument } from '../../org/persistence/outbox.schema.js';
import {
  type OpOperatingSummaryEvent,
  OpOutboxWriter,
} from './op-outbox.writer.js';

const AGGREGATE_ID = '01K00000000000000000000001';
const session = Object.freeze({ id: 'session-001' }) as unknown as ClientSession;

const validEvent = (
  overrides: Partial<OpOperatingSummaryEvent> = {},
): OpOperatingSummaryEvent => ({
  tenantId: 'tenant-001',
  aggregateId: AGGREGATE_ID,
  version: 1,
  occurredAt: '2026-07-22T08:00:00.000Z',
  data: {
    summaryDate: '2026-07-22',
    revision: 1,
    currency: 'CNY',
    gmvMinor: 123_456,
    paidOrderCount: 12,
    refundMinor: 500,
    refundOrderCount: 1,
    activeCustomerCount: 8,
    payloadHash: 'p'.repeat(43),
  },
  ...overrides,
});

function fixture() {
  const context = new TenantContextService();
  const records = { create: vi.fn().mockResolvedValue(undefined) };
  const writer = new OpOutboxWriter(
    context,
    records as unknown as Model<OutboxDocument>,
  );
  return { context, records, writer };
}

function inTenant<T>(
  context: TenantContextService,
  operation: () => Promise<T>,
  tenantId = 'tenant-001',
): Promise<T> {
  return context.run({
    tenant: { tenantId, source: 'service_identity' },
    actor: {
      actorType: 'system_job',
      actorId: 'system:op-operating-summary',
      tenantId,
      roleCodes: ['INTEGRATION_WORKER'],
      scopes: ['erp:op:operating_summary:ingest'],
      departmentIds: [],
      traceId: 'trace-op-outbox-001',
    },
  }, operation);
}

describe('OpOutboxWriter', () => {
  it('在同一 Session 追加固定 CloudEvent，不包含 Inbox 或原始正文', async () => {
    const store = fixture();
    await inTenant(
      store.context,
      () => store.writer.appendOperatingSummary(validEvent(), session),
    );

    const createCall = store.records.create.mock.calls[0] as unknown as [
      readonly Readonly<Record<string, unknown>>[],
      Readonly<Record<string, unknown>>,
    ];
    const created = createCall[0][0];
    expect(created).toMatchObject({
      tenantId: 'tenant-001',
      aggregateType: 'op.operating_summary',
      aggregateId: AGGREGATE_ID,
      aggregateVersion: 1,
      eventType: 'cn.gaoq.erp.op.operating_summary.published.v1',
      status: 'pending',
      attempts: 0,
    });
    expect(created?.['envelope']).toMatchObject({
      specversion: '1.0',
      source: '//gaoq-erp/op-module',
      type: 'cn.gaoq.erp.op.operating_summary.published.v1',
      tenantId: 'tenant-001',
      traceId: 'trace-op-outbox-001',
      schemaVersion: '1',
      data: {
        tenantId: 'tenant-001',
        ...validEvent().data,
      },
    });
    expect(createCall[1]).toEqual({ session });
    const serialized = JSON.stringify(store.records.create.mock.calls[0]?.[0]);
    expect(serialized).not.toMatch(/rawBody|payloadCiphertext|nonce|signature|token/ui);
  });

  it('事件租户与可信上下文不一致时拒绝写入', async () => {
    const store = fixture();
    await expect(inTenant(
      store.context,
      () => store.writer.appendOperatingSummary(
        validEvent({ tenantId: 'tenant-evil' }),
        session,
      ),
    )).rejects.toThrow('OP_OUTBOX_CROSS_TENANT_DENIED');
    expect(store.records.create).not.toHaveBeenCalled();
  });

  it.each([
    ['聚合 ID 非 ULID', { aggregateId: 'bad' }],
    ['版本非整数', { version: 1.5 }],
    ['版本非正数', { version: 0 }],
    ['版本与修订不一致', { version: 2 }],
    ['事件时间非法', { occurredAt: 'not-a-date' }],
    ['载荷摘要非法', { data: { ...validEvent().data, payloadHash: 'bad' } }],
    ['币种非法', { data: { ...validEvent().data, currency: 'USD' } }],
    ['日期格式非法', { data: { ...validEvent().data, summaryDate: '2026-7-22' } }],
    ['日期不存在', { data: { ...validEvent().data, summaryDate: '2026-02-30' } }],
    ['修订非整数', { data: { ...validEvent().data, revision: 1.5 } }],
    ['修订非正数', { data: { ...validEvent().data, revision: 0 }, version: 0 }],
    ['金额为负数', { data: { ...validEvent().data, gmvMinor: -1 } }],
    ['数量为浮点', { data: { ...validEvent().data, paidOrderCount: 1.5 } }],
    ['出现白名单外字段', { data: { ...validEvent().data, rawBody: 'forbidden' } }],
  ])('%s时拒绝创建 Outbox', async (_name, mutation) => {
    const store = fixture();
    await expect(inTenant(
      store.context,
      () => store.writer.appendOperatingSummary(
        { ...validEvent(), ...mutation } as OpOperatingSummaryEvent,
        session,
      ),
    )).rejects.toThrow('OP_OPERATING_SUMMARY_OUTBOX_DATA_INVALID');
    expect(store.records.create).not.toHaveBeenCalled();
  });

  it('可信上下文和事件租户即使一致，非法租户格式仍在事件边界失败关闭', async () => {
    const store = fixture();
    await expect(inTenant(
      store.context,
      () => store.writer.appendOperatingSummary(
        validEvent({ tenantId: 'contains space' }),
        session,
      ),
      'contains space',
    )).rejects.toThrow('OP_OPERATING_SUMMARY_OUTBOX_DATA_INVALID');
    expect(store.records.create).not.toHaveBeenCalled();
  });

  it('Outbox 存储故障保持原始错误', async () => {
    const store = fixture();
    const failure = new Error('outbox unavailable');
    store.records.create.mockRejectedValueOnce(failure);

    await expect(inTenant(
      store.context,
      () => store.writer.appendOperatingSummary(validEvent(), session),
    )).rejects.toBe(failure);
  });
});
