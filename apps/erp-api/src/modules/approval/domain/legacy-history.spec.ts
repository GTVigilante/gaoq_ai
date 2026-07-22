import { describe, expect, it } from 'vitest';

import { ApprovalDomainError } from './approval.errors.js';
import {
  createApprovalLegacyHistory,
  restoreApprovalLegacyHistory,
} from './legacy-history.js';

const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';

function input() {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4F2',
    tenantId: 'tenant-001',
    templateId: 'template-001',
    templateCode: 'LEGACY_EXPENSE',
    templateRevision: 2,
    initiatorEmployeeId: 'employee-001',
    outcome: 'approved' as const,
    completedAt: '2020-01-02T00:00:00.000Z',
    archivedAt: '2020-01-03T00:00:00.000Z',
    migrationEvidenceRef: `erp://data-migrations/runs/${RUN_ID}/attachments/legacy-history-001`,
    evidenceChecksum: 'a'.repeat(43),
  };
}

describe('ApprovalLegacyHistory', () => {
  it('只生成最小不可变历史索引且可从持久化边界恢复', () => {
    const history = createApprovalLegacyHistory(input(), new Date('2026-07-22T00:00:00.000Z'));
    expect(history).toEqual({
      ...input(),
      version: 1,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    expect(Object.isFrozen(history)).toBe(true);
    expect(restoreApprovalLegacyHistory(history)).toEqual(history);
    expect(history).not.toHaveProperty('formData');
    expect(history).not.toHaveProperty('title');
  });

  it('拒绝非迁移账本证据、错误摘要和被修改的时间戳', () => {
    expect(() => createApprovalLegacyHistory({
      ...input(), migrationEvidenceRef: 'worm://legacy/history-001',
    }, new Date())).toThrow(ApprovalDomainError);
    expect(() => createApprovalLegacyHistory({
      ...input(), evidenceChecksum: 'bad',
    }, new Date())).toThrow(ApprovalDomainError);
    const history = createApprovalLegacyHistory(input(), new Date('2026-07-22T00:00:00.000Z'));
    expect(() => restoreApprovalLegacyHistory({
      ...history, updatedAt: '2026-07-22T00:00:01.000Z',
    })).toThrowError(expect.objectContaining({ code: 'APPROVAL_HISTORY_INTEGRITY_INVALID' }));
  });
});
