import { model } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  DataMigrationAssociationRecordSchema,
  DataMigrationAttachmentRecordSchema,
  DataMigrationItemRecordSchema,
  DataMigrationMappingRecordSchema,
  DataMigrationRunRecordSchema,
} from './data-migration.schemas.js';
import {
  DATA_MIGRATION_ENTITY_TYPES,
  DATA_MIGRATION_SCOPES,
} from '../data-migration-contract.js';

describe('数据迁移账本 Schema', () => {
  it('运行、条目、来源映射与证据台账均以可信租户建立唯一键', () => {
    expect(DataMigrationRunRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, sourceSystem: 1, sourceRunId: 1 }, { unique: true },
    ]);
    expect(DataMigrationItemRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, runId: 1, sequence: 1 }, { unique: true },
    ]);
    expect(DataMigrationMappingRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, sourceSystem: 1, entityType: 1, sourceRecordId: 1 }, { unique: true },
    ]);
    expect(DataMigrationAssociationRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, runId: 1, sequence: 1, relationship: 1, sourceAssociationId: 1 },
      { unique: true },
    ]);
    expect(DataMigrationAttachmentRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, runId: 1, sourceAttachmentId: 1 }, { unique: true },
    ]);
    expect(DataMigrationAttachmentRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, runId: 1, sequence: 1, sourceAttachmentId: 1 }, {},
    ]);
  });

  it('条目与映射只存校验和和目标引用，不落来源正文或附件内容', () => {
    expect(DataMigrationItemRecordSchema.path('payload')).toBeUndefined();
    expect(DataMigrationItemRecordSchema.path('attachmentContent')).toBeUndefined();
    expect(DataMigrationMappingRecordSchema.path('payload')).toBeUndefined();
    expect(DataMigrationAttachmentRecordSchema.path('attachmentContent')).toBeUndefined();
    expect(DataMigrationItemRecordSchema.path('payloadHash')).toBeDefined();
    expect(DataMigrationItemRecordSchema.path('sourceFactHash')).toBeDefined();
    expect(DataMigrationItemRecordSchema.path('targetHash')).toBeDefined();
    expect(DataMigrationAttachmentRecordSchema.path('checksum')).toBeDefined();
    expect(DataMigrationAttachmentRecordSchema.path('attempts')).toBeDefined();
    expect(DataMigrationAttachmentRecordSchema.path('processingStartedAt')).toBeDefined();
  });

  it('运行、条目与映射复用统一迁移白名单', () => {
    expect(DataMigrationRunRecordSchema.path('scope').options.enum).toEqual(
      DATA_MIGRATION_SCOPES,
    );
    expect(DataMigrationItemRecordSchema.path('entityType').options.enum).toEqual(
      DATA_MIGRATION_ENTITY_TYPES,
    );
    expect(DataMigrationMappingRecordSchema.path('entityType').options.enum).toEqual(
      DATA_MIGRATION_ENTITY_TYPES,
    );
    expect(DataMigrationAssociationRecordSchema.path('relationship').options.enum)
      .toContain('employee');
    expect(DataMigrationAssociationRecordSchema.path('relationship').options.enum)
      .toContain('approved_by');
    expect(DataMigrationAssociationRecordSchema.path('relationship').options.enum)
      .toContain('application');
    expect(DataMigrationAssociationRecordSchema.path('relationship').options.enum)
      .toContain('interviewer');
    expect(DataMigrationAssociationRecordSchema.path('relationship').options.enum)
      .toContain('interview');
  });

  it('附件 processing、verified、rejected 状态必须分别绑定租约或证据', async () => {
    const Attachment = model(
      'DataMigrationAttachmentValidationSpec', DataMigrationAttachmentRecordSchema,
    );
    const base = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F2', tenantId: 'tenant-001',
      runId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', sequence: 1,
      sourceAttachmentId: 'legacy-file-001', checksum: 'c'.repeat(43), attempts: 1,
      processingStartedAt: null, targetEvidenceId: null, rejectionCode: null,
    };
    await expect(new Attachment({ ...base, status: 'processing' }).validate())
      .rejects.toThrow('processingStartedAt');
    await expect(new Attachment({ ...base, status: 'verified' }).validate())
      .rejects.toThrow('targetEvidenceId');
    await expect(new Attachment({ ...base, status: 'rejected' }).validate())
      .rejects.toThrow('rejectionCode');
  });
});
