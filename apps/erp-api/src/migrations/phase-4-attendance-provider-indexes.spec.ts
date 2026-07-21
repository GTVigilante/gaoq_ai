import { describe, expect, it } from 'vitest';

import { buildPhaseFourAttendanceProviderIndexManifest } from './phase-4-attendance-provider-indexes.js';

describe('Phase 4 Attendance Provider 索引追加迁移', () => {
  it('独立覆盖同步状态、员工映射和加密 Inbox', () => {
    const collections = new Set(
      buildPhaseFourAttendanceProviderIndexManifest().map((item) => item.collection),
    );
    for (const name of [
      'integration_attendance_provider_states',
      'integration_attendance_employee_mappings',
      'integration_attendance_provider_inbox',
    ]) expect(collections.has(name)).toBe(true);
  });

  it('包含租户级 Provider、员工映射和事件去重唯一约束', () => {
    const manifest = buildPhaseFourAttendanceProviderIndexManifest();
    for (const [collection, field] of [
      ['integration_attendance_provider_states', 'providerCode'],
      ['integration_attendance_employee_mappings', 'employeeId'],
      ['integration_attendance_employee_mappings', 'externalIdBlindIndexes'],
      ['integration_attendance_provider_inbox', 'eventBlindIndexes'],
    ] as const) expect(manifest.some((item) =>
      item.collection === collection && item.key[field] === 1 && item.options.unique === true,
    )).toBe(true);
  });
});
