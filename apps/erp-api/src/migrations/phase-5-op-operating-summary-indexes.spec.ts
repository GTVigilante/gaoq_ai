import { describe, expect, it } from 'vitest';

import { buildPhaseFiveOpOperatingSummaryIndexManifest } from './phase-5-op-operating-summary-indexes.js';

describe('Phase 5 OP 经营摘要索引迁移', () => {
  it('仅生成追加式索引清单并包含三类 OP 集合', () => {
    const manifest = buildPhaseFiveOpOperatingSummaryIndexManifest();
    const serialized = JSON.stringify(manifest);
    expect(serialized).toContain('op_client_bindings');
    expect(serialized).toContain('op_operating_summary_inbox');
    expect(serialized).toContain('op_operating_summaries');
    expect(serialized).toContain('expiresAt');
  });
});
