import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  RecruitmentDataCryptoService,
  type ProtectedRecruitmentData,
} from '../../recruitment/persistence/recruitment-data-crypto.service.js';
import type { TalentTouchpoint } from '../domain/index.js';
import {
  TalentTouchpointRecord,
  type TalentTouchpointDocument,
} from './talent-lifecycle.schemas.js';

export class TalentTouchpointWriteConflictError extends Error {
  constructor() {
    super('人才服务触点版本冲突');
    this.name = 'TalentTouchpointWriteConflictError';
  }
}

@Injectable()
export class TalentTouchpointRepository {
  constructor(
    private readonly context: TenantContextService,
    private readonly crypto: RecruitmentDataCryptoService,
    @InjectModel(TalentTouchpointRecord.name)
    private readonly records: Model<TalentTouchpointDocument>,
  ) {}

  async findById(id: string, session?: ClientSession): Promise<TalentTouchpoint | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findByCandidateId(candidateId: string): Promise<readonly TalentTouchpoint[]> {
    const records = await this.records
      .find({ tenantId: this.tenantId(), candidateId })
      .sort({ occurredAt: -1, id: 1 })
      .limit(500)
      .lean()
      .exec();
    return records.map((record) => this.toDomain(record));
  }

  async insert(touchpoint: TalentTouchpoint, session: ClientSession): Promise<void> {
    this.assertTenant(touchpoint.tenantId);
    await this.records.create([this.toRecord(touchpoint)], { session });
  }

  async replace(
    touchpoint: TalentTouchpoint,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(touchpoint.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: touchpoint.id, version: expectedVersion },
      { $set: {
        status: touchpoint.status,
        version: touchpoint.version,
        updatedAt: new Date(touchpoint.updatedAt),
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1) throw new TalentTouchpointWriteConflictError();
  }

  private toRecord(touchpoint: TalentTouchpoint): Record<string, unknown> {
    const note = touchpoint.note === null
      ? null
      : this.crypto.protect({
          tenantId: touchpoint.tenantId,
          resourceType: 'talent_touchpoint',
          resourceId: touchpoint.id,
        }, { note: touchpoint.note });
    return {
      id: touchpoint.id,
      tenantId: touchpoint.tenantId,
      candidateId: touchpoint.candidateId,
      kind: touchpoint.kind,
      channel: touchpoint.channel,
      direction: touchpoint.direction,
      outcome: touchpoint.outcome,
      ownerActorId: touchpoint.ownerActorId,
      occurredAt: new Date(touchpoint.occurredAt),
      nextActionAt: touchpoint.nextActionAt === null ? null : new Date(touchpoint.nextActionAt),
      status: touchpoint.status,
      noteKeyId: note?.keyId ?? null,
      noteIv: note?.iv ?? null,
      noteCiphertext: note?.ciphertext ?? null,
      noteAuthTag: note?.authTag ?? null,
      version: touchpoint.version,
      createdAt: new Date(touchpoint.createdAt),
      updatedAt: new Date(touchpoint.updatedAt),
    };
  }

  private toDomain(record: TalentTouchpointRecord): TalentTouchpoint {
    const note = this.decryptNote(record);
    return Object.freeze({
      id: record.id,
      tenantId: record.tenantId,
      candidateId: record.candidateId,
      kind: record.kind,
      channel: record.channel,
      direction: record.direction,
      outcome: record.outcome,
      ownerActorId: record.ownerActorId,
      occurredAt: record.occurredAt.toISOString(),
      nextActionAt: record.nextActionAt?.toISOString() ?? null,
      status: record.status,
      note,
      version: record.version,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }

  private decryptNote(record: TalentTouchpointRecord): string | null {
    const values = [
      record.noteKeyId, record.noteIv, record.noteCiphertext, record.noteAuthTag,
    ];
    if (values.every((value) => value === null)) return null;
    if (values.some((value) => value === null)) throw new Error('TALENT_TOUCHPOINT_CIPHERTEXT_INVALID');
    const value = this.crypto.unprotect({
      tenantId: record.tenantId,
      resourceType: 'talent_touchpoint',
      resourceId: record.id,
    }, {
      keyId: record.noteKeyId,
      iv: record.noteIv,
      ciphertext: record.noteCiphertext,
      authTag: record.noteAuthTag,
    } as ProtectedRecruitmentData);
    if (
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      typeof (value as { note?: unknown }).note !== 'string'
    ) throw new Error('TALENT_TOUCHPOINT_CIPHERTEXT_INVALID');
    return (value as { note: string }).note;
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  private assertTenant(tenantId: string): void {
    if (tenantId !== this.tenantId()) throw new Error('人才服务触点仓储拒绝跨租户实体');
  }
}
