import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { elapsedSeconds, MetricsService } from '../observability/metrics.service.js';
import { AUDIT_GENESIS_HASH, AuditIntegrityService } from './audit-integrity.service.js';
import {
  AuditChainHeadRecord,
  type AuditChainHeadRecordDocument,
  AuditEventRecord,
  type AuditEventRecordDocument,
} from './audit.schema.js';

const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const VERIFY_BATCH_SIZE = 1_000;

export interface AuditChainVerificationResult {
  readonly tenantId: string;
  readonly verifiedEvents: number;
  readonly lastSequence: number;
  readonly lastHash: string;
}

/** 逐批验证租户审计 HMAC 链、序号连续性与链头一致性，不提供 HTTP/MCP 暴露。 */
@Injectable()
export class AuditChainVerificationService {
  constructor(
    @InjectModel(AuditEventRecord.name)
    private readonly events: Model<AuditEventRecordDocument>,
    @InjectModel(AuditChainHeadRecord.name)
    private readonly heads: Model<AuditChainHeadRecordDocument>,
    private readonly integrity: AuditIntegrityService,
    private readonly metrics: MetricsService,
  ) {}

  async verifyTenant(tenantId: string): Promise<AuditChainVerificationResult> {
    const startedAt = process.hrtime.bigint();
    try {
      const result = await this.verifyTenantChain(tenantId);
      this.metrics.recordAuditVerification('success', elapsedSeconds(startedAt));
      return result;
    } catch (error) {
      this.metrics.recordAuditVerification('failure', elapsedSeconds(startedAt));
      throw error;
    }
  }

  private async verifyTenantChain(tenantId: string): Promise<AuditChainVerificationResult> {
    if (!TENANT_ID_PATTERN.test(tenantId)) throw new Error('AUDIT_TENANT_INVALID');
    const head = await this.heads.findOne(
      { tenantId },
      { sequence: 1, eventHash: 1, keyId: 1, _id: 0 },
    ).lean().exec();
    let lastSequence = 0;
    let lastHash = AUDIT_GENESIS_HASH;
    let lastKeyId: string | null = null;
    let verifiedEvents = 0;
    while (true) {
      const records = await this.events.find(
        { tenantId, sequence: { $gt: lastSequence } },
        {
          tenantId: 1, eventId: 1, sequence: 1, actorId: 1, actorType: 1,
          action: 1, resourceType: 1, resourceId: 1, riskLevel: 1, outcome: 1,
          occurredAt: 1, traceId: 1, metadataCanonical: 1, keyId: 1,
          previousHash: 1, eventHash: 1, _id: 0,
        },
      ).sort({ sequence: 1 }).limit(VERIFY_BATCH_SIZE).lean().exec();
      if (records.length === 0) break;
      for (const record of records) {
        if (record.sequence !== lastSequence + 1 || record.previousHash !== lastHash) {
          throw new Error('AUDIT_CHAIN_SEQUENCE_INVALID');
        }
        const valid = this.integrity.verify({
          tenantId: record.tenantId,
          eventId: record.eventId,
          sequence: record.sequence,
          actorId: record.actorId,
          actorType: record.actorType,
          action: record.action,
          resourceType: record.resourceType,
          ...(record.resourceId === null ? {} : { resourceId: record.resourceId }),
          riskLevel: record.riskLevel,
          outcome: record.outcome,
          occurredAt: record.occurredAt.toISOString(),
          traceId: record.traceId,
          metadataCanonical: record.metadataCanonical,
          previousHash: record.previousHash,
        }, record.keyId, record.eventHash);
        if (!valid) throw new Error('AUDIT_CHAIN_HASH_INVALID');
        lastSequence = record.sequence;
        lastHash = record.eventHash;
        lastKeyId = record.keyId;
        verifiedEvents += 1;
      }
      if (records.length < VERIFY_BATCH_SIZE) break;
    }
    if (
      (head === null && lastSequence !== 0) ||
      (head !== null && (
        head.sequence !== lastSequence || head.eventHash !== lastHash || head.keyId !== lastKeyId
      ))
    ) throw new Error('AUDIT_CHAIN_HEAD_INVALID');
    return Object.freeze({ tenantId, verifiedEvents, lastSequence, lastHash });
  }
}
