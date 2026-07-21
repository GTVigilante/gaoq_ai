import type { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { MetricsService } from '../observability/metrics.service.js';
import type { AuditAnchorSigner } from './audit-anchor-signer.js';
import { AuditAnchorService } from './audit-anchor.service.js';
import type {
  AuditAnchorReceiptRecordDocument,
  AuditChainHeadRecordDocument,
} from './audit.schema.js';
import type { AuditChainVerificationService } from './audit-chain-verification.service.js';
import type { AuditWormWriteRequest } from './audit-worm.client.js';

const hash = 'a'.repeat(43);
const directQuery = (value: unknown) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

function assemble() {
  const head = {
    tenantId: 'tenant-001', sequence: 12, eventHash: hash, keyId: 'audit-key-001',
    updatedAt: new Date('2026-07-21T06:00:00.000Z'),
  };
  const headFindOne = vi.fn().mockReturnValue(directQuery(head));
  const headUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const receiptFindOne = vi.fn().mockReturnValue(directQuery(null));
  const receiptCreate = vi.fn().mockResolvedValue({});
  const verifyTenant = vi.fn().mockResolvedValue({
    tenantId: 'tenant-001', verifiedEvents: 12, lastSequence: 12, lastHash: hash,
  });
  const sign = vi.fn().mockReturnValue({ keyId: 'anchor-key-001', signature: 'signed-value' });
  const write = vi.fn().mockResolvedValue({
    receiptId: 'receipt-001', objectVersion: 'locked-v1', payloadHash: '',
    retainedUntil: '2033-07-20T06:00:00.000Z', anchoredAt: '2026-07-21T06:01:00.000Z',
  });
  const metrics = { recordAuditWormExport: vi.fn() };
  const service = new AuditAnchorService(
    { findOne: headFindOne, updateOne: headUpdateOne } as unknown as Model<AuditChainHeadRecordDocument>,
    { findOne: receiptFindOne, create: receiptCreate } as unknown as Model<AuditAnchorReceiptRecordDocument>,
    { verifyTenant } as unknown as AuditChainVerificationService,
    { sign } as unknown as AuditAnchorSigner,
    { isEnabled: () => true, write },
    { get: () => 2_555 } as unknown as ConfigService<AppEnvironment, true>,
    metrics as unknown as MetricsService,
  );
  return {
    service, headUpdateOne, receiptCreate, write, sign, metrics,
  };
}

describe('AuditAnchorService', () => {
  it('验链后签名确定性载荷、写入 WORM 并保存回执', async () => {
    const store = assemble();
    const result = await store.service.anchorTenant('tenant-001');
    expect(result).toEqual({
      tenantId: 'tenant-001', sequence: 12, status: 'anchored', receiptId: 'receipt-001',
    });
    const signedPayload = store.sign.mock.calls[0]?.[0] as string;
    expect(JSON.parse(signedPayload)).toEqual(expect.objectContaining({
      version: 'gaoq.audit.anchor.v1', tenantId: 'tenant-001', sequence: 12,
      eventHash: hash, auditKeyId: 'audit-key-001',
    }));
    const writeRequest = store.write.mock.calls[0]?.[0] as AuditWormWriteRequest;
    expect(writeRequest.payloadCanonical).toBe(signedPayload);
    expect(writeRequest.payloadHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(writeRequest.signingKeyId).toBe('anchor-key-001');
    expect(store.receiptCreate).toHaveBeenCalledWith(expect.objectContaining({
      receiptId: 'receipt-001', sequence: 12, payloadCanonical: signedPayload,
    }));
    expect(store.headUpdateOne).toHaveBeenCalledOnce();
    expect(store.metrics.recordAuditWormExport).toHaveBeenCalledWith(
      'success', new Date('2026-07-21T06:01:00.000Z'),
    );
  });

  it('外部写入失败时不保存回执并记录失败指标', async () => {
    const store = assemble();
    store.write.mockRejectedValueOnce(new Error('AUDIT_WORM_HTTP_503'));
    await expect(store.service.anchorTenant('tenant-001')).rejects.toThrow('AUDIT_WORM_HTTP_503');
    expect(store.receiptCreate).not.toHaveBeenCalled();
    expect(store.metrics.recordAuditWormExport).toHaveBeenCalledWith('failure');
  });
});
