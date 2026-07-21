import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Connection, Model } from 'mongoose';

import { AUDIT_GENESIS_HASH, AuditIntegrityService } from './audit-integrity.service.js';
import {
  AuditChainHeadRecord,
  type AuditChainHeadRecordDocument,
  AuditEventRecord,
  type AuditEventRecordDocument,
} from './audit.schema.js';
import type { AuditEvent } from './audit.types.js';
import { AuditEventSink } from './audit.types.js';

const MAX_APPEND_ATTEMPTS = 3;

/** MongoDB 事务型审计出口；业务调用必须等待追加成功，禁止降级为普通日志。 */
@Injectable()
export class MongoAuditEventSink extends AuditEventSink {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(AuditEventRecord.name)
    private readonly events: Model<AuditEventRecordDocument>,
    @InjectModel(AuditChainHeadRecord.name)
    private readonly heads: Model<AuditChainHeadRecordDocument>,
    private readonly integrity: AuditIntegrityService,
  ) {
    super();
  }

  override async append(event: AuditEvent): Promise<void> {
    const normalized = this.integrity.normalize(event);
    const eventId = createEventId();
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(async () => {
          const head = await this.heads.findOne(
            { tenantId: normalized.tenantId },
            { tenantId: 1, sequence: 1, eventHash: 1, _id: 0 },
          ).session(session).lean().exec();
          const sequence = (head?.sequence ?? 0) + 1;
          const previousHash = head?.eventHash ?? AUDIT_GENESIS_HASH;
          const chainPayload = { ...normalized, eventId, sequence, previousHash };
          const signed = this.integrity.sign(chainPayload);
          await this.events.create([{
            ...chainPayload,
            occurredAt: new Date(normalized.occurredAt),
            resourceId: normalized.resourceId ?? null,
            keyId: signed.keyId,
            eventHash: signed.eventHash,
          }], { session });
          const result = await this.heads.updateOne(
            head === null
              ? { tenantId: normalized.tenantId }
              : {
                  tenantId: normalized.tenantId,
                  sequence: head.sequence,
                  eventHash: head.eventHash,
                },
            {
              $setOnInsert: { tenantId: normalized.tenantId },
              $set: {
                sequence,
                eventHash: signed.eventHash,
                keyId: signed.keyId,
              },
            },
            { upsert: head === null, session, runValidators: true },
          );
          if (result.modifiedCount + result.upsertedCount !== 1) {
            throw new Error('AUDIT_CHAIN_CONFLICT');
          }
        });
        return;
      } catch (error) {
        if (attempt >= MAX_APPEND_ATTEMPTS || !isConcurrencyError(error)) throw error;
      } finally {
        await session.endSession();
      }
    }
  }
}

function isConcurrencyError(error: unknown): boolean {
  if (error instanceof Error && error.message === 'AUDIT_CHAIN_CONFLICT') return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly hasErrorLabel?: (label: string) => boolean;
  };
  return candidate.code === 11_000 ||
    candidate.hasErrorLabel?.('TransientTransactionError') === true;
}
