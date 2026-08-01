import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Connection, Model } from 'mongoose';
import { z } from 'zod';

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
const migrationInputSchema = z.object({
  targetId: z.string().regex(ULID).nullable(),
  ownerType: z.enum(BUSINESS_ATTACHMENT_OWNER_TYPES),
  ownerId: z.string().regex(ID),
  purpose: z.enum(BUSINESS_ATTACHMENT_PURPOSES),
  uploadedByEmployeeId: z.string().regex(ID).nullable(),
  businessCreatedAt: z.string(),
  migrationEvidenceRef: z.string().regex(MIGRATION_REF),
  evidenceChecksum: z.string().regex(HASH),
}).strict().refine(
  (value) => BUSINESS_ATTACHMENT_OWNER_BY_PURPOSE[value.purpose] ===
    value.ownerType,
);
const migrationReceiptSchema = z.object({
  tenantId: z.string().regex(ID),
  runId: z.string().regex(ULID),
  sourceAttachmentId: z.string().regex(ID),
  checksum: z.string().regex(HASH),
  targetEvidenceId: z.string().regex(OBJECT_ID),
}).strict();
const storedAttachmentSchema = z.object({
  id: z.string().regex(ULID),
  tenantId: z.string().regex(ID),
  ownerType: z.enum(BUSINESS_ATTACHMENT_OWNER_TYPES),
  ownerId: z.string().regex(ID),
  purpose: z.enum(BUSINESS_ATTACHMENT_PURPOSES),
  uploadedByEmployeeId: z.string().regex(ID).nullable(),
  businessCreatedAt: z.date(),
  contentChecksum: z.string().regex(HASH),
  migrationEvidenceRef: z.string().regex(MIGRATION_REF),
  migrationEvidenceChecksum: z.string().regex(HASH),
  objectEvidenceId: z.string().regex(OBJECT_ID).nullable(),
  availableAt: z.date().nullable(),
  status: z.enum(['migration_pending', 'available']),
  version: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.date(),
  updatedAt: z.date(),
}).strict().refine(
  (value) =>
    BUSINESS_ATTACHMENT_OWNER_BY_PURPOSE[value.purpose] === value.ownerType &&
    value.contentChecksum === value.migrationEvidenceChecksum &&
    (
      value.status === 'migration_pending'
        ? value.version === 1 &&
          value.objectEvidenceId === null &&
          value.availableAt === null
        : value.version === 2 &&
          value.objectEvidenceId !== null &&
          value.availableAt !== null
    ),
);
const ATTACHMENT_PROJECTION = Object.freeze({
  id: 1,
  tenantId: 1,
  ownerType: 1,
  ownerId: 1,
  purpose: 1,
  uploadedByEmployeeId: 1,
  businessCreatedAt: 1,
  contentChecksum: 1,
  migrationEvidenceRef: 1,
  migrationEvidenceChecksum: 1,
  objectEvidenceId: 1,
  availableAt: 1,
  status: 1,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  _id: 0,
} as const);
type StoredAttachment = z.infer<typeof storedAttachmentSchema>;

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
    const validated = assertMigrationInput(input);
    const tenantId = this.tenantId();
    return this.idempotency.execute(
      'business.attachment.import_from_migration',
      key,
      validated,
      async (session) => {
        const existing = await this.records.findOne({
          tenantId,
          migrationEvidenceRef: validated.migrationEvidenceRef,
        }, ATTACHMENT_PROJECTION).session(session).lean().exec();
        if (existing !== null) {
          const stored = assertStoredAttachment(
            existing,
            tenantId,
            validated.migrationEvidenceRef,
          );
          assertReplay(stored, validated);
          return summary(stored);
        }
        if (validated.targetId !== null) throw immutableConflict();
        const businessCreatedAt = strictInstant(validated.businessCreatedAt);
        const id = createEventId(businessCreatedAt);
        const record: BusinessAttachmentRecord = {
          id,
          tenantId,
          ownerType: validated.ownerType,
          ownerId: validated.ownerId,
          purpose: validated.purpose,
          uploadedByEmployeeId: validated.uploadedByEmployeeId,
          businessCreatedAt,
          contentChecksum: validated.evidenceChecksum,
          migrationEvidenceRef: validated.migrationEvidenceRef,
          migrationEvidenceChecksum: validated.evidenceChecksum,
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
    const receipt = migrationReceiptSchema.safeParse({
      tenantId,
      runId,
      sourceAttachmentId,
      checksum,
      targetEvidenceId,
    });
    if (!receipt.success) {
      throw new Error('BUSINESS_ATTACHMENT_MIGRATION_RECEIPT_INVALID');
    }
    const migrationEvidenceRef =
      `erp://data-migrations/runs/${receipt.data.runId}/attachments/` +
      receipt.data.sourceAttachmentId;
    return this.connection.transaction(async (session) => {
      const found = await this.records.findOne({
        tenantId: receipt.data.tenantId,
        migrationEvidenceRef,
      }, ATTACHMENT_PROJECTION).session(session).lean().exec();
      if (found === null) return false;
      const record = assertStoredAttachment(
        found,
        receipt.data.tenantId,
        migrationEvidenceRef,
      );
      if (record.contentChecksum !== receipt.data.checksum) {
        throw new Error('BUSINESS_ATTACHMENT_MIGRATION_CHECKSUM_MISMATCH');
      }
      if (record.status === 'available') {
        if (record.objectEvidenceId !== receipt.data.targetEvidenceId) {
          throw new Error('BUSINESS_ATTACHMENT_MIGRATION_IMMUTABLE');
        }
        return true;
      }
      const now = new Date();
      const updated = await this.records.updateOne({
        tenantId: receipt.data.tenantId,
        id: record.id,
        status: 'migration_pending',
        version: 1,
      }, { $set: {
        status: 'available',
        version: 2,
        objectEvidenceId: receipt.data.targetEvidenceId,
        availableAt: now,
      } }, { session, runValidators: true });
      if (updated.modifiedCount !== 1) throw new Error('BUSINESS_ATTACHMENT_MIGRATION_CONFLICT');
      await this.outbox.migrated(record, receipt.data.runId, now, session);
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

function assertMigrationInput(
  input: ImportBusinessAttachmentFromMigrationInput,
): z.infer<typeof migrationInputSchema> {
  const parsed = migrationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'BUSINESS_ATTACHMENT_MIGRATION_INPUT_INVALID',
      message: '业务附件迁移输入非法',
    });
  }
  strictInstant(parsed.data.businessCreatedAt);
  return parsed.data;
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
  record: StoredAttachment,
  input: z.infer<typeof migrationInputSchema>,
): void {
  if ((input.targetId !== null && input.targetId !== record.id) ||
    record.ownerType !== input.ownerType ||
    record.ownerId !== input.ownerId || record.purpose !== input.purpose ||
    record.uploadedByEmployeeId !== input.uploadedByEmployeeId ||
    record.businessCreatedAt.toISOString() !== input.businessCreatedAt ||
    record.contentChecksum !== input.evidenceChecksum ||
    record.migrationEvidenceChecksum !== input.evidenceChecksum) throw immutableConflict();
}

function assertStoredAttachment(
  value: unknown,
  tenantId: string,
  migrationEvidenceRef: string,
): StoredAttachment {
  const parsed = storedAttachmentSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.tenantId !== tenantId ||
    parsed.data.migrationEvidenceRef !== migrationEvidenceRef
  ) throw new Error('BUSINESS_ATTACHMENT_MIGRATION_STATE_INVALID');
  return Object.freeze(parsed.data);
}

function immutableConflict(): ConflictException {
  return new ConflictException({
    code: 'BUSINESS_ATTACHMENT_MIGRATION_IMMUTABLE',
    message: '既有业务附件与来源快照不一致，禁止覆盖',
  });
}

function summary(record: BusinessAttachmentRecord | StoredAttachment): BusinessAttachmentSummary {
  return Object.freeze({
    id: record.id, ownerType: record.ownerType, ownerId: record.ownerId,
    purpose: record.purpose, status: record.status, version: record.version,
  });
}
