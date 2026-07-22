import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  restoreAttendanceCorrectionFromMigration,
  restoreAttendanceMonthFromMigration,
  restoreAttendanceSourceFactFromMigration,
} from '../domain/index.js';
import { AttendanceDataCryptoService } from './attendance-data-crypto.service.js';
import {
  AttendanceCorrectionRepository,
  AttendanceMonthlySnapshotRepository,
  AttendanceSourceFactRepository,
} from './attendance.repositories.js';
import type {
  AttendanceCorrectionDocument,
  AttendanceMonthlySnapshotDocument,
  AttendanceSourceFactDocument,
} from './attendance.schemas.js';

function crypto(): AttendanceDataCryptoService {
  return new AttendanceDataCryptoService(new ConfigService<AppEnvironment, true>({
    ATTENDANCE_DATA_ENCRYPTION_KEYS: JSON.stringify({
      activeKeyId: 'attendance-key-001',
      keys: [{
        keyId: 'attendance-key-001', keyBase64url: randomBytes(32).toString('base64url'),
        status: 'active',
      }],
    }),
    ATTENDANCE_BLIND_INDEX_KEYS: JSON.stringify({
      activeKeyId: 'attendance-blind-001',
      keys: [{
        keyId: 'attendance-blind-001', keyBase64url: randomBytes(32).toString('base64url'),
        status: 'active',
      }],
    }),
  } as AppEnvironment));
}

function context(): TenantContextService {
  return {
    getTenantRequired: vi.fn().mockReturnValue({ tenantId: 'tenant-001' }),
  } as unknown as TenantContextService;
}

describe('AttendanceSourceFactRepository', () => {
  it('迁移源事实只把密文、盲索引和 WORM 控制字段交给 Mongo', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const repository = new AttendanceSourceFactRepository(
      context(), { create } as unknown as Model<AttendanceSourceFactDocument>, crypto(),
    );
    const fact = restoreAttendanceSourceFactFromMigration({
      id: 'fact-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      providerCode: 'legacy_hr', factType: 'shift',
      occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai',
      impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
      sourceObservedAt: '2026-04-01T01:01:00.000Z',
      createdAt: '2026-04-01T01:02:00.000Z',
    }, new Date('2026-04-02T00:00:00.000Z'));
    await repository.insertMigrated(
      fact, ['attendance-blind-001.digest'],
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/attendance-001',
      'd'.repeat(43), { id: 'session' } as never,
    );
    const records = create.mock.calls[0]?.[0] as unknown as readonly Record<string, unknown>[];
    expect(records[0]).toMatchObject({
      sourceEventBlindIndexes: ['attendance-blind-001.digest'],
      migrationEvidenceChecksum: 'd'.repeat(43), dataKeyId: 'attendance-key-001',
    });
    expect(JSON.stringify(records)).not.toMatch(
      /workedMinutes|480|Asia\/Shanghai|2026-04-01T01:00:00/iu,
    );
  });

  it('迁移修订只把密文和 WORM 控制字段交给 Mongo', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const repository = new AttendanceCorrectionRepository(
      context(), { create } as unknown as Model<AttendanceCorrectionDocument>, crypto(),
    );
    const correction = restoreAttendanceCorrectionFromMigration({
      id: 'correction-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      sourceFactId: 'fact-legacy-001', businessDate: '2026-04-01',
      replacementImpact: {
        workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'LEGACY_APPROVED', approvalReferenceType: 'legacy_history',
      approvalInstanceId: null, approvalHistoryId: 'approval-history-001',
      approvalEvidenceId: 'approval-history-001', approvedAt: '2026-04-01T02:00:00.000Z',
      createdAt: '2026-04-01T02:01:00.000Z',
    }, new Date('2026-04-02T00:00:00.000Z'));
    await repository.insertMigrated(
      correction,
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/correction-001',
      'd'.repeat(43), { id: 'session' } as never,
    );
    const records = create.mock.calls[0]?.[0] as unknown as readonly Record<string, unknown>[];
    expect(records[0]).toMatchObject({
      approvalReferenceType: 'legacy_history', approvalInstanceId: null,
      approvalHistoryId: 'approval-history-001', migrationEvidenceChecksum: 'd'.repeat(43),
      dataKeyId: 'attendance-key-001',
    });
    expect(JSON.stringify(records)).not.toMatch(/workedMinutes|420|LEGACY_APPROVED/iu);
  });

  it('迁移月结加密逐日明细并保存 WORM 控制字段', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const repository = new AttendanceMonthlySnapshotRepository(
      context(), { create } as unknown as Model<AttendanceMonthlySnapshotDocument>, crypto(),
    );
    const fact = restoreAttendanceSourceFactFromMigration({
      id: 'fact-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      providerCode: 'legacy_hr', factType: 'shift',
      occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai',
      impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
      sourceObservedAt: '2026-04-01T01:01:00.000Z',
      createdAt: '2026-04-01T01:02:00.000Z',
    }, new Date('2026-04-02T00:00:00.000Z'));
    const snapshot = restoreAttendanceMonthFromMigration({
      id: 'snapshot-legacy-001', tenantId: 'tenant-001', employeeId: 'employee-001',
      month: '2026-04', snapshotVersion: 1, rulesetVersion: 'legacy-cn-v1',
      sourceCutoffAt: '2026-04-02T00:00:00.000Z', facts: [fact], corrections: [],
      previousSnapshotId: null, supersessionEvidenceId: null,
      closedAt: '2026-04-02T00:01:00.000Z',
    }, new Date('2026-04-03T00:00:00.000Z'));
    await repository.activateMigrated(
      snapshot, null,
      'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/month-001',
      'm'.repeat(43), { id: 'session' } as never,
    );
    const records = create.mock.calls[0]?.[0] as unknown as readonly Record<string, unknown>[];
    expect(records[0]).toMatchObject({
      migrationEvidenceChecksum: 'm'.repeat(43), dataKeyId: 'attendance-key-001',
      workedMinutes: 480,
    });
    expect(JSON.stringify(records)).not.toContain('dailySummaries');
  });
});
