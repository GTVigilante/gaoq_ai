import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { restoreAttendanceSourceFactFromMigration } from '../domain/index.js';
import { AttendanceDataCryptoService } from './attendance-data-crypto.service.js';
import { AttendanceSourceFactRepository } from './attendance.repositories.js';
import type { AttendanceSourceFactDocument } from './attendance.schemas.js';

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
});
