import { describe, expect, it } from 'vitest';

import {
  buildPhaseOneIndexManifest,
  compareCollectionIndexes,
  type ExistingIndexDefinition,
  type PhaseOneIndexDefinition,
} from './phase-1-indexes.js';

describe('Phase 1 索引迁移清单', () => {
  it('覆盖全部 Phase 1 集合且集合内索引名唯一', () => {
    const manifest = buildPhaseOneIndexManifest();
    expect(manifest).toHaveLength(64);
    expect(new Set(manifest.map((index) => index.collection))).toHaveLength(19);
    expect(new Set(manifest.map((index) => `${index.collection}:${index.name}`))).toHaveLength(
      manifest.length,
    );
    expect(manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({
        collection: 'security_audit_events',
        name: 'tenantId_1_sequence_1',
        options: { unique: true },
      }),
      expect.objectContaining({
        collection: 'security_audit_anchor_receipts',
        name: 'tenantId_1_sequence_1',
        options: { unique: true },
      }),
      expect.objectContaining({
        collection: 'integration_org_employee_provisioning_requests',
        name: 'purgeAt_1',
        options: { expireAfterSeconds: 0 },
      }),
      expect.objectContaining({
        collection: 'identity_external_identities',
        name: 'tenantId_1_provider_1_externalTenantId_1_unionId_1',
        options: { unique: true },
      }),
      expect.objectContaining({
        collection: 'identity_external_identities',
        name: 'tenantId_1_provider_1_externalTenantId_1_loginOpenId_1',
        options: {
          unique: true,
          partialFilterExpression: { loginOpenId: { $type: 'string' } },
        },
      }),
    ]));
  });

  it('等价索引即使使用历史名称也视为已存在且不要求改名', () => {
    const expected = sampleIndex();
    const plan = compareCollectionIndexes([expected], [{
      name: 'legacy_name',
      key: expected.key,
      unique: true,
    }]);
    expect(plan).toEqual({ missing: [], conflicts: [] });
  });

  it('同名异键或同键异选项均失败关闭', () => {
    const expected = sampleIndex();
    const existing: ExistingIndexDefinition[] = [{
      name: expected.name,
      key: { tenantId: 1, employeeId: 1 },
      unique: true,
    }];
    expect(compareCollectionIndexes([expected], existing).conflicts).toHaveLength(1);
    expect(compareCollectionIndexes([expected], [{
      name: 'other_name',
      key: expected.key,
    }]).conflicts).toHaveLength(1);
  });

  it('未知的不同键索引保持不动，只计划缺失声明索引', () => {
    const expected = sampleIndex();
    const plan = compareCollectionIndexes([expected], [{
      name: 'manual_operations_index',
      key: { status: 1 },
    }]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.missing).toEqual([expected]);
  });
});

function sampleIndex(): PhaseOneIndexDefinition {
  return {
    collection: 'org_employees',
    name: 'tenantId_1_employeeNo_1',
    key: { tenantId: 1, employeeNo: 1 },
    options: { unique: true },
  };
}
