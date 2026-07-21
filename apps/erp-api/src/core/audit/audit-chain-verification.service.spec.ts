import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditIntegrityService } from './audit-integrity.service.js';
import type { MetricsService } from '../observability/metrics.service.js';
import { AuditChainVerificationService } from './audit-chain-verification.service.js';
import type {
  AuditChainHeadRecordDocument,
  AuditEventRecordDocument,
} from './audit.schema.js';

const hash1 = 'a'.repeat(43);
const hash2 = 'b'.repeat(43);
const event = (sequence: number, previousHash: string, eventHash: string) => ({
  tenantId: 'tenant-001', eventId: `01K0000000000000000000000${sequence}`,
  sequence, actorId: 'actor-001', actorType: 'user' as const,
  action: 'employee.profile.update', resourceType: 'employee.profile', resourceId: null,
  riskLevel: 'R2' as const, outcome: 'success' as const,
  occurredAt: new Date('2026-07-21T05:00:00.000Z'), traceId: 'trace-001',
  metadataCanonical: '{}', keyId: 'audit-key-001', previousHash, eventHash,
});

const directQuery = (value: unknown) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
const listQuery = (value: unknown) => ({
  sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }) }),
});

describe('AuditChainVerificationService', () => {
  it('验证连续序号、前向哈希、事件 HMAC 与链头', async () => {
    const records = [event(1, '0'.repeat(43), hash1), event(2, hash1, hash2)];
    const find = vi.fn().mockReturnValue(listQuery(records));
    const verify = vi.fn().mockReturnValue(true);
    const eventModel = { find } as unknown as Model<AuditEventRecordDocument>;
    const headModel = {
      findOne: vi.fn().mockReturnValue(directQuery({
        sequence: 2, eventHash: hash2, keyId: 'audit-key-001',
      })),
    } as unknown as Model<AuditChainHeadRecordDocument>;
    const service = new AuditChainVerificationService(
      eventModel,
      headModel,
      { verify } as unknown as AuditIntegrityService,
      { recordAuditVerification: vi.fn() } as unknown as MetricsService,
    );
    await expect(service.verifyTenant('tenant-001')).resolves.toEqual({
      tenantId: 'tenant-001', verifiedEvents: 2, lastSequence: 2, lastHash: hash2,
    });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('序号断裂、哈希错误与链头漂移均失败关闭', async () => {
    const verify = vi.fn().mockReturnValue(true);
    const build = (records: unknown[], head: unknown) => {
      const eventModel = {
        find: vi.fn().mockReturnValue(listQuery(records)),
      } as unknown as Model<AuditEventRecordDocument>;
      const headModel = {
        findOne: vi.fn().mockReturnValue(directQuery(head)),
      } as unknown as Model<AuditChainHeadRecordDocument>;
      return new AuditChainVerificationService(
        eventModel,
        headModel,
        { verify } as unknown as AuditIntegrityService,
        { recordAuditVerification: vi.fn() } as unknown as MetricsService,
      );
    };
    await expect(build([event(2, '0'.repeat(43), hash2)], {
      sequence: 2, eventHash: hash2, keyId: 'audit-key-001',
    }).verifyTenant('tenant-001')).rejects.toThrow('AUDIT_CHAIN_SEQUENCE_INVALID');
    verify.mockReturnValueOnce(false);
    await expect(build([event(1, '0'.repeat(43), hash1)], {
      sequence: 1, eventHash: hash1, keyId: 'audit-key-001',
    }).verifyTenant('tenant-001')).rejects.toThrow('AUDIT_CHAIN_HASH_INVALID');
    await expect(build([], {
      sequence: 1, eventHash: hash1, keyId: 'audit-key-001',
    }).verifyTenant('tenant-001'))
      .rejects.toThrow('AUDIT_CHAIN_HEAD_INVALID');
  });
});
