import { describe, expect, it } from 'vitest';

import { buildPhaseFiveApprovalHistoryIndexManifest } from
  './phase-5-approval-history-indexes.js';

describe('Phase 5 旧审批历史索引', () => {
  it('为租户隔离、证据幂等和模板时间检索建立追加式索引', () => {
    const serialized = JSON.stringify(buildPhaseFiveApprovalHistoryIndexManifest());
    expect(serialized).toContain('approval_legacy_histories');
    expect(serialized).toContain('tenantId');
    expect(serialized).toContain('migrationEvidenceRef');
    expect(serialized).toContain('templateCode');
    expect(serialized).toContain('completedAt');
  });
});
