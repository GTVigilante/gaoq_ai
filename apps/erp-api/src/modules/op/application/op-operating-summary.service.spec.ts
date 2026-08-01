import type { ActorType } from '@gaoq/shared-types';
import type { Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  OpOperatingSummaryEvent,
  OpOutboxWriter,
} from '../persistence/op-outbox.writer.js';
import type {
  OpOperatingSummaryDocument,
  OpOperatingSummaryRecord,
} from '../persistence/op.schemas.js';
import {
  type ApplyOpOperatingSummaryInput,
  OpOperatingSummaryService,
} from './op-operating-summary.service.js';

const envelope = {
  schemaVersion: '1.0' as const,
  type: 'operating.summary.published' as const,
  occurredAt: '2026-07-22T08:00:00.000Z',
  data: {
    summaryDate: '2026-07-22',
    revision: 1,
    currency: 'CNY' as const,
    metrics: {
      gmvMinor: 123_456,
      paidOrderCount: 12,
      refundMinor: 500,
      refundOrderCount: 1,
      activeCustomerCount: 8,
    },
  },
};

const record = (
  overrides: Partial<OpOperatingSummaryRecord> = {},
): OpOperatingSummaryRecord => ({
  id: '01K00000000000000000000003',
  tenantId: 'tenant-001',
  summaryDate: envelope.data.summaryDate,
  revision: envelope.data.revision,
  currency: 'CNY',
  ...envelope.data.metrics,
  clientId: 'op-client-001',
  externalEventId: 'event-20260722-001',
  inboxId: '01K00000000000000000000001',
  payloadHash: 'p'.repeat(43),
  occurredAt: new Date(envelope.occurredAt),
  receivedAt: new Date('2026-07-22T08:00:01.000Z'),
  createdAt: new Date('2026-07-22T08:00:01.000Z'),
  updatedAt: new Date('2026-07-22T08:00:01.000Z'),
  ...overrides,
});

interface FixtureOptions {
  readonly latest?: OpOperatingSummaryRecord | null;
  readonly existing?: OpOperatingSummaryRecord | null;
  readonly created?: OpOperatingSummaryRecord | null;
  readonly executeTransaction?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const latest = options.latest ?? null;
  const existing = options.existing ?? null;
  const createdRecord = options.created === undefined ? record() : options.created;
  const session = {
    withTransaction: vi.fn(async (callback: () => Promise<void>) => {
      if (options.executeTransaction !== false) await callback();
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const findOne = vi.fn((filter: Record<string, unknown>) => {
    if ('externalEventId' in filter) {
      return { lean: () => ({ exec: () => Promise.resolve(existing) }) };
    }
    return {
      sort: () => ({
        session: () => ({ lean: () => ({ exec: () => Promise.resolve(latest) }) }),
        lean: () => ({ exec: () => Promise.resolve(latest) }),
      }),
    };
  });
  const summaries = {
    findOne,
    create: vi.fn().mockResolvedValue(
      createdRecord === null ? [] : [{ toObject: () => createdRecord }],
    ),
  };
  const connection = { startSession: vi.fn().mockResolvedValue(session) };
  const outbox = { appendOperatingSummary: vi.fn().mockResolvedValue(undefined) };
  const context = new TenantContextService();
  const service = new OpOperatingSummaryService(
    context,
    connection as unknown as Connection,
    summaries as unknown as Model<OpOperatingSummaryDocument>,
    outbox as unknown as OpOutboxWriter,
  );
  return { service, context, summaries, connection, outbox, session };
}

function input(
  overrides: Partial<ApplyOpOperatingSummaryInput> = {},
): ApplyOpOperatingSummaryInput {
  return {
    tenantId: 'tenant-001',
    clientId: 'op-client-001',
    externalEventId: 'event-20260722-001',
    inboxId: '01K00000000000000000000001',
    payloadHash: 'p'.repeat(43),
    receivedAt: new Date('2026-07-22T08:00:01.000Z'),
    envelope,
    ...overrides,
  };
}

async function inTenant<T>(
  context: TenantContextService,
  callback: () => Promise<T>,
  options: {
    readonly tenantId?: string;
    readonly actorType?: ActorType;
    readonly scopes?: readonly string[];
  } = {},
): Promise<T> {
  const tenantId = options.tenantId ?? 'tenant-001';
  return context.run({
    tenant: { tenantId, source: 'service_identity' },
    actor: {
      actorType: options.actorType ?? 'system_job',
      actorId: 'system:op-test',
      tenantId,
      roleCodes: ['INTEGRATION_WORKER'],
      scopes: options.scopes ?? ['erp:op:operating_summary:ingest'],
      departmentIds: [],
      traceId: 'trace-op-001',
    },
  }, callback);
}

describe('OpOperatingSummaryService', () => {
  it('首版摘要与固定白名单事件在同一事务追加', async () => {
    const store = fixture();
    const result = await inTenant(
      store.context,
      () => store.service.apply(input()),
    );

    expect(result).toMatchObject({
      id: '01K00000000000000000000003',
      summaryDate: '2026-07-22',
      revision: 1,
      payloadHash: 'p'.repeat(43),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(store.summaries.create).toHaveBeenCalledWith([
      expect.objectContaining({
        tenantId: 'tenant-001',
        summaryDate: '2026-07-22',
        revision: 1,
        gmvMinor: 123_456,
      }),
    ], { session: store.session });
    const outboxCall = store.outbox.appendOperatingSummary.mock.calls[0] as unknown as [
      OpOperatingSummaryEvent,
      unknown,
    ];
    expect(outboxCall[0]).toMatchObject({
      tenantId: 'tenant-001',
      version: 1,
      data: {
        summaryDate: '2026-07-22',
        payloadHash: 'p'.repeat(43),
      },
    });
    expect(outboxCall[1]).toBe(store.session);
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('查询只返回契约白名单投影且按可信租户选择最新修订', async () => {
    const store = fixture({ latest: record({ revision: 2 }) });
    const result = await inTenant(
      store.context,
      () => store.service.getLatest('2026-07-22'),
      { actorType: 'user', scopes: ['erp:op:operating_summary:read'] },
    );

    expect(result).toEqual({
      summaryDate: '2026-07-22',
      revision: 2,
      currency: 'CNY',
      metrics: envelope.data.metrics,
    });
    expect(Object.keys(result).sort()).toEqual([
      'currency', 'metrics', 'revision', 'summaryDate',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(store.summaries.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      summaryDate: '2026-07-22',
    });
  });

  it('读取在应用服务再次校验 Scope，并对不存在记录稳定失败', async () => {
    const denied = fixture();
    await expect(inTenant(
      denied.context,
      () => denied.service.getLatest('2026-07-22'),
      { actorType: 'user', scopes: [] },
    )).rejects.toMatchObject({
      response: { code: 'OP_OPERATING_SUMMARY_READ_DENIED' },
    });
    expect(denied.summaries.findOne).not.toHaveBeenCalled();

    const missing = fixture();
    await expect(inTenant(
      missing.context,
      () => missing.service.getLatest('2026-07-22'),
      { actorType: 'user', scopes: ['erp:op:operating_summary:read'] },
    )).rejects.toMatchObject({
      response: { code: 'OP_OPERATING_SUMMARY_NOT_FOUND' },
    });
  });

  it.each([
    '2026-7-22',
    '2026-02-30',
  ])('读取拒绝非法或不存在日期：%s', async (date) => {
    const store = fixture();
    await expect(inTenant(
      store.context,
      () => store.service.getLatest(date),
      { actorType: 'user', scopes: ['erp:op:operating_summary:read'] },
    )).rejects.toMatchObject({
      response: { code: 'OP_OPERATING_SUMMARY_DATE_INVALID' },
    });
    expect(store.summaries.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ['普通用户', { actorType: 'user' as const, scopes: ['erp:op:operating_summary:ingest'] }],
    ['缺少写 Scope', { actorType: 'system_job' as const, scopes: [] }],
  ])('%s不能调用内部写入口', async (_name, identity) => {
    const store = fixture();
    await expect(inTenant(
      store.context,
      () => store.service.apply(input()),
      identity,
    )).rejects.toMatchObject({
      response: { code: 'OP_OPERATING_SUMMARY_INGEST_DENIED' },
    });
    expect(store.summaries.findOne).not.toHaveBeenCalled();
  });

  it('写入口拒绝客户端 tenantId 与可信上下文不一致', async () => {
    const store = fixture();
    await expect(inTenant(
      store.context,
      () => store.service.apply(input({ tenantId: 'tenant-evil' })),
    )).rejects.toMatchObject({
      response: { code: 'OP_OPERATING_SUMMARY_CROSS_TENANT_DENIED' },
    });
    expect(store.summaries.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ['晚于事件上海业务日', '2026-07-23'],
    ['超过最近 31 日', '2026-06-20'],
  ])('拒绝%s的摘要日期', async (_name, summaryDate) => {
    const store = fixture();
    const changedEnvelope = {
      ...envelope,
      data: { ...envelope.data, summaryDate },
    };
    await expect(inTenant(
      store.context,
      () => store.service.apply(input({ envelope: changedEnvelope })),
    )).rejects.toMatchObject({
      response: { code: 'OP_OPERATING_SUMMARY_BUSINESS_DATE_INVALID' },
    });
    expect(store.summaries.findOne).not.toHaveBeenCalled();
  });

  it('同一事件同载荷直接返回首次内部结果，不开启新事务', async () => {
    const existing = record();
    const store = fixture({ existing });
    const result = await inTenant(store.context, () => store.service.apply(input()));

    expect(result).toMatchObject({ id: existing.id, payloadHash: existing.payloadHash });
    expect(store.connection.startSession).not.toHaveBeenCalled();
    expect(store.summaries.create).not.toHaveBeenCalled();
    expect(store.outbox.appendOperatingSummary).not.toHaveBeenCalled();
  });

  it('同一事件异载荷失败关闭', async () => {
    const store = fixture({ existing: record({ payloadHash: 'q'.repeat(43) }) });
    await expect(inTenant(
      store.context,
      () => store.service.apply(input()),
    )).rejects.toMatchObject({
      response: { code: 'OP_EVENT_PAYLOAD_CONFLICT' },
    });
    expect(store.connection.startSession).not.toHaveBeenCalled();
  });

  it('拒绝跳号修订且不写摘要或事件', async () => {
    const store = fixture({ latest: record({ revision: 1 }) });
    const changedEnvelope = {
      ...envelope,
      data: { ...envelope.data, revision: 3 },
    };
    await expect(inTenant(
      store.context,
      () => store.service.apply(input({ envelope: changedEnvelope })),
    )).rejects.toMatchObject({
      response: { code: 'OP_OPERATING_SUMMARY_REVISION_INVALID' },
    });
    expect(store.summaries.create).not.toHaveBeenCalled();
    expect(store.outbox.appendOperatingSummary).not.toHaveBeenCalled();
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });

  it('事务没有执行回调或创建结果缺失时失败关闭并结束 Session', async () => {
    const emptyTransaction = fixture({ executeTransaction: false });
    await expect(inTenant(
      emptyTransaction.context,
      () => emptyTransaction.service.apply(input()),
    )).rejects.toThrow('OP_OPERATING_SUMMARY_TRANSACTION_EMPTY');
    expect(emptyTransaction.session.endSession).toHaveBeenCalledOnce();

    const emptyCreate = fixture({ created: null });
    await expect(inTenant(
      emptyCreate.context,
      () => emptyCreate.service.apply(input()),
    )).rejects.toThrow('OP_OPERATING_SUMMARY_CREATE_FAILED');
    expect(emptyCreate.session.endSession).toHaveBeenCalledOnce();
  });

  it('Outbox 写入失败时事务错误保持原样并结束 Session', async () => {
    const store = fixture();
    const failure = new Error('outbox unavailable');
    store.outbox.appendOperatingSummary.mockRejectedValueOnce(failure);

    await expect(inTenant(
      store.context,
      () => store.service.apply(input()),
    )).rejects.toBe(failure);
    expect(store.session.endSession).toHaveBeenCalledOnce();
  });
});
