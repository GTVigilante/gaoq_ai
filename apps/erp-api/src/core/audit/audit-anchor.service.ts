import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import type { Model } from 'mongoose';

import type { AppEnvironment } from '../../config/environment.js';
import { MetricsService } from '../observability/metrics.service.js';
import { AuditAnchorSigner } from './audit-anchor-signer.js';
import {
  AuditAnchorReceiptRecord,
  type AuditAnchorReceiptRecordDocument,
  AuditChainHeadRecord,
  type AuditChainHeadRecordDocument,
} from './audit.schema.js';
import { AuditChainVerificationService } from './audit-chain-verification.service.js';
import { AuditWormClient } from './audit-worm.client.js';

const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface AuditAnchorResult {
  readonly tenantId: string;
  readonly sequence: number;
  readonly status: 'anchored' | 'already_anchored';
  readonly receiptId: string;
}

/** 验证当前链头、签名并写入不同权限域 WORM，随后持久化不可变回执。 */
@Injectable()
export class AuditAnchorService {
  constructor(
    @InjectModel(AuditChainHeadRecord.name)
    private readonly heads: Model<AuditChainHeadRecordDocument>,
    @InjectModel(AuditAnchorReceiptRecord.name)
    private readonly receipts: Model<AuditAnchorReceiptRecordDocument>,
    private readonly verifier: AuditChainVerificationService,
    private readonly signer: AuditAnchorSigner,
    private readonly worm: AuditWormClient,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly metrics: MetricsService,
  ) {}

  isEnabled(): boolean {
    return this.worm.isEnabled();
  }

  async anchorTenant(tenantId: string): Promise<AuditAnchorResult> {
    if (!TENANT_ID_PATTERN.test(tenantId)) throw new Error('AUDIT_TENANT_INVALID');
    try {
      const verified = await this.verifier.verifyTenant(tenantId);
      if (verified.lastSequence === 0) throw new Error('AUDIT_ANCHOR_CHAIN_EMPTY');
      const head = await this.heads.findOne(
        { tenantId },
        {
          tenantId: 1, sequence: 1, eventHash: 1, keyId: 1,
          chainUpdatedAt: 1, updatedAt: 1, _id: 0,
        },
      ).lean().exec();
      if (
        head === null || head.sequence !== verified.lastSequence ||
        head.eventHash !== verified.lastHash
      ) throw new Error('AUDIT_ANCHOR_HEAD_CHANGED');
      const capturedAtValue = head.chainUpdatedAt ?? head.updatedAt;
      const capturedAt = capturedAtValue.toISOString();
      const retainUntil = new Date(
        capturedAtValue.getTime() +
          this.config.get('AUDIT_WORM_RETENTION_DAYS', { infer: true }) * DAY_MS,
      ).toISOString();
      const payloadCanonical = JSON.stringify({
        version: 'gaoq.audit.anchor.v1', tenantId, sequence: head.sequence,
        eventHash: head.eventHash, auditKeyId: head.keyId, capturedAt, retainUntil,
      });
      const payloadHash = createHash('sha256').update(payloadCanonical).digest('base64url');
      const existing = await this.receipts.findOne(
        { tenantId, sequence: head.sequence },
        {
          receiptId: 1, eventHash: 1, payloadHash: 1, payloadCanonical: 1,
          anchoredAt: 1, _id: 0,
        },
      ).lean().exec();
      if (existing !== null) {
        if (
          existing.eventHash !== head.eventHash || existing.payloadHash !== payloadHash ||
          existing.payloadCanonical !== payloadCanonical
        ) throw new Error('AUDIT_ANCHOR_RECEIPT_CONFLICT');
        await this.markHeadAnchored(tenantId, head.sequence, existing.anchoredAt);
        return Object.freeze({
          tenantId, sequence: head.sequence, status: 'already_anchored', receiptId: existing.receiptId,
        });
      }
      const signed = this.signer.sign(payloadCanonical);
      const receipt = await this.worm.write({
        payloadCanonical, payloadHash, signingKeyId: signed.keyId,
        signature: signed.signature, retainUntil,
      });
      try {
        await this.receipts.create({
          tenantId, sequence: head.sequence, eventHash: head.eventHash, auditKeyId: head.keyId,
          payloadCanonical, payloadHash, signingKeyId: signed.keyId, signature: signed.signature,
          receiptId: receipt.receiptId, objectVersion: receipt.objectVersion,
          retainedUntil: new Date(receipt.retainedUntil), anchoredAt: new Date(receipt.anchoredAt),
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const concurrent = await this.receipts.findOne(
          { tenantId, sequence: head.sequence },
          { payloadHash: 1, receiptId: 1, _id: 0 },
        ).lean().exec();
        if (
          concurrent?.payloadHash !== payloadHash || concurrent.receiptId !== receipt.receiptId
        ) throw new Error('AUDIT_ANCHOR_RECEIPT_CONFLICT', { cause: error });
      }
      await this.markHeadAnchored(tenantId, head.sequence, new Date(receipt.anchoredAt));
      this.metrics.recordAuditWormExport('success', new Date(receipt.anchoredAt));
      return Object.freeze({
        tenantId, sequence: head.sequence, status: 'anchored', receiptId: receipt.receiptId,
      });
    } catch (error) {
      this.metrics.recordAuditWormExport('failure');
      throw error;
    }
  }

  async anchorPendingTenants(limit = 100): Promise<number> {
    if (!this.isEnabled()) return 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
      throw new Error('AUDIT_ANCHOR_BATCH_SIZE_INVALID');
    }
    const heads = await this.heads.find(
      { $expr: { $gt: ['$sequence', { $ifNull: ['$anchoredSequence', 0] }] } },
      { tenantId: 1, _id: 0 },
    ).sort({ lastAnchoredAt: 1, tenantId: 1 }).limit(limit).lean().exec();
    for (const head of heads) await this.anchorTenant(head.tenantId);
    return heads.length;
  }

  private async markHeadAnchored(
    tenantId: string,
    sequence: number,
    anchoredAt: Date,
  ): Promise<void> {
    const result = await this.heads.updateOne(
      {
        tenantId,
        $or: [
          { anchoredSequence: { $lt: sequence } },
          { anchoredSequence: { $exists: false } },
        ],
      },
      { $set: { anchoredSequence: sequence, lastAnchoredAt: anchoredAt } },
      { runValidators: true },
    );
    if (result.modifiedCount === 0) {
      const current = await this.heads.findOne(
        { tenantId }, { sequence: 1, anchoredSequence: 1, _id: 0 },
      ).lean().exec();
      if (
        current === null || current.sequence < sequence ||
        (current.anchoredSequence ?? 0) < sequence
      ) {
        throw new Error('AUDIT_ANCHOR_HEAD_UPDATE_FAILED');
      }
    }
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { readonly code?: unknown }).code === 11_000;
}
