import { describe, expect, it } from 'vitest';

import {
  DataMigrationAssociationRecordSchema,
  DataMigrationAttachmentRecordSchema,
  DataMigrationItemRecordSchema,
  DataMigrationMappingRecordSchema,
  DataMigrationRunRecordSchema,
} from './data-migration.schemas.js';

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
  });
});
