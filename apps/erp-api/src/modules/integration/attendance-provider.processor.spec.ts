import { createHash } from 'node:crypto';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { AttendanceApplicationService } from '../attendance/application/attendance-application.service.js';
import type { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import type { Job } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AttendanceProviderRegistry } from './attendance-provider.adapter.js';
import type { AttendanceProviderPullService } from './attendance-provider-pull.service.js';
import { AttendanceProviderProcessor } from './attendance-provider.processor.js';
import {
  ATTENDANCE_PROVIDER_PROCESS_JOB,
  type AttendanceProviderJobData,
} from './attendance-provider.queue.js';
import type {
  AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderInboxDocument,
  AttendanceProviderStateDocument,
} from './attendance-provider.schemas.js';

const STATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const INBOX_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C2';
const FACT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C3';
const requestId = 'provider-request-001';
const requestFingerprint = createHash('sha256')
  .update(JSON.stringify(['request', requestId]), 'utf8').digest('base64url');

function query(value: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function assemble(mapping = [{ employeeId: 'employee-001' }]) {
  const claimed = {
    id: INBOX_ID, tenantId: 'tenant-001', stateId: STATE_ID, providerCode: 'feishu' as const,
    eventBlindIndexes: ['key.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    providerOccurredAt: new Date(), payloadKeyId: 'key-001', payloadIv: 'A'.repeat(16),
    payloadCiphertext: 'A'.repeat(32), payloadAuthTag: 'A'.repeat(22),
    transportRequestIdFingerprint: requestFingerprint,
    status: 'processing' as const, attempts: 1, processingStartedAt: new Date(),
    processedAt: null, failureCode: null, normalizerVersion: null,
    evidenceVerifiedAt: null, sourceFactId: null,
  };
  const inboxUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const inbox = {
    findOneAndUpdate: vi.fn().mockReturnValue(query(claimed)), updateOne: inboxUpdateOne,
  };
  const states = {
    findOne: vi.fn().mockReturnValue(query({
      id: STATE_ID, tenantId: 'tenant-001', providerCode: 'feishu',
      timeZone: 'Asia/Shanghai', status: 'active',
    })),
  };
  const mappings = {
    find: vi.fn().mockReturnValue({
      limit: () => ({ lean: () => ({ exec: () => Promise.resolve(mapping) }) }),
    }),
  };
  const attendanceIngest = vi.fn().mockResolvedValue({ fact: { id: FACT_ID } });
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const processor = new AttendanceProviderProcessor(
    states as unknown as Model<AttendanceProviderStateDocument>,
    mappings as unknown as Model<AttendanceProviderEmployeeMappingDocument>,
    inbox as unknown as Model<AttendanceProviderInboxDocument>,
    new TenantContextService(),
    { record: auditRecord } as unknown as AuditService,
    { enqueueDueStates: vi.fn(), pullState: vi.fn() } as unknown as AttendanceProviderPullService,
    { ingest: attendanceIngest } as unknown as AttendanceApplicationService,
    {
      unprotect: vi.fn().mockReturnValue({ payload: { record: 'raw' }, transportRequestId: requestId }),
      providerFingerprints: vi.fn().mockReturnValue(['blind.employee']),
    } as unknown as AttendanceDataCryptoService,
    {
      verifier: vi.fn().mockReturnValue({ verify: vi.fn().mockReturnValue(true) }),
      normalizer: vi.fn().mockReturnValue({
        schemaVersion: 'feishu-user-task-v1',
        normalize: vi.fn().mockReturnValue({
          externalEmployeeId: 'external-user-001', externalEventId: 'flow-001',
          factType: 'punch_in', occurredAt: '2026-07-22T01:00:00.000Z',
          timeZone: 'Asia/Shanghai',
          impact: { workedMinutes: 0, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
          sourceObservedAt: '2026-07-22T01:01:00.000Z',
        }),
      }),
    } as unknown as AttendanceProviderRegistry,
  );
  const job = {
    name: ATTENDANCE_PROVIDER_PROCESS_JOB,
    data: { tenantId: 'tenant-001', inboxId: INBOX_ID },
  } as Job<AttendanceProviderJobData>;
  return { processor, job, attendanceIngest, inboxUpdateOne, auditRecord };
}

describe('AttendanceProviderProcessor', () => {
  it('在可信系统上下文中通过应用服务写入事实并提交 Inbox 检查点', async () => {
    const fixture = assemble();

    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);

    expect(fixture.attendanceIngest).toHaveBeenCalledWith(
      expect.stringMatching(/^attendance-provider-/),
      expect.objectContaining({
        employeeId: 'employee-001', providerCode: 'feishu',
        externalEventId: 'flow-001', factType: 'punch_in',
      }),
    );
    const completed = fixture.inboxUpdateOne.mock.calls.map((call) => call[1] as {
      readonly $set: Record<string, unknown>;
    }).find((update) => update.$set.status === 'completed');
    if (completed === undefined) throw new Error('缺少完成态更新');
    expect(completed.$set).toMatchObject({
      status: 'completed', sourceFactId: FACT_ID, normalizerVersion: 'feishu-user-task-v1',
    });
    expect(fixture.auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.attendance_provider.fact.ingest', outcome: 'success',
    }));
  });

  it('未知外部员工进入人工复核且不触达 Attendance 应用服务', async () => {
    const fixture = assemble([]);

    await expect(fixture.processor.process(fixture.job)).resolves.toBe(1);

    expect(fixture.attendanceIngest).not.toHaveBeenCalled();
    const reviewed = fixture.inboxUpdateOne.mock.calls.map((call) => call[1] as {
      readonly $set: Record<string, unknown>;
    }).find((update) => update.$set.status === 'manual_review');
    if (reviewed === undefined) throw new Error('缺少人工复核更新');
    expect(reviewed.$set).toMatchObject({
      status: 'manual_review', failureCode: 'ATTENDANCE_PROVIDER_EMPLOYEE_UNBOUND',
    });
  });
});
