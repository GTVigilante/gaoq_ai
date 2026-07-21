import { describe, expect, it } from 'vitest';

import { compareCollectionIndexes } from './phase-1-indexes.js';
import { buildPhaseTwoIndexManifest } from './phase-2-indexes.js';

describe('Phase 2 索引迁移清单', () => {
  it('覆盖审批、通知、MCP 确认和 WebAuthn 八个集合且名称唯一', () => {
    const manifest = buildPhaseTwoIndexManifest();
    expect(new Set(manifest.map((index) => index.collection))).toEqual(new Set([
      'approval_templates',
      'approval_instances',
      'approval_actions',
      'approval_delegations',
      'approval_notification_deliveries',
      'mcp_operation_confirmations',
      'identity_webauthn_credentials',
      'identity_webauthn_ceremonies',
    ]));
    expect(new Set(manifest.map((index) => `${index.collection}:${index.name}`)).size)
      .toBe(manifest.length);
    expect(manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({
        collection: 'approval_instances',
        name: 'tenantId_1_id_1',
        options: { unique: true },
      }),
      expect.objectContaining({
        collection: 'approval_notification_deliveries',
        name: 'tenantId_1_instanceId_1_aggregateVersion_1_eventType_1_recipientActorId_1_channel_1',
        options: { unique: true },
      }),
      expect.objectContaining({
        collection: 'mcp_operation_confirmations',
        name: 'expiresAt_1',
        options: { expireAfterSeconds: 86_400 },
      }),
    ]));
  });

  it('空数据库全部计划为缺失，冲突配置则失败关闭', () => {
    const manifest = buildPhaseTwoIndexManifest();
    expect(compareCollectionIndexes(manifest, []).missing).toHaveLength(manifest.length);
    const first = manifest[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(compareCollectionIndexes([first], [{
      name: first.name,
      key: { wrong: 1 },
    }]).conflicts).toHaveLength(1);
  });
});
