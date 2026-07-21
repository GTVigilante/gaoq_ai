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

function fixture(overrides?: { readonly flowStatus?: 'provider_completed' | 'completed' }) {
  const flow = { ...FLOW, status: overrides?.flowStatus ?? FLOW.status };
  const context = {
    getTenantRequired: () => ({ tenantId: 'tenant-001', source: 'service_identity' }),
    getActorRequired: () => ({ scopes: ['erp:integration:esign:archive'] }),
  };
  const adapter = {
    getFlow: vi.fn().mockResolvedValue(2),
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
  return { service, adapter, scanner, archive, offers, flows, evidence, audit };
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
});
