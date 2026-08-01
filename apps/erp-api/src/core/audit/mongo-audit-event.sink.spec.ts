import type { Connection, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditIntegrityService } from './audit-integrity.service.js';
import type { MetricsService } from '../observability/metrics.service.js';
import type {
  AuditChainHeadRecordDocument,
  AuditEventRecordDocument,
} from './audit.schema.js';
import { MongoAuditEventSink } from './mongo-audit-event.sink.js';

const auditEvent = {
  tenantId: 'tenant-001', actorId: 'employee-001', actorType: 'user' as const,
  action: 'employee.profile.update', resourceType: 'employee.profile',
  resourceId: 'employee-001', riskLevel: 'R2' as const, outcome: 'success' as const,
  occurredAt: '2026-07-21T05:00:00.000Z', traceId: 'trace-001',
  metadata: { count: 1 },
};

const query = (value: unknown) => ({
  session: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
});

function assemble() {
  const normalized = {
    tenantId: auditEvent.tenantId, actorId: auditEvent.actorId,
    actorType: auditEvent.actorType, action: auditEvent.action,
    resourceType: auditEvent.resourceType, resourceId: auditEvent.resourceId,
    riskLevel: auditEvent.riskLevel, outcome: auditEvent.outcome,
    occurredAt: auditEvent.occurredAt, traceId: auditEvent.traceId,
    metadataCanonical: '{"count":1}',
  };
  const normalize = vi.fn().mockReturnValue(normalized);
  const sign = vi.fn().mockReturnValue({ keyId: 'audit-key-001', eventHash: 'a'.repeat(43) });
  const headFindOne = vi.fn().mockReturnValue(query(null));
  const headUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 0, upsertedCount: 1 });
  const eventCreate = vi.fn().mockResolvedValue([]);
  const withTransaction = vi.fn(async (handler: () => Promise<void>) => handler());
  const endSession = vi.fn().mockResolvedValue(undefined);
  const startSession = vi.fn().mockResolvedValue({ withTransaction, endSession });
  const metrics = {
    recordAuditAppend: vi.fn(),
    recordAuditTransactionRetry: vi.fn(),
  };
  const sink = new MongoAuditEventSink(
    { startSession } as unknown as Connection,
    { create: eventCreate } as unknown as Model<AuditEventRecordDocument>,
    { findOne: headFindOne, updateOne: headUpdateOne } as unknown as Model<AuditChainHeadRecordDocument>,
    { normalize, sign } as unknown as AuditIntegrityService,
    metrics as unknown as MetricsService,
  );
  return {
    sink, normalize, sign, headFindOne, headUpdateOne, eventCreate,
    withTransaction, endSession, startSession, metrics,
  };
}

describe('MongoAuditEventSink', () => {
  it('在同一事务追加规范事件并推进租户链头', async () => {
    const store = assemble();
    await store.sink.append(auditEvent);
    expect(store.withTransaction).toHaveBeenCalledOnce();
    expect(store.eventCreate).toHaveBeenCalledOnce();
    const createCall = store.eventCreate.mock.calls[0] as unknown as [unknown[], { session: unknown }];
    expect(createCall[0]).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-001', sequence: 1,
        previousHash: '0'.repeat(43), metadataCanonical: '{"count":1}',
        keyId: 'audit-key-001', eventHash: 'a'.repeat(43),
      }),
    ]);
    expect(createCall[1]).toHaveProperty('session');
    expect(JSON.stringify(store.eventCreate.mock.calls)).not.toContain('metadata":{"count"');
    const updateCall = store.headUpdateOne.mock.calls[0] as unknown as [unknown, unknown, unknown];
    expect(updateCall[0]).toEqual({ tenantId: 'tenant-001' });
    expect(updateCall[1]).toMatchObject({ $set: { sequence: 1 } });
    const update = updateCall[1] as {
      readonly $set: Readonly<Record<string, unknown>>;
      readonly $setOnInsert: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(update.$set).filter(
      (field) => Object.hasOwn(update.$setOnInsert, field),
    )).toEqual([]);
    expect(updateCall[2]).toMatchObject({ upsert: true, runValidators: true });
    expect(store.endSession).toHaveBeenCalledOnce();
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledWith('success', expect.any(Number));
  });

  it('链头并发冲突最多重试三次并使用新的事务会话', async () => {
    const store = assemble();
    store.headUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 0, upsertedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1, upsertedCount: 0 });
    await store.sink.append(auditEvent);
    expect(store.startSession).toHaveBeenCalledTimes(2);
    expect(store.eventCreate).toHaveBeenCalledTimes(2);
    expect(store.endSession).toHaveBeenCalledTimes(2);
    expect(store.metrics.recordAuditTransactionRetry).toHaveBeenCalledOnce();
  });

  it('既有链头使用序号与哈希栅栏并将无资源事件保存为 null', async () => {
    const store = assemble();
    store.normalize.mockReturnValueOnce({
      tenantId: 'tenant-001',
      actorId: 'system-001',
      actorType: 'system_job',
      action: 'audit.verify',
      resourceType: 'audit.chain',
      riskLevel: 'R1',
      outcome: 'success',
      occurredAt: auditEvent.occurredAt,
      traceId: auditEvent.traceId,
      metadataCanonical: '{}',
    });
    store.headFindOne.mockReturnValueOnce(query({
      tenantId: 'tenant-001',
      sequence: 7,
      eventHash: 'b'.repeat(43),
    }));
    store.headUpdateOne.mockResolvedValueOnce({ modifiedCount: 1, upsertedCount: 0 });

    await store.sink.append({
      tenantId: auditEvent.tenantId,
      actorId: auditEvent.actorId,
      actorType: auditEvent.actorType,
      action: auditEvent.action,
      resourceType: auditEvent.resourceType,
      riskLevel: auditEvent.riskLevel,
      outcome: auditEvent.outcome,
      occurredAt: auditEvent.occurredAt,
      traceId: auditEvent.traceId,
      metadata: auditEvent.metadata,
    });

    const createInput = store.eventCreate.mock.calls[0]?.[0] as unknown as readonly [{
      readonly sequence: number;
      readonly previousHash: string;
      readonly resourceId: unknown;
    }];
    expect(createInput[0]).toMatchObject({
      sequence: 8,
      previousHash: 'b'.repeat(43),
      resourceId: null,
    });
    const updateFilter = store.headUpdateOne.mock.calls[0]?.[0] as unknown;
    expect(updateFilter).toEqual({
      tenantId: 'tenant-001',
      sequence: 7,
      eventHash: 'b'.repeat(43),
    });
    const updateOptions = store.headUpdateOne.mock.calls[0]?.[2] as unknown;
    expect(updateOptions).toMatchObject({ upsert: false });
  });

  it.each([
    [{ code: 11_000 }],
    [{ hasErrorLabel: (label: string) => label === 'TransientTransactionError' }],
  ])('Mongo 并发错误重试后成功：%o', async (concurrencyError) => {
    const store = assemble();
    store.withTransaction
      .mockRejectedValueOnce(concurrencyError)
      .mockImplementationOnce(async (handler: () => Promise<void>) => handler());
    await store.sink.append(auditEvent);
    expect(store.startSession).toHaveBeenCalledTimes(2);
    expect(store.metrics.recordAuditTransactionRetry).toHaveBeenCalledOnce();
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledWith(
      'success',
      expect.any(Number),
    );
  });

  it('并发冲突耗尽三次后失败关闭并记录一次失败指标', async () => {
    const store = assemble();
    store.headUpdateOne.mockResolvedValue({ modifiedCount: 0, upsertedCount: 0 });
    await expect(store.sink.append(auditEvent)).rejects.toThrow('AUDIT_CHAIN_CONFLICT');
    expect(store.startSession).toHaveBeenCalledTimes(3);
    expect(store.metrics.recordAuditTransactionRetry).toHaveBeenCalledTimes(2);
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledWith(
      'failure',
      expect.any(Number),
    );
  });

  it('非并发数据库错误不重试且保留原错误', async () => {
    const store = assemble();
    const failure = new Error('MONGODB_UNAVAILABLE');
    store.withTransaction.mockRejectedValueOnce(failure);
    await expect(store.sink.append(auditEvent)).rejects.toBe(failure);
    expect(store.startSession).toHaveBeenCalledOnce();
    expect(store.metrics.recordAuditTransactionRetry).not.toHaveBeenCalled();
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledWith(
      'failure',
      expect.any(Number),
    );
  });

  it('Mongo 会话创建失败时不伪造事务并记录失败', async () => {
    const store = assemble();
    const failure = new Error('SESSION_UNAVAILABLE');
    store.startSession.mockRejectedValueOnce(failure);
    await expect(store.sink.append(auditEvent)).rejects.toBe(failure);
    expect(store.withTransaction).not.toHaveBeenCalled();
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledWith(
      'failure',
      expect.any(Number),
    );
  });

  it('事务提交后的会话清理故障不把已落盘审计暴露为失败', async () => {
    const store = assemble();
    store.endSession.mockRejectedValueOnce(new Error('SESSION_CLEANUP_FAILED'));
    await expect(store.sink.append(auditEvent)).resolves.toBeUndefined();
    expect(store.eventCreate).toHaveBeenCalledOnce();
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledTimes(1);
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledWith(
      'success',
      expect.any(Number),
    );
  });

  it('事务未提交时的会话清理故障仍失败关闭', async () => {
    const store = assemble();
    store.withTransaction.mockRejectedValueOnce(new Error('MONGODB_UNAVAILABLE'));
    store.endSession.mockRejectedValueOnce(new Error('SESSION_CLEANUP_FAILED'));
    await expect(store.sink.append(auditEvent)).rejects.toThrow('SESSION_CLEANUP_FAILED');
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledWith(
      'failure',
      expect.any(Number),
    );
  });

  it('规范化或密钥失败时失败关闭且不触达数据库', async () => {
    const store = assemble();
    store.normalize.mockImplementationOnce(() => {
      throw new Error('AUDIT_EVENT_INVALID');
    });
    await expect(store.sink.append(auditEvent)).rejects.toThrow('AUDIT_EVENT_INVALID');
    expect(store.startSession).not.toHaveBeenCalled();
    expect(store.eventCreate).not.toHaveBeenCalled();
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledWith('failure', expect.any(Number));
  });

  it('事务内签名失败时结束会话并失败关闭', async () => {
    const store = assemble();
    store.sign.mockImplementationOnce(() => {
      throw new Error('AUDIT_INTEGRITY_KEY_UNAVAILABLE');
    });
    await expect(store.sink.append(auditEvent))
      .rejects.toThrow('AUDIT_INTEGRITY_KEY_UNAVAILABLE');
    expect(store.eventCreate).not.toHaveBeenCalled();
    expect(store.endSession).toHaveBeenCalledOnce();
    expect(store.metrics.recordAuditAppend).toHaveBeenCalledWith(
      'failure',
      expect.any(Number),
    );
  });
});
