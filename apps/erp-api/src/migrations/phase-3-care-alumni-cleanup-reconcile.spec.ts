import { describe, expect, it } from 'vitest';

import {
  buildDuplicateCleanupNaturalKeyPipeline,
  buildInconsistentCleanupStatePipeline,
  buildMissingCleanupTargetCoveragePipeline,
  buildRecentMissingCleanupEventPipeline,
} from './phase-3-care-alumni-cleanup-reconcile.js';

describe('Phase 3 校友清理只读对账', () => {
  it('状态组合检查要求 dispatching 完整锁和 completed 完整不可变证明', () => {
    const serialized = JSON.stringify(buildInconsistentCleanupStatePipeline());
    expect(serialized).toContain('dispatching');
    expect(serialized).toContain('completed');
    expect(serialized).toContain('proofDigest');
    expect(serialized).toContain('immutable_worm');
    expect(serialized).toContain('append_only_ledger');
  });

  it('自然键同时绑定租户、授权版本、目的和登记目标', () => {
    const serialized = JSON.stringify(buildDuplicateCleanupNaturalKeyPipeline());
    for (const field of [
      'tenantId',
      'consentId',
      'consentVersion',
      'consentPurpose',
      'targetCode',
      'policyVersion',
    ]) expect(serialized).toContain(field);
  });

  it('覆盖检查绑定当前登记目标与政策版本', () => {
    const serialized = JSON.stringify(buildMissingCleanupTargetCoveragePipeline([
      { targetCode: 'crm', policyVersion: 'privacy-v1' },
      { targetCode: 'notify', policyVersion: 'privacy-v2' },
    ]));
    expect(serialized).toContain('crm:privacy-v1');
    expect(serialized).toContain('notify:privacy-v2');
    expect(serialized).toContain('care_alumni_cleanup_tasks');
  });

  it('终态事件检查逐字匹配 completed/dead v1 契约', () => {
    const serialized = JSON.stringify(
      buildRecentMissingCleanupEventPipeline(
        new Date('2026-07-27T00:00:00.000Z'),
      ),
    );
    expect(serialized).toContain('cn.gaoq.erp.care.alumni_cleanup.completed.v1');
    expect(serialized).toContain('cn.gaoq.erp.care.alumni_cleanup.dead.v1');
  });
});
