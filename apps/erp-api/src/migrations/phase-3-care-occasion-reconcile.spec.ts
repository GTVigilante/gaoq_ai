import { describe, expect, it } from 'vitest';

import {
  buildDuplicateDeliveryEvidencePipeline,
  buildDuplicateNaturalKeyPipeline,
  buildInconsistentOccasionStatePipeline,
  buildOrphanPreferencePipeline,
  buildRecentMissingOccasionEventPipeline,
} from './phase-3-care-occasion-reconcile.js';

describe('Phase 3 关怀周年只读对账', () => {
  it('覆盖状态证据、自然键、送达证据和员工引用一致性', () => {
    expect(JSON.stringify(buildInconsistentOccasionStatePipeline())).toContain(
      'deliveryEvidenceId',
    );
    expect(JSON.stringify(buildDuplicateNaturalKeyPipeline())).toContain(
      'occurrenceYear',
    );
    expect(JSON.stringify(buildDuplicateDeliveryEvidencePipeline())).toContain(
      'deliveryEvidenceId',
    );
    expect(JSON.stringify(buildOrphanPreferencePipeline())).toContain('org_employees');
  });

  it('仅核对 Outbox TTL 窗口内终态并逐字匹配三类事件', () => {
    const pipeline = JSON.stringify(
      buildRecentMissingOccasionEventPipeline(new Date('2026-07-27T00:00:00.000Z')),
    );
    expect(pipeline).toContain('2026-06-28T00:00:00.000Z');
    expect(pipeline).toContain('cn.gaoq.erp.care.occasion.delivered.v1');
    expect(pipeline).toContain('cn.gaoq.erp.care.occasion.cancelled.v1');
    expect(pipeline).toContain('cn.gaoq.erp.care.occasion.dead.v1');
    expect(pipeline).toContain('aggregateVersion');
  });
});
