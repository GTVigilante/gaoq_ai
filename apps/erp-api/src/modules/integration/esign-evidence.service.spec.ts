import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentOfferService } from '../recruitment/application/recruitment-offer.service.js';
import type { ESignBindingDocument } from './esign-binding.schema.js';
import type { ESignEvidenceDocument } from './esign-evidence.schema.js';
import { ESignEvidenceService } from './esign-evidence.service.js';
import type { ESignFlowDocument } from './esign-flow.schema.js';
import type { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

const FLOW = {
  id: '01K00000000000000000000001', tenantId: 'tenant-001', provider: 'esign_cn',
  appId: 'app12345', offerId: '01K00000000000000000000002',
  externalFlowIdHash: 'A'.repeat(43), status: 'provider_completed', providerStatus: 2,
  reviewRequired: false, reviewCode: null, signedEvidenceId: null, version: 3,
};

function fixture(overrides?: {
  readonly flowStatus?: 'provider_completed' | 'completed';
  readonly scopes?: readonly string[];
}) {
  const flow = { ...FLOW, status: overrides?.flowStatus ?? FLOW.status };
  const context = {
    getTenantRequired: () => ({ tenantId: 'tenant-001', source: 'service_identity' }),
    getActorRequired: () => ({
      scopes: overrides?.scopes ?? ['erp:integration:esign:archive'],
    }),
  };
  const adapter = {
    createFlow: vi.fn(),
    getFlow: vi.fn().mockResolvedValue(2),
    signUrl: vi.fn(),
    listSignedFiles: vi.fn().mockResolvedValue([{ fileId: 'file-001', downloadUrl: 'https://esign.cn/x' }]),
    downloadSignedFile: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7\nsigned')),
    verifySignedFile: vi.fn().mockResolvedValue({
      valid: true, signatureCount: 2, providerResultDigest: 'B'.repeat(43),
    }),
  };
  const scanner = { scan: vi.fn().mockResolvedValue({ clean: true, evidenceId: 'scan-001' }) };
  const archive = { put: vi.fn().mockResolvedValue({
    objectRef: 'worm/esign/object-001', receiptId: 'archive-001', immutable: true,
  }) };
  const offers = {
    get: vi.fn().mockResolvedValue({
      status: 'accepted', version: 5, esignFlowId: null, signedEvidenceId: null,
    }),
    recordSignedForIntegration: vi.fn().mockResolvedValue({ offer: { status: 'signed' } }),
  };
  const bindings = { findOne: vi.fn().mockReturnValue(query({
    appId: 'app12345', credentialSecretRef: 'GAOQ_ESIGN_APP_TEST',
  })) };
  const flows = {
    findOne: vi.fn().mockReturnValue(query(flow)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const evidence = {
    findOne: vi.fn().mockReturnValue(query(null)),
    create: vi.fn().mockImplementation((input: Record<string, unknown>) => Promise.resolve({
      toObject: () => input,
    })),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new ESignEvidenceService(
    context as unknown as TenantContextService,
    adapter,
    { resolve: () => 'test-only-app-secret' },
    { unprotectExternalId: () => 'external-flow-001' } as unknown as ESignWebhookCryptoService,
    scanner,
    archive,
    offers as unknown as RecruitmentOfferService,
    audit as unknown as AuditService,
    bindings as unknown as Model<ESignBindingDocument>,
    flows as unknown as Model<ESignFlowDocument>,
    evidence as unknown as Model<ESignEvidenceDocument>,
  );
  return { service, adapter, scanner, archive, offers, flows, evidence, audit, bindings, flow };
}

describe('ESignEvidenceService', () => {
  it('供应商复核、PDF 摘要、扫描、验签和 WORM 回执齐全后才标记 Offer 已签', async () => {
    const store = fixture();
    const result = await store.service.archiveCompletedFlow(FLOW.id);
    expect(result.evidenceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(store.archive.put).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'application/pdf', classification: 'L4',
      retentionPolicy: 'employment_contract',
    }));
    const evidenceInput = store.evidence.create.mock.calls[0]?.[0] as unknown as {
      readonly artifacts: readonly Readonly<Record<string, unknown>>[];
    };
    expect(evidenceInput.artifacts[0]).toMatchObject({
      objectRef: 'worm/esign/object-001', malwareScanEvidenceId: 'scan-001', signatureCount: 2,
    });
    expect(JSON.stringify(evidenceInput)).not.toMatch(/PDF-|downloadUrl|app-secret/u);
    expect(store.offers.recordSignedForIntegration).toHaveBeenCalledWith(
      FLOW.offerId, 5, `esign-archive-${result.evidenceId}`,
      { esignFlowId: FLOW.id, signedEvidenceId: result.evidenceId },
    );
    const flowUpdate = store.flows.updateOne.mock.calls[0]?.[1] as unknown as {
      readonly $set: Readonly<Record<string, unknown>>;
    };
    expect(store.flows.updateOne.mock.calls[0]?.[0]).toMatchObject({
      status: 'provider_completed', version: 3,
    });
    expect(flowUpdate.$set).toMatchObject({ status: 'completed' });
  });

  it('病毒扫描不通过时不验签、不归档、不写证据也不推进 Offer', async () => {
    const store = fixture();
    store.scanner.scan.mockResolvedValue({ clean: false, evidenceId: 'scan-dirty-001' });
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .rejects.toThrow('ESIGN_DOCUMENT_MALWARE_DETECTED');
    expect(store.adapter.verifySignedFile).not.toHaveBeenCalled();
    expect(store.archive.put).not.toHaveBeenCalled();
    expect(store.evidence.create).not.toHaveBeenCalled();
    expect(store.offers.recordSignedForIntegration).not.toHaveBeenCalled();
  });

  it('无归档 Scope 时在读取流程前失败关闭', async () => {
    const store = fixture({ scopes: [] });
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .rejects.toMatchObject({ response: { code: 'ESIGN_TRUSTED_ARCHIVE_REQUIRED' } });
    expect(store.flows.findOne).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [{ ...FLOW, status: 'awaiting_signature' }],
    [{ ...FLOW, reviewRequired: true }],
  ])('拒绝不可归档流程：%s', async (flow) => {
    const store = fixture();
    store.flows.findOne.mockReturnValueOnce(query(flow));
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .rejects.toMatchObject({ response: { code: 'ESIGN_FLOW_NOT_ARCHIVABLE' } });
    expect(store.adapter.getFlow).not.toHaveBeenCalled();
  });

  it('completed 流程必须引用同一份既有证据', async () => {
    const store = fixture({ flowStatus: 'completed' });
    store.evidence.findOne.mockReturnValueOnce(query(null));
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .rejects.toThrow('ESIGN_COMPLETED_EVIDENCE_INTEGRITY_INVALID');
    expect(store.adapter.getFlow).not.toHaveBeenCalled();
  });

  it('既有证据与已签 Offer 一致时幂等返回且不重复下载归档', async () => {
    const store = fixture({ flowStatus: 'completed' });
    const existing = {
      id: '01K00000000000000000000009',
      tenantId: FLOW.tenantId,
      flowId: FLOW.id,
      offerId: FLOW.offerId,
      artifacts: [{ providerFileIdHash: 'A'.repeat(43) }],
    };
    store.flows.findOne.mockReturnValueOnce(query({
      ...store.flow,
      signedEvidenceId: existing.id,
    }));
    store.evidence.findOne.mockReturnValueOnce(query(existing));
    store.offers.get.mockResolvedValueOnce({
      status: 'signed',
      version: 6,
      esignFlowId: FLOW.id,
      signedEvidenceId: existing.id,
    });
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .resolves.toEqual({ evidenceId: existing.id });
    expect(store.adapter.getFlow).not.toHaveBeenCalled();
    expect(store.archive.put).not.toHaveBeenCalled();
    expect(store.offers.recordSignedForIntegration).not.toHaveBeenCalled();
    expect(store.flows.updateOne).not.toHaveBeenCalled();
  });

  it('证据提交后的审计故障只告警，不把成功终态改写为失败', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    const result = await store.service.archiveCompletedFlow(FLOW.id);
    expect(result.evidenceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(store.offers.recordSignedForIntegration).toHaveBeenCalledOnce();
    expect(store.flows.updateOne).toHaveBeenCalledOnce();
  });

  it('绑定缺失或供应商未确认完成时不产生归档副作用', async () => {
    const missing = fixture();
    missing.bindings.findOne.mockReturnValueOnce(query(null));
    await expect(missing.service.archiveCompletedFlow(FLOW.id))
      .rejects.toThrow('ESIGN_BINDING_NOT_FOUND');
    expect(missing.adapter.getFlow).not.toHaveBeenCalled();

    const incomplete = fixture();
    incomplete.adapter.getFlow.mockResolvedValueOnce(1);
    await expect(incomplete.service.archiveCompletedFlow(FLOW.id))
      .rejects.toThrow('ESIGN_PROVIDER_COMPLETION_NOT_CONFIRMED');
    expect(incomplete.adapter.listSignedFiles).not.toHaveBeenCalled();
    expect(incomplete.archive.put).not.toHaveBeenCalled();
  });

  it('重复文件描述符在任何下载、扫描或外部归档前失败关闭', async () => {
    const store = fixture();
    store.adapter.listSignedFiles.mockResolvedValueOnce([
      { fileId: 'file-001', downloadUrl: 'https://esign.cn/a' },
      { fileId: 'file-001', downloadUrl: 'https://esign.cn/b' },
    ]);
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .rejects.toThrow('ESIGN_DOCUMENT_DESCRIPTOR_DUPLICATED');
    expect(store.adapter.downloadSignedFile).not.toHaveBeenCalled();
    expect(store.scanner.scan).not.toHaveBeenCalled();
    expect(store.archive.put).not.toHaveBeenCalled();
  });

  it.each([
    [{ valid: false, signatureCount: 1, providerResultDigest: 'B'.repeat(43) }],
    [{ valid: true, signatureCount: 0, providerResultDigest: 'B'.repeat(43) }],
  ])('拒绝无效或缺失的供应商签名证据：%s', async (verification) => {
    const store = fixture();
    store.adapter.verifySignedFile.mockResolvedValueOnce(verification);
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .rejects.toThrow('ESIGN_DOCUMENT_SIGNATURE_INVALID');
    expect(store.archive.put).not.toHaveBeenCalled();
    expect(store.evidence.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ objectRef: 'worm/esign/object-001', receiptId: 'archive-001', immutable: false },
      'ESIGN_ARCHIVE_NOT_IMMUTABLE'],
    [{ objectRef: '../unsafe', receiptId: 'archive-001', immutable: true },
      'ESIGN_ARCHIVE_REFERENCE_INVALID'],
    [{ objectRef: 'worm/esign/object-001', receiptId: 'unsafe receipt', immutable: true },
      'ESIGN_EVIDENCE_REFERENCE_INVALID'],
  ])('拒绝无效 WORM 回执：%s', async (receipt, code) => {
    const store = fixture();
    store.archive.put.mockResolvedValueOnce(receipt);
    await expect(store.service.archiveCompletedFlow(FLOW.id)).rejects.toThrow(code);
    expect(store.evidence.create).not.toHaveBeenCalled();
    expect(store.offers.recordSignedForIntegration).not.toHaveBeenCalled();
  });

  it('已签 Offer 的流程或证据引用错位时禁止修补', async () => {
    const store = fixture();
    store.offers.get.mockResolvedValueOnce({
      status: 'signed',
      version: 6,
      esignFlowId: '01K00000000000000000000008',
      signedEvidenceId: '01K00000000000000000000009',
    });
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .rejects.toThrow('ESIGN_OFFER_EVIDENCE_INTEGRITY_INVALID');
    expect(store.flows.updateOne).not.toHaveBeenCalled();
  });

  it('Flow 乐观锁失败时保留可恢复的 provider_completed 状态', async () => {
    const store = fixture();
    store.flows.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .rejects.toThrow('ESIGN_FLOW_VERSION_CONFLICT');
    expect(store.offers.recordSignedForIntegration).toHaveBeenCalledOnce();
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('证据唯一键竞态仅在 proofHash 一致时复用同一账本', async () => {
    const store = fixture();
    let attempted: Readonly<Record<string, unknown>> | undefined;
    store.evidence.create.mockImplementationOnce((input: Record<string, unknown>) => {
      attempted = input;
      return Promise.reject(Object.assign(new Error('DUPLICATE_KEY'), { code: 11_000 }));
    });
    store.evidence.findOne
      .mockReturnValueOnce(query(null))
      .mockImplementationOnce(() => query({
        ...attempted,
        id: '01K00000000000000000000009',
      }));
    await expect(store.service.archiveCompletedFlow(FLOW.id))
      .resolves.toEqual({ evidenceId: '01K00000000000000000000009' });
    expect(store.offers.recordSignedForIntegration).toHaveBeenCalledWith(
      FLOW.offerId,
      5,
      'esign-archive-01K00000000000000000000009',
      {
        esignFlowId: FLOW.id,
        signedEvidenceId: '01K00000000000000000000009',
      },
    );
  });

  it('唯一键竞态回读缺失或摘要错位时拒绝合并证据', async () => {
    for (const raced of [
      null,
      { id: '01K00000000000000000000009', proofHash: 'A'.repeat(43) },
    ]) {
      const store = fixture();
      store.evidence.create.mockRejectedValueOnce({ code: 11_000 });
      store.evidence.findOne
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(raced));
      await expect(store.service.archiveCompletedFlow(FLOW.id))
        .rejects.toThrow('ESIGN_EVIDENCE_CONCURRENT_CONFLICT');
      expect(store.offers.recordSignedForIntegration).not.toHaveBeenCalled();
    }
  });

  it('非唯一键证据写入错误原样抛出', async () => {
    const store = fixture();
    const error = new Error('MONGO_UNAVAILABLE');
    store.evidence.create.mockRejectedValueOnce(error);
    await expect(store.service.archiveCompletedFlow(FLOW.id)).rejects.toBe(error);
    expect(store.offers.recordSignedForIntegration).not.toHaveBeenCalled();
  });
});
