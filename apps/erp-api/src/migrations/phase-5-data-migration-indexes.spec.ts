import { describe, expect, it } from 'vitest';

import { buildPhaseFiveDataMigrationIndexManifest } from './phase-5-data-migration-indexes.js';

describe('Phase 5 数据迁移控制面索引', () => {
  it('运行、条目、来源映射与证据台账均进入追加式清单', () => {
    const serialized = JSON.stringify(buildPhaseFiveDataMigrationIndexManifest());
    expect(serialized).toContain('data_migration_runs');
    expect(serialized).toContain('data_migration_items');
    expect(serialized).toContain('data_migration_mappings');
    expect(serialized).toContain('data_migration_associations');
    expect(serialized).toContain('data_migration_attachments');
    expect(serialized).toContain('sourceRunId');
    expect(serialized).toContain('sourceRecordId');
    expect(serialized).toContain('processingStartedAt');
    expect(serialized).toContain('attempts');
  });
});
