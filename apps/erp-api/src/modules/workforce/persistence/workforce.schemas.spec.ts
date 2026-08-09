import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  HrbpAssignmentRecordSchema,
  ReportingLineRecordSchema,
  type HrbpAssignmentRecord,
  type ReportingLineRecord,
} from './workforce.schemas.js';

const mongoose = new Mongoose();
const ReportingModel = mongoose.model<ReportingLineRecord>('SpecWorkforceReportingLine', ReportingLineRecordSchema);
const HrbpModel = mongoose.model<HrbpAssignmentRecord>('SpecWorkforceHrbp', HrbpAssignmentRecordSchema);

describe('workforce schemas', () => {
  it('持久化边界拒绝自汇报与非法日期区间', async () => {
    const base = {
      id: 'relation-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      managerEmployeeId: 'employee-002', effectiveFrom: '2026-08-01', effectiveTo: null,
      version: 1,
    };
    await expect(new ReportingModel(base).validate()).resolves.toBeUndefined();
    await expect(new ReportingModel({ ...base, managerEmployeeId: 'employee-001' }).validate()).rejects.toThrow('WORKFORCE_REPORTING_INVARIANT_INVALID');
    await expect(new ReportingModel({ ...base, effectiveFrom: '2026-02-30' }).validate()).rejects.toThrow('WORKFORCE_REPORTING_INVARIANT_INVALID');
  });

  it('持久化边界拒绝 HRBP 主备人员重复', async () => {
    const base = {
      id: 'hrbp-001', tenantId: 'tenant-001', departmentId: 'department-001',
      primaryEmployeeId: 'employee-001', backupEmployeeIds: ['employee-002'],
      inheritToDescendants: true, effectiveFrom: '2026-08-01', effectiveTo: null,
      version: 1,
    };
    await expect(new HrbpModel(base).validate()).resolves.toBeUndefined();
    await expect(new HrbpModel({ ...base, backupEmployeeIds: ['employee-001'] }).validate()).rejects.toThrow('WORKFORCE_HRBP_INVARIANT_INVALID');
  });
});
