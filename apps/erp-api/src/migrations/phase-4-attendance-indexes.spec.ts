import { describe, expect, it } from 'vitest';

import { buildPhaseFourAttendanceIndexManifest } from './phase-4-attendance-indexes.js';

describe('Phase 4 Attendance 索引追加迁移', () => {
  it('覆盖源事实、审批修订和月结快照集合', () => {
    const collections = new Set(
      buildPhaseFourAttendanceIndexManifest().map((item) => item.collection),
    );
    for (const name of [
      'attendance_source_facts', 'attendance_corrections', 'attendance_monthly_snapshots',
    ]) expect(collections.has(name)).toBe(true);
  });

  it('包含外部事件、单事实修订、审批引用、版本和活动快照唯一约束', () => {
    const manifest = buildPhaseFourAttendanceIndexManifest();
    for (const [collection, field] of [
      ['attendance_source_facts', 'sourceEventBlindIndexes'],
      ['attendance_corrections', 'sourceFactId'],
      ['attendance_corrections', 'approvalInstanceId'],
      ['attendance_monthly_snapshots', 'snapshotVersion'],
    ] as const) expect(manifest.some((item) =>
      item.collection === collection && item.key[field] === 1 && item.options.unique === true,
    )).toBe(true);
    expect(manifest.some((item) =>
      item.collection === 'attendance_monthly_snapshots' && item.key.month === 1 &&
      item.options.unique === true && item.options.partialFilterExpression !== undefined,
    )).toBe(true);
    expect(manifest.some((item) => item.key.shiftPlanId === 1)).toBe(false);
  });
});
