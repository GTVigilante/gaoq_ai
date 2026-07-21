import { describe, expect, it } from 'vitest';

import { buildPhaseThreeRecruitmentChannelIndexManifest } from './phase-3-recruitment-channel-indexes.js';

describe('Phase 3 招聘渠道索引迁移', () => {
  it('使用独立不可变清单保护绑定、去重和外部映射唯一性', () => {
    const manifest = buildPhaseThreeRecruitmentChannelIndexManifest();
    const collections = new Set(manifest.map((item) => item.collection));
    expect(collections).toEqual(new Set([
      'integration_recruitment_channel_bindings',
      'integration_external_mappings',
      'integration_recruitment_channel_inbox',
      'integration_recruitment_channel_position_deliveries',
      'integration_recruitment_channel_stage_deliveries',
    ]));
    const inbox = manifest.find((item) =>
      item.collection === 'integration_recruitment_channel_inbox' &&
      item.key.eventBlindIndexes === 1);
    expect(inbox?.key).toEqual({ tenantId: 1, channelCode: 1, eventBlindIndexes: 1 });
    expect(inbox?.options.unique).toBe(true);
    const mappings = manifest.find((item) =>
      item.collection === 'integration_external_mappings' &&
      item.key.externalIdBlindIndexes === 1);
    expect(mappings?.key).toEqual({
      tenantId: 1, channelCode: 1, entityType: 1, externalIdBlindIndexes: 1,
    });
    expect(mappings?.options.unique).toBe(true);
  });
});
