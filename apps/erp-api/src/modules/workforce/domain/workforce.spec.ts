import { describe, expect, it } from 'vitest';

import { assertLocalDate, createHrbpAssignment, createReportingLine } from './workforce.js';

const NOW = new Date('2026-08-09T08:00:00.000Z');

describe('workforce domain', () => {
  it('创建不可变直属汇报关系', () => {
    const value = createReportingLine({
      id: 'relation-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      managerEmployeeId: 'employee-002', effectiveFrom: '2026-08-01', effectiveTo: null,
    }, NOW);
    expect(value).toMatchObject({ version: 1, effectiveFrom: '2026-08-01' });
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('拒绝自汇报、非法日历日期和倒置区间', () => {
    expect(() => createReportingLine({
      id: 'relation-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      managerEmployeeId: 'employee-001', effectiveFrom: '2026-08-01', effectiveTo: null,
    }, NOW)).toThrow('WORKFORCE_REPORTING_SELF');
    expect(() => assertLocalDate('2026-02-30', 'as_of')).toThrow('WORKFORCE_AS_OF_INVALID');
    expect(() => createReportingLine({
      id: 'relation-002', tenantId: 'tenant-001', employeeId: 'employee-001',
      managerEmployeeId: 'employee-002', effectiveFrom: '2026-08-02', effectiveTo: '2026-08-01',
    }, NOW)).toThrow('WORKFORCE_EFFECTIVE_RANGE_INVALID');
  });

  it('HRBP 主备人员必须唯一且互斥', () => {
    const value = createHrbpAssignment({
      id: 'hrbp-001', tenantId: 'tenant-001', departmentId: 'department-001',
      primaryEmployeeId: 'employee-001', backupEmployeeIds: ['employee-002'],
      inheritToDescendants: true, effectiveFrom: '2026-08-01', effectiveTo: null,
    }, NOW);
    expect(value.backupEmployeeIds).toEqual(['employee-002']);
    expect(Object.isFrozen(value.backupEmployeeIds)).toBe(true);
    expect(() => createHrbpAssignment({
      id: 'hrbp-002', tenantId: 'tenant-001', departmentId: 'department-001',
      primaryEmployeeId: 'employee-001', backupEmployeeIds: ['employee-001'],
      inheritToDescendants: false, effectiveFrom: '2026-08-01', effectiveTo: null,
    }, NOW)).toThrow('WORKFORCE_HRBP_BACKUPS_INVALID');
  });
});
