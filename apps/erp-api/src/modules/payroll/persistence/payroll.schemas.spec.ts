import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  PayrollCompensationProfileRecordSchema,
  PayrollPeriodRecordSchema,
  PayrollRulePackRecordSchema,
  type PayrollCompensationProfileRecord,
} from './payroll.schemas.js';

const mongoose = new Mongoose();
const ProfileModel = mongoose.model<PayrollCompensationProfileRecord>(
  'SpecPayrollCompensationProfile', PayrollCompensationProfileRecordSchema,
);

describe('Payroll 持久化契约', () => {
  it('薪酬档案不保存金额明文，并要求完整独立密文', async () => {
    const document = new ProfileModel({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', tenantId: 'tenant-001',
      employeeId: 'employee-001', version: 1, effectiveFrom: '2026-01-01',
      effectiveTo: null, approvalEvidenceId: 'approval-001', status: 'active',
      profileHash: 'a'.repeat(43), dataKeyId: 'payroll-key-001', dataIv: 'b'.repeat(16),
      dataCiphertext: 'c'.repeat(32), dataAuthTag: 'd'.repeat(22),
    });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).not.toHaveProperty('baseSalaryMinor');
    await expect(new ProfileModel({ ...document.toObject(), dataAuthTag: '' }).validate())
      .rejects.toThrow(/dataAuthTag/);
  });

  it('规则、周期与薪酬版本唯一约束均包含租户前缀', () => {
    expect(PayrollRulePackRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [{ tenantId: 1, code: 1, version: 1 }, expect.objectContaining({ unique: true })],
      [
        { tenantId: 1, jurisdictionCode: 1, version: 1 },
        expect.objectContaining({ unique: true }),
      ],
    ]));
    expect(PayrollCompensationProfileRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, employeeId: 1, version: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(PayrollPeriodRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, period: 1 }, expect.objectContaining({ unique: true }),
    ]);
  });
});
