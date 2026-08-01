import { describe, expect, it } from 'vitest';
import {
  buildPhaseFiveMarketingCmsIndexManifest,
} from './phase-5-marketing-cms-indexes.js';

describe('Phase 5 Marketing CMS 索引迁移', () => {
  it('覆盖 CMS 全部集合及副作用 Outbox 的幂等与轮询索引', () => {
    const manifest = buildPhaseFiveMarketingCmsIndexManifest();
    expect(new Set(manifest.map((item) => item.collection))).toEqual(new Set([
      'marketing_contents',
      'marketing_content_revisions',
      'marketing_leads',
      'marketing_media',
      'marketing_ai_generations',
      'marketing_side_effect_outbox',
    ]));
    const outboxUnique = manifest.find((item) =>
      item.collection === 'marketing_side_effect_outbox' &&
      item.key.aggregateVersion === 1);
    expect(outboxUnique?.key).toEqual({
      tenantId: 1,
      kind: 1,
      aggregateId: 1,
      aggregateVersion: 1,
      channel: 1,
    });
    expect(outboxUnique?.options.unique).toBe(true);
    expect(manifest).toContainEqual(expect.objectContaining({
      collection: 'marketing_side_effect_outbox',
      key: { status: 1, nextAttemptAt: 1, createdAt: 1 },
    }));
    expect(manifest).toContainEqual(expect.objectContaining({
      collection: 'marketing_side_effect_outbox',
      key: { kind: 1, status: 1, dueAt: 1 },
    }));
  });
});
