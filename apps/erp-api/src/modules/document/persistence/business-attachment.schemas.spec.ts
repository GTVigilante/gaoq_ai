import { model } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  BusinessAttachmentRecordSchema,
} from './business-attachment.schemas.js';

const Attachment = model('BusinessAttachmentSchemaSpec', BusinessAttachmentRecordSchema);

function record() {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', tenantId: 'tenant-001',
    ownerType: 'recruitment.candidate', ownerId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
    purpose: 'candidate_resume', uploadedByEmployeeId: null,
    businessCreatedAt: new Date('2026-07-22T09:00:00.000Z'),
    contentChecksum: 'r'.repeat(43),
    migrationEvidenceRef:
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/resume-001',
    migrationEvidenceChecksum: 'r'.repeat(43), objectEvidenceId: null,
    availableAt: null, status: 'migration_pending', version: 1,
  };
}

describe('BusinessAttachmentRecordSchema', () => {
  it('以租户前缀唯一约束附件和迁移证据', () => {
    expect(BusinessAttachmentRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, id: 1 }, { unique: true },
    ]);
    expect(BusinessAttachmentRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, migrationEvidenceRef: 1 }, { unique: true },
    ]);
    for (const field of ['fileName', 'originalName', 'content', 'sourceCredential']) {
      expect(BusinessAttachmentRecordSchema.path(field)).toBeUndefined();
    }
  });

  it('可用状态必须同时持有对象证据和激活时间', async () => {
    await new Attachment(record()).validate();
    await expect(new Attachment({ ...record(), status: 'available' }).validate())
      .rejects.toThrow('取得对象证据');
    await expect(new Attachment({
      ...record(), contentChecksum: 'x'.repeat(43),
    }).validate()).rejects.toThrow('内容摘要');
  });
});
