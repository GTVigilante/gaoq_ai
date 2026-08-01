import { describe, expect, it } from 'vitest';

import { buildPhaseFiveBusinessAttachmentMigrationIndexManifest } from
  './phase-5-business-attachment-migration-indexes.js';

describe('Phase 5 业务附件迁移索引 v1', () => {
  it('清单只为新业务附件集合建立租户前缀索引', () => {
    const manifest = buildPhaseFiveBusinessAttachmentMigrationIndexManifest();
    expect(manifest.length).toBeGreaterThanOrEqual(4);
    expect(new Set(manifest.map((index) => index.collection)))
      .toEqual(new Set(['business_attachments']));
    expect(manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { tenantId: 1, id: 1 }, options: { unique: true } }),
      expect.objectContaining({
        key: { tenantId: 1, migrationEvidenceRef: 1 }, options: { unique: true },
      }),
    ]));
  });
});
