import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  AuditAnchorReceiptRecordSchema,
  AuditChainHeadRecordSchema,
  AuditEventRecordSchema,
  type AuditChainHeadRecord,
  type AuditEventRecord,
} from './audit.schema.js';

const mongoose = new Mongoose();
const AuditEventModel = mongoose.model<AuditEventRecord>('SpecAuditEvent', AuditEventRecordSchema);
const AuditChainHeadModel = mongoose.model<AuditChainHeadRecord>(
  'SpecAuditChainHead',
  AuditChainHeadRecordSchema,
);

const baseEvent = {
  tenantId: 'tenant-001',
  eventId: '01K00000000000000000000000',
  sequence: 1,
  actorId: 'employee-001',
  actorType: 'user',
  action: 'employee.profile.update',
  resourceType: 'employee.profile',
  resourceId: 'employee-001',
  riskLevel: 'R2',
  outcome: 'success',
  occurredAt: new Date('2026-07-21T05:00:00.000Z'),
  traceId: 'trace-001',
  metadataCanonical: '{"count":1}',
  keyId: 'audit-key-001',
  previousHash: '0'.repeat(43),
  eventHash: 'a'.repeat(43),
};

describe('持久审计 Schema', () => {
  it('使用固定集合且声明全部唯一、检索索引并禁止 TTL', () => {
    expect(AuditEventRecordSchema.get('collection')).toBe('security_audit_events');
    expect(AuditChainHeadRecordSchema.get('collection')).toBe('security_audit_chain_heads');
    expect(AuditAnchorReceiptRecordSchema.get('collection')).toBe('security_audit_anchor_receipts');
    expect(AuditEventRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [{ tenantId: 1, sequence: 1 }, { unique: true }],
      [{ tenantId: 1, eventId: 1 }, { unique: true }],
      [{ tenantId: 1, occurredAt: 1 }, {}],
      [{ tenantId: 1, riskLevel: 1, occurredAt: 1 }, {}],
      [{ tenantId: 1, actorId: 1, occurredAt: 1 }, {}],
    ]));
    expect(AuditChainHeadRecordSchema.indexes()).toContainEqual([
      { tenantId: 1 }, { unique: true },
    ]);
    expect([
      ...AuditEventRecordSchema.indexes(),
      ...AuditChainHeadRecordSchema.indexes(),
      ...AuditAnchorReceiptRecordSchema.indexes(),
    ].every(([, options]) => options.expireAfterSeconds === undefined)).toBe(true);
  });

  it('元数据只能是长度受限的字符串而非动态对象', async () => {
    expect(AuditEventRecordSchema.path('metadataCanonical').instance).toBe('String');
    await expect(new AuditEventModel({
      ...baseEvent,
      metadataCanonical: 'x'.repeat(4_097),
    }).validate()).rejects.toThrow();
  });

  it('严格校验 ULID、枚举、正整数与 43 位哈希', async () => {
    await expect(new AuditEventModel(baseEvent).validate()).resolves.toBeUndefined();
    for (const invalid of [
      { eventId: 'not-ulid' },
      { sequence: 0 },
      { sequence: 1.5 },
      { actorType: 'admin' },
      { riskLevel: 'R4' },
      { previousHash: 'short' },
      { eventHash: '+'.repeat(43) },
    ]) {
      await expect(new AuditEventModel({ ...baseEvent, ...invalid }).validate()).rejects.toThrow();
    }
  });

  it('链头允许序号零且拒绝负数与非法密钥标识', async () => {
    const valid = {
      tenantId: 'tenant-001', sequence: 0,
      eventHash: '0'.repeat(43), keyId: 'audit-key-001',
    };
    await expect(new AuditChainHeadModel(valid).validate()).resolves.toBeUndefined();
    await expect(new AuditChainHeadModel({ ...valid, sequence: -1 }).validate()).rejects.toThrow();
    await expect(new AuditChainHeadModel({ ...valid, keyId: 'short' }).validate()).rejects.toThrow();
  });
});
