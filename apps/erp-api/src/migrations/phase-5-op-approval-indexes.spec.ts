import { describe, expect, it } from 'vitest';

import { buildPhaseFiveOpApprovalIndexManifest } from './phase-5-op-approval-indexes.js';

describe('Phase 5 OP 审批桥索引迁移', () => {
  it('生成四类集合的追加式索引清单', () => {
    const serialized = JSON.stringify(buildPhaseFiveOpApprovalIndexManifest());
    expect(serialized).toContain('op_approval_routes');
    expect(serialized).toContain('op_approval_request_inbox');
    expect(serialized).toContain('op_approval_bridges');
    expect(serialized).toContain('op_approval_result_deliveries');
    expect(serialized).toContain('expiresAt');
  });
});
