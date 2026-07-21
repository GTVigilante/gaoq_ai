import { describe, expect, it } from 'vitest';

import { buildPhaseFourPayrollCoreIndexManifest } from './phase-4-payroll-core-indexes.js';

describe('Phase 4 Payroll Core 索引追加迁移', () => {
  it('覆盖规则、薪酬版本、周期、运行和员工级密文快照', () => {
    const collections = new Set(
      buildPhaseFourPayrollCoreIndexManifest().map((item) => item.collection),
    );
    for (const name of [
      'payroll_rule_packs', 'payroll_compensation_profiles', 'payroll_periods',
      'payroll_calculation_runs', 'payroll_input_snapshots', 'payroll_calculation_lines',
    ]) expect(collections.has(name)).toBe(true);
  });

  it('包含租户周期、规则版本、运行序号和员工行唯一约束', () => {
    const manifest = buildPhaseFourPayrollCoreIndexManifest();
    for (const [collection, field] of [
      ['payroll_periods', 'period'],
      ['payroll_rule_packs', 'version'],
      ['payroll_calculation_runs', 'runNumber'],
      ['payroll_input_snapshots', 'employeeId'],
      ['payroll_calculation_lines', 'employeeId'],
    ] as const) expect(manifest.some((item) =>
      item.collection === collection && item.key.tenantId === 1 &&
      item.key[field] === 1 && item.options.unique === true,
    )).toBe(true);
  });
});
