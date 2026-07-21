import { createHash } from 'node:crypto';

import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentOfferService } from '../recruitment/application/recruitment-offer.service.js';
import { ESignAdapter } from './esign.adapter.js';
import { ESignBinding, type ESignBindingDocument } from './esign-binding.schema.js';
import {
  ESignEvidenceRecord,
  type ESignEvidenceArtifactRecord,
  type ESignEvidenceDocument,
} from './esign-evidence.schema.js';
import { ESignImmutableArchive, ESignMalwareScanner } from './esign-evidence.ports.js';
import { ESignFlowRecord, type ESignFlowDocument } from './esign-flow.schema.js';
import { ESignWebhookCryptoService } from './esign-webhook-crypto.service.js';
import { ESignSecretResolver } from './esign-webhook.service.js';

/** eSign PDF 验签、扫描、WORM 归档和 Offer 终态编排；任一证据不完整即失败关闭。 */
@Injectable()
export class ESignEvidenceService {
  constructor(
    private readonly context: TenantContextService,
    private readonly adapter: ESignAdapter,
    private readonly secrets: ESignSecretResolver,
    private readonly crypto: ESignWebhookCryptoService,
    private readonly scanner: ESignMalwareScanner,
    private readonly archive: ESignImmutableArchive,
    private readonly offers: RecruitmentOfferService,
    private readonly audit: AuditService,
    @InjectModel(ESignBinding.name)
    private readonly bindings: Model<ESignBindingDocument>,
    @InjectModel(ESignFlowRecord.name)
    private readonly flows: Model<ESignFlowDocument>,
    @InjectModel(ESignEvidenceRecord.name)
    private readonly evidence: Model<ESignEvidenceDocument>,
  ) {}

  async archiveCompletedFlow(flowId: string): Promise<{ readonly evidenceId: string }> {
    this.requireScope('erp:integration:esign:archive');
    const tenantId = this.context.getTenantRequired().tenantId;
    const flow = await this.flows.findOne({ tenantId, id: flowId }).lean().exec();
    if (
      flow === null || !['provider_completed', 'completed'].includes(flow.status) ||
      flow.reviewRequired
    ) {
      throw new ConflictException({
        code: 'ESIGN_FLOW_NOT_ARCHIVABLE', message: 'eSign 流程未达到可归档的可信状态',
      });
    }
    const existing = await this.evidence.findOne({ tenantId, flowId }).lean().exec();
    if (flow.status === 'completed' && (
      existing === null || flow.signedEvidenceId !== existing.id
    )) throw new Error('ESIGN_COMPLETED_EVIDENCE_INTEGRITY_INVALID');
    const record = existing ?? await this.buildAndPersistEvidence(flow);
    await this.finalizeOfferAndFlow(flow, record);
    await this.audit.record({
      action: 'integration.esign.evidence.archive', resourceType: 'esign_evidence',
      resourceId: record.id, riskLevel: 'R3', outcome: 'success',
      metadata: { flowId: flow.id, artifactCount: record.artifacts.length },
    });
    return Object.freeze({ evidenceId: record.id });
  }

  private async buildAndPersistEvidence(flow: ESignFlowRecord): Promise<ESignEvidenceRecord> {
    const binding = await this.bindings.findOne({
      tenantId: flow.tenantId, provider: 'esign_cn', appId: flow.appId, status: 'active',
    }).lean().exec();
    if (binding === null) throw new Error('ESIGN_BINDING_NOT_FOUND');
    const credential = {
      appId: binding.appId, appSecret: this.secrets.resolve(binding.credentialSecretRef),
    };
    const externalFlowId = this.crypto.unprotectExternalId(flow.tenantId, flow.id, flow);
    if (await this.adapter.getFlow(credential, externalFlowId) !== 2) {
      throw new Error('ESIGN_PROVIDER_COMPLETION_NOT_CONFIRMED');
    }
    const descriptors = await this.adapter.listSignedFiles(credential, externalFlowId);
    const artifacts: ESignEvidenceArtifactRecord[] = [];
    for (const descriptor of descriptors) {
      const bytes = await this.adapter.downloadSignedFile(descriptor);
      const sha256 = createHash('sha256').update(bytes).digest('base64url');
      const scan = await this.scanner.scan({
        tenantId: flow.tenantId, flowId: flow.id, sha256, bytes,
      });
      if (!scan.clean) throw new Error('ESIGN_DOCUMENT_MALWARE_DETECTED');
      const verification = await this.adapter.verifySignedFile(
        credential, externalFlowId, descriptor.fileId,
      );
      if (!verification.valid || verification.signatureCount < 1) {
        throw new Error('ESIGN_DOCUMENT_SIGNATURE_INVALID');
      }
      const providerFileIdHash = createHash('sha256')
        .update(binding.appId).update(Buffer.from([0])).update(descriptor.fileId)
        .digest('base64url');
      const receipt = await this.archive.put({
        tenantId: flow.tenantId,
        objectKey: `esign/${flow.id}/${sha256}.pdf`,
        contentType: 'application/pdf', classification: 'L4',
        retentionPolicy: 'employment_contract', sha256, bytes,
      });
      if (!receipt.immutable) throw new Error('ESIGN_ARCHIVE_NOT_IMMUTABLE');
      artifacts.push(Object.freeze({
        providerFileIdHash, sha256, sizeBytes: bytes.length, contentType: 'application/pdf',
        objectRef: safeReference(receipt.objectRef), archiveReceiptId: safeId(receipt.receiptId),
        malwareScanEvidenceId: safeId(scan.evidenceId),
        providerVerificationDigest: verification.providerResultDigest,
        signatureCount: verification.signatureCount,
      }));
    }
    artifacts.sort((left, right) => left.providerFileIdHash.localeCompare(right.providerFileIdHash));
    const proofHash = createHash('sha256').update(JSON.stringify(artifacts.map((artifact) => ({
      providerFileIdHash: artifact.providerFileIdHash, sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes, objectRef: artifact.objectRef,
      archiveReceiptId: artifact.archiveReceiptId,
      malwareScanEvidenceId: artifact.malwareScanEvidenceId,
      providerVerificationDigest: artifact.providerVerificationDigest,
      signatureCount: artifact.signatureCount,
    })))).digest('base64url');
    const archivedAt = new Date();
    const id = createEventId(archivedAt);
    try {
      const created = await this.evidence.create({
        id, tenantId: flow.tenantId, flowId: flow.id, offerId: flow.offerId,
        provider: 'esign_cn', externalFlowIdHash: flow.externalFlowIdHash,
        artifacts, proofHash, archivedAt,
      });
      return created.toObject();
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.evidence.findOne({
        tenantId: flow.tenantId, flowId: flow.id,
      }).lean().exec();
      if (raced === null || raced.proofHash !== proofHash) {
        throw new Error('ESIGN_EVIDENCE_CONCURRENT_CONFLICT', { cause: error });
      }
      return raced;
    }
  }

  private async finalizeOfferAndFlow(
    flow: ESignFlowRecord,
    evidence: ESignEvidenceRecord,
  ): Promise<void> {
    const offer = await this.offers.get(flow.offerId);
    if (offer.status === 'signed') {
      if (offer.esignFlowId !== flow.id || offer.signedEvidenceId !== evidence.id) {
        throw new Error('ESIGN_OFFER_EVIDENCE_INTEGRITY_INVALID');
      }
    } else {
      await this.offers.recordSignedForIntegration(
        flow.offerId, offer.version, `esign-archive-${evidence.id}`,
        { esignFlowId: flow.id, signedEvidenceId: evidence.id },
      );
    }
    if (flow.status === 'provider_completed') {
      const updated = await this.flows.updateOne(
        { tenantId: flow.tenantId, id: flow.id, version: flow.version, status: 'provider_completed' },
        { $set: {
          status: 'completed', signedEvidenceId: evidence.id, updatedAt: new Date(),
        }, $inc: { version: 1 } },
        { runValidators: true, timestamps: false },
      );
      if (updated.modifiedCount !== 1) throw new Error('ESIGN_FLOW_VERSION_CONFLICT');
    }
  }

  private requireScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'ESIGN_TRUSTED_ARCHIVE_REQUIRED', message: '必须由受信任证据归档 Worker 执行',
    });
  }
}

function safeReference(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9/._:-]{0,511}$/.test(value)) {
    throw new Error('ESIGN_ARCHIVE_REFERENCE_INVALID');
  }
  return value;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('ESIGN_EVIDENCE_REFERENCE_INVALID');
  }
  return value;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
