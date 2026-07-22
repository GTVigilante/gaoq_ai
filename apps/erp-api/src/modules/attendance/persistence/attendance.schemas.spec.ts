import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  AttendanceCorrectionRecordSchema,
  AttendanceMonthlySnapshotRecordSchema,
  AttendanceSourceFactRecordSchema,
  type AttendanceSourceFactRecord,
} from './attendance.schemas.js';

const mongoose = new Mongoose();
const FactModel = mongoose.model<AttendanceSourceFactRecord>(
  'SpecAttendanceSourceFact', AttendanceSourceFactRecordSchema,
);

describe('Attendance 持久化契约', () => {
  it('源事实不保存外部事件明文，并约束事实类型、业务日期和完整密文', async () => {
    const valid = {
      id: 'fact-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      providerCode: 'dingtalk', factType: 'shift', businessDate: '2026-04-01',
      sourceObservedAt: new Date('2026-04-01T00:01:00.000Z'),
      sourceEventBlindIndexes: [`blind-001.${'a'.repeat(43)}`],
      dataKeyId: 'key-001', dataIv: 'a'.repeat(16), dataCiphertext: 'b'.repeat(32),
      dataAuthTag: 'c'.repeat(22),
    };
    const document = new FactModel(valid);
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).not.toHaveProperty('externalEventId');
    await expect(new FactModel({ ...valid, factType: 'free_text' }).validate())
      .rejects.toThrow(/factType/);
    await expect(new FactModel({ ...valid, businessDate: '2026/04/01' }).validate())
      .rejects.toThrow(/businessDate/);
    await expect(new FactModel({
      ...valid,
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/attendance-001',
      migrationEvidenceChecksum: 'd'.repeat(43),
    }).validate()).resolves.toBeUndefined();
    await expect(new FactModel({
      ...valid,
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/attendance-001',
      migrationEvidenceChecksum: null,
    }).validate()).rejects.toThrow('必须成对出现');
  });

  it('外部事件、单事实修订、审批实例、活动快照和版本链均有唯一约束', () => {
    expect(AttendanceSourceFactRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, sourceEventBlindIndexes: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(AttendanceSourceFactRecordSchema.indexes()).toContainEqual([
      { tenantId: 1, migrationEvidenceRef: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(AttendanceCorrectionRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [{ tenantId: 1, sourceFactId: 1 }, expect.objectContaining({ unique: true })],
      [{ tenantId: 1, approvalInstanceId: 1 }, expect.objectContaining({ unique: true })],
    ]));
    expect(AttendanceMonthlySnapshotRecordSchema.indexes()).toEqual(expect.arrayContaining([
      [
        { tenantId: 1, employeeId: 1, month: 1, snapshotVersion: 1 },
        expect.objectContaining({ unique: true }),
      ],
      [
        { tenantId: 1, employeeId: 1, month: 1 },
        expect.objectContaining({ unique: true, partialFilterExpression: { status: 'active' } }),
      ],
      [
        { tenantId: 1, previousSnapshotId: 1 },
        expect.objectContaining({ unique: true }),
      ],
    ]));
  });
});
