import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Connection, Model } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  BUSINESS_ATTACHMENT_OWNER_TYPES,
  BUSINESS_ATTACHMENT_OWNER_BY_PURPOSE,
  BUSINESS_ATTACHMENT_PURPOSES,
  BusinessAttachmentRecord,
  type BusinessAttachmentDocument,
  type BusinessAttachmentOwnerType,
  type BusinessAttachmentPurpose,
} from '../persistence/business-attachment.schemas.js';
import { BusinessAttachmentOutboxWriter } from '../persistence/business-attachment-outbox.writer.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MIGRATION_REF =
  /^erp:\/\/data-migrations\/runs\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/attachments\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

export interface ImportBusinessAttachmentFromMigrationInput {
  readonly targetId: string | null;
  readonly ownerType: BusinessAttachmentOwnerType;
  readonly ownerId: string;
  readonly purpose: BusinessAttachmentPurpose;
  readonly uploadedByEmployeeId: string | null;
  readonly businessCreatedAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface BusinessAttachmentSummary extends Record<string, unknown> {
  readonly id: string;
  readonly ownerType: BusinessAttachmentOwnerType;
  readonly ownerId: string;
  readonly purpose: BusinessAttachmentPurpose;
  readonly status: 'migration_pending' | 'available';
  readonly version: number;
}

/** 通用业务附件应用服务：迁移登记与网关回执激活严格分离。 */
@Injectable()
export class BusinessAttachmentService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(BusinessAttachmentRecord.name)
    private readonly records: Model<BusinessAttachmentDocument>,
    private readonly outbox: BusinessAttachmentOutboxWriter,
  ) {}

  async importFromMigration(
    key: string,
    input: ImportBusinessAttachmentFromMigrationInput,
  ): Promise<BusinessAttachmentSummary> {
    this.assertMigrationWriter();
    assertMigrationInput(input);
    return this.idempotency.execute(
      'business.attachment.import_from_migration', key, input, async (session) => {
        const existing = await this.records.findOne({
          tenantId: this.tenantId(), migrationEvidenceRef: input.migrationEvidenceRef,
        }).session(session).lean().exec();
        if (existing !== null) {
          assertReplay(existing, input);
          return summary(existing);
        }
        if (input.targetId !== null) throw immutableConflict();
        const id = createEventId(strictInstant(input.businessCreatedAt));
        const record: BusinessAttachmentRecord = {
          id, tenantId: this.tenantId(), ownerType: input.ownerType, ownerId: input.ownerId,
          purpose: input.purpose, uploadedByEmployeeId: input.uploadedByEmployeeId,
          businessCreatedAt: strictInstant(input.businessCreatedAt),
          contentChecksum: input.evidenceChecksum,
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
          objectEvidenceId: null, availableAt: null,
          status: 'migration_pending', version: 1,
          createdAt: new Date(), updatedAt: new Date(),
        };
        await this.records.create([record], { session });
        return summary(record);
      },
    );
  }

  /**
   * 仅由隔离迁移附件 Worker 调用。对象回执与可用状态、Outbox 在 Mongo 事务内提交。
   */
  async finalizeMigration(
    tenantId: string,
    runId: string,
    sourceAttachmentId: string,
    checksum: string,
    targetEvidenceId: string,
  ): Promise<boolean> {
    if (!ID.test(tenantId) || !ULID.test(runId) || !ID.test(sourceAttachmentId) ||
      !HASH.test(checksum) || !OBJECT_ID.test(targetEvidenceId)) {
      throw new Error('BUSINESS_ATTACHMENT_MIGRATION_RECEIPT_INVALID');
    }
    const migrationEvidenceRef =
      `erp://data-migrations/runs/${runId}/attachments/${sourceAttachmentId}`;
    return this.connection.transaction(async (session) => {
      const record = await this.records.findOne({ tenantId, migrationEvidenceRef })
        .session(session).lean().exec();
      if (record === null) return false;
      if (record.contentChecksum !== checksum || record.migrationEvidenceChecksum !== checksum) {
        throw new Error('BUSINESS_ATTACHMENT_MIGRATION_CHECKSUM_MISMATCH');
      }
      if (record.status === 'available') {
        if (record.objectEvidenceId !== targetEvidenceId || record.availableAt === null ||
          record.version !== 2) throw new Error('BUSINESS_ATTACHMENT_MIGRATION_IMMUTABLE');
        return true;
      }
      const now = new Date();
      const updated = await this.records.updateOne({
        tenantId, id: record.id, status: 'migration_pending', version: 1,
      }, { $set: {
        status: 'available', version: 2, objectEvidenceId: targetEvidenceId, availableAt: now,
      } }, { session, runValidators: true });
      if (updated.modifiedCount !== 1) throw new Error('BUSINESS_ATTACHMENT_MIGRATION_CONFLICT');
      await this.outbox.migrated(record, runId, now, session);
      return true;
    });
  }

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:document:migration:write')) {
      throw new ForbiddenException({
        code: 'BUSINESS_ATTACHMENT_MIGRATION_WRITER_DENIED',
        message: '业务附件迁移必须由受信任服务身份执行',
      });
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function assertMigrationInput(input: ImportBusinessAttachmentFromMigrationInput): void {
  if (Object.keys(input).sort().join(',') !==
      'businessCreatedAt,evidenceChecksum,migrationEvidenceRef,ownerId,ownerType,purpose,targetId,uploadedByEmployeeId' ||
    (input.targetId !== null && !ULID.test(input.targetId)) || !ID.test(input.ownerId) ||
    !BUSINESS_ATTACHMENT_OWNER_TYPES.includes(input.ownerType) ||
    !BUSINESS_ATTACHMENT_PURPOSES.includes(input.purpose) ||
    BUSINESS_ATTACHMENT_OWNER_BY_PURPOSE[input.purpose] !== input.ownerType ||
    (input.uploadedByEmployeeId !== null && !ID.test(input.uploadedByEmployeeId)) ||
    !MIGRATION_REF.test(input.migrationEvidenceRef) || !HASH.test(input.evidenceChecksum)) {
    throw new BadRequestException({
      code: 'BUSINESS_ATTACHMENT_MIGRATION_INPUT_INVALID',
      message: '业务附件迁移输入非法',
    });
  }
  strictInstant(input.businessCreatedAt);
}

function strictInstant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value ||
    parsed.getTime() > Date.now() + 5 * 60_000) {
    throw new BadRequestException({
      code: 'BUSINESS_ATTACHMENT_MIGRATION_INPUT_INVALID',
      message: '业务附件历史时间非法',
    });
  }
  return parsed;
}

function assertReplay(
  record: BusinessAttachmentRecord,
  input: ImportBusinessAttachmentFromMigrationInput,
): void {
  if ((input.targetId !== null && input.targetId !== record.id) ||
    record.ownerType !== input.ownerType ||
    record.ownerId !== input.ownerId || record.purpose !== input.purpose ||
    record.uploadedByEmployeeId !== input.uploadedByEmployeeId ||
    record.businessCreatedAt.toISOString() !== input.businessCreatedAt ||
    record.contentChecksum !== input.evidenceChecksum ||
    record.migrationEvidenceChecksum !== input.evidenceChecksum) throw immutableConflict();
}

function immutableConflict(): ConflictException {
  return new ConflictException({
    code: 'BUSINESS_ATTACHMENT_MIGRATION_IMMUTABLE',
    message: '既有业务附件与来源快照不一致，禁止覆盖',
  });
}

function summary(record: BusinessAttachmentRecord): BusinessAttachmentSummary {
  return Object.freeze({
    id: record.id, ownerType: record.ownerType, ownerId: record.ownerId,
    purpose: record.purpose, status: record.status, version: record.version,
  });
}
