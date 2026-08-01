import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { BusinessAttachmentOutboxWriter } from './business-attachment-outbox.writer.js';

describe('BusinessAttachmentOutboxWriter', () => {
  it('业务附件迁移事件只公开归属与状态控制字段', async () => {
    const create = vi.fn().mockResolvedValue([]);
    const writer = new BusinessAttachmentOutboxWriter({ create } as never);
    await writer.migrated({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', tenantId: 'tenant-001',
      ownerType: 'recruitment.candidate', ownerId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
      purpose: 'candidate_resume', uploadedByEmployeeId: 'employee-recruiter',
      businessCreatedAt: new Date('2026-07-22T09:00:00.000Z'),
      contentChecksum: 'r'.repeat(43),
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/resume-001',
      migrationEvidenceChecksum: 'r'.repeat(43),
      objectEvidenceId: null, availableAt: null, status: 'migration_pending', version: 1,
      createdAt: new Date(), updatedAt: new Date(),
    }, '01J8ZQK7V0A2M4N6P8R0T2W4F1', new Date('2026-07-22T10:00:00.000Z'),
    {} as ClientSession);
    const persisted = JSON.stringify(create.mock.calls);
    expect(persisted).toContain('business.attachment.migrated.v1');
    expect(persisted).not.toMatch(
      /migrationEvidence|checksum|objectEvidence|resume-001|employee-recruiter|fileName/u,
    );
  });
});
