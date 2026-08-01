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
  const pendingQuery = {
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue([]),
  };
  pendingQuery.sort.mockReturnValue(pendingQuery);
  pendingQuery.limit.mockReturnValue(pendingQuery);
  pendingQuery.lean.mockReturnValue(pendingQuery);
  const headFind = vi.fn().mockReturnValue(pendingQuery);
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
  const isEnabled = vi.fn().mockReturnValue(true);
  const metrics = { recordAuditWormExport: vi.fn() };
  const service = new AuditAnchorService(
    {
      find: headFind,
      findOne: headFindOne,
      updateOne: headUpdateOne,
    } as unknown as Model<AuditChainHeadRecordDocument>,
    { findOne: receiptFindOne, create: receiptCreate } as unknown as Model<AuditAnchorReceiptRecordDocument>,
    { verifyTenant } as unknown as AuditChainVerificationService,
    { sign } as unknown as AuditAnchorSigner,
    { isEnabled, write },
    { get: () => 2_555 } as unknown as ConfigService<AppEnvironment, true>,
    metrics as unknown as MetricsService,
  );
  return {
    service,
    head,
    headFind,
    headFindOne,
    headUpdateOne,
    pendingQuery,
    receiptFindOne,
    receiptCreate,
    verifyTenant,
    write,
    isEnabled,
    sign,
    metrics,
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

  it('拒绝非法租户、空链和验链后漂移的链头', async () => {
    const invalid = assemble();
    await expect(invalid.service.anchorTenant('tenant id')).rejects.toThrow(
      'AUDIT_TENANT_INVALID',
    );
    expect(invalid.verifyTenant).not.toHaveBeenCalled();

    const empty = assemble();
    empty.verifyTenant.mockResolvedValue({
      tenantId: 'tenant-001',
      verifiedEvents: 0,
      lastSequence: 0,
      lastHash: '',
    });
    await expect(empty.service.anchorTenant('tenant-001')).rejects.toThrow(
      'AUDIT_ANCHOR_CHAIN_EMPTY',
    );

    for (const changedHead of [
      null,
      { ...empty.head, sequence: 11 },
      { ...empty.head, eventHash: 'b'.repeat(43) },
    ]) {
      const changed = assemble();
      changed.headFindOne.mockReturnValueOnce(directQuery(changedHead));
      await expect(changed.service.anchorTenant('tenant-001')).rejects.toThrow(
        'AUDIT_ANCHOR_HEAD_CHANGED',
      );
      expect(changed.write).not.toHaveBeenCalled();
    }
  });

  it('优先使用链更新时间计算保留期并对既有一致回执幂等收敛', async () => {
    const first = assemble();
    first.headFindOne.mockReturnValueOnce(directQuery({
      ...first.head,
      chainUpdatedAt: new Date('2026-07-21T05:00:00.000Z'),
    }));
    await first.service.anchorTenant('tenant-001');
    const created = first.receiptCreate.mock.calls[0]?.[0] as {
      readonly eventHash: string;
      readonly payloadHash: string;
      readonly payloadCanonical: string;
    };
    expect(JSON.parse(created.payloadCanonical)).toMatchObject({
      capturedAt: '2026-07-21T05:00:00.000Z',
      retainUntil: '2033-07-19T05:00:00.000Z',
    });

    const existing = assemble();
    existing.headFindOne.mockReturnValueOnce(directQuery({
      ...existing.head,
      chainUpdatedAt: new Date('2026-07-21T05:00:00.000Z'),
    }));
    existing.receiptFindOne.mockReturnValueOnce(directQuery({
      ...created,
      receiptId: 'receipt-existing',
      anchoredAt: new Date('2026-07-21T05:01:00.000Z'),
    }));
    await expect(existing.service.anchorTenant('tenant-001')).resolves.toEqual({
      tenantId: 'tenant-001',
      sequence: 12,
      status: 'already_anchored',
      receiptId: 'receipt-existing',
    });
    expect(existing.sign).not.toHaveBeenCalled();
    expect(existing.write).not.toHaveBeenCalled();
    expect(existing.headUpdateOne).toHaveBeenCalledOnce();
  });

  it('既有回执任何绑定漂移都失败关闭', async () => {
    const baseline = assemble();
    await baseline.service.anchorTenant('tenant-001');
    const created = baseline.receiptCreate.mock.calls[0]?.[0] as {
      readonly eventHash: string;
      readonly payloadHash: string;
      readonly payloadCanonical: string;
    };
    for (const conflict of [
      { ...created, eventHash: 'b'.repeat(43) },
      { ...created, payloadHash: 'c'.repeat(43) },
      { ...created, payloadCanonical: '{"tampered":true}' },
    ]) {
      const store = assemble();
      store.receiptFindOne.mockReturnValueOnce(directQuery({
        ...conflict,
        receiptId: 'receipt-conflict',
        anchoredAt: new Date('2026-07-21T06:01:00.000Z'),
      }));
      await expect(store.service.anchorTenant('tenant-001')).rejects.toThrow(
        'AUDIT_ANCHOR_RECEIPT_CONFLICT',
      );
      expect(store.write).not.toHaveBeenCalled();
    }
  });

  it('回执唯一键竞争只接受同一 WORM 回执，其他写入异常原样失败', async () => {
    const converged = assemble();
    converged.receiptCreate.mockRejectedValueOnce({ code: 11_000 });
    const originalFind = converged.receiptFindOne;
    originalFind.mockImplementationOnce(() => directQuery(null));
    originalFind.mockImplementationOnce(() => {
      const writeRequest = converged.write.mock.calls[0]?.[0] as AuditWormWriteRequest;
      return directQuery({
        payloadHash: writeRequest.payloadHash,
        receiptId: 'receipt-001',
      });
    });
    await expect(converged.service.anchorTenant('tenant-001')).resolves.toMatchObject({
      status: 'anchored',
      receiptId: 'receipt-001',
    });

    for (const concurrent of [
      { payloadHash: 'b'.repeat(43), receiptId: 'receipt-001' },
      { payloadHash: hash, receiptId: 'receipt-other' },
      null,
    ]) {
      const conflict = assemble();
      conflict.receiptCreate.mockRejectedValueOnce({ code: 11_000 });
      conflict.receiptFindOne
        .mockReturnValueOnce(directQuery(null))
        .mockReturnValueOnce(directQuery(concurrent));
      await expect(conflict.service.anchorTenant('tenant-001')).rejects.toThrow(
        'AUDIT_ANCHOR_RECEIPT_CONFLICT',
      );
    }

    for (const error of [new Error('MONGO_UNAVAILABLE'), null, { code: 42 }]) {
      const failed = assemble();
      failed.receiptCreate.mockRejectedValueOnce(error);
      await expect(failed.service.anchorTenant('tenant-001')).rejects.toBe(error);
    }
  });

  it('批量锚定在停用时跳过，并校验上限与稳定排序', async () => {
    const disabled = assemble();
    disabled.isEnabled.mockReturnValue(false);
    await expect(disabled.service.anchorPendingTenants()).resolves.toBe(0);
    expect(disabled.headFind).not.toHaveBeenCalled();

    const invalid = assemble();
    for (const limit of [0, 501, 1.5]) {
      await expect(invalid.service.anchorPendingTenants(limit)).rejects.toThrow(
        'AUDIT_ANCHOR_BATCH_SIZE_INVALID',
      );
    }

    const pending = assemble();
    pending.pendingQuery.exec.mockResolvedValue([
      { tenantId: 'tenant-001' },
      { tenantId: 'tenant-002' },
    ]);
    const anchor = vi.spyOn(pending.service, 'anchorTenant').mockResolvedValue({
      tenantId: 'tenant-001',
      sequence: 12,
      status: 'anchored',
      receiptId: 'receipt-001',
    });
    await expect(pending.service.anchorPendingTenants()).resolves.toBe(2);
    expect(pending.pendingQuery.sort).toHaveBeenCalledWith({
      lastAnchoredAt: 1,
      tenantId: 1,
    });
    expect(pending.pendingQuery.limit).toHaveBeenCalledWith(100);
    expect(anchor).toHaveBeenNthCalledWith(1, 'tenant-001');
    expect(anchor).toHaveBeenNthCalledWith(2, 'tenant-002');
  });

  it('链头锚定标记允许并发已收敛，拒绝链头回退或未标记', async () => {
    const converged = assemble();
    converged.headUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    converged.headFindOne
      .mockReturnValueOnce(directQuery(converged.head))
      .mockReturnValueOnce(directQuery({
        sequence: 12,
        anchoredSequence: 12,
      }));
    await expect(converged.service.anchorTenant('tenant-001')).resolves.toMatchObject({
      status: 'anchored',
    });

    for (const current of [
      null,
      { sequence: 11, anchoredSequence: 12 },
      { sequence: 12, anchoredSequence: 11 },
      { sequence: 12 },
    ]) {
      const failed = assemble();
      failed.headUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 });
      failed.headFindOne
        .mockReturnValueOnce(directQuery(failed.head))
        .mockReturnValueOnce(directQuery(current));
      await expect(failed.service.anchorTenant('tenant-001')).rejects.toThrow(
        'AUDIT_ANCHOR_HEAD_UPDATE_FAILED',
      );
    }
  });
});
