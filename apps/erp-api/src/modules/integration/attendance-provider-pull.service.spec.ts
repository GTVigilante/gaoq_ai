import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { AttendanceDataCryptoService } from '../attendance/persistence/attendance-data-crypto.service.js';
import type {
  AttendanceProviderPullInput,
  AttendanceProviderRegistry,
} from './attendance-provider.adapter.js';
import { AttendanceProviderPullService } from './attendance-provider-pull.service.js';
import { ATTENDANCE_PROVIDER_PULL_JOB, type AttendanceProviderJobData } from './attendance-provider.queue.js';
import type {
  AttendanceProviderEmployeeMappingDocument,
  AttendanceProviderInboxDocument,
  AttendanceProviderStateDocument,
} from './attendance-provider.schemas.js';

const STATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C1';
const MAPPING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4C2';

function query(value: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

afterEach(() => vi.useRealTimers());

describe('AttendanceProviderPullService', () => {
  it('扫描任务 ID 绑定 nextPollAt，完成任务不会阻断下一轮轮询', async () => {
    const firstDueAt = new Date('2026-07-22T00:00:00.000Z');
    const states = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ limit: () => query([{
          tenantId: 'tenant-001', id: STATE_ID, nextPollAt: firstDueAt,
        }]) }),
      }),
    };
    const queue = { getJob: vi.fn().mockResolvedValue(undefined), add: vi.fn().mockResolvedValue({}) };
    const service = new AttendanceProviderPullService(
      states as unknown as Model<AttendanceProviderStateDocument>,
      {} as Model<AttendanceProviderEmployeeMappingDocument>,
      {} as Model<AttendanceProviderInboxDocument>,
      new TenantContextService(), {} as AttendanceDataCryptoService,
      {} as AttendanceProviderRegistry,
      queue as unknown as Queue<AttendanceProviderJobData>,
    );

    await expect(service.enqueueDueStates()).resolves.toBe(1);

    expect(queue.add.mock.calls[0]?.[0]).toBe(ATTENDANCE_PROVIDER_PULL_JOB);
    expect(queue.add.mock.calls[0]?.[1]).toEqual({ tenantId: 'tenant-001', stateId: STATE_ID });
    const options = queue.add.mock.calls[0]?.[2] as { readonly jobId: string };
    expect(options.jobId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('按员工页和 20 人小批补拉，未完成员工页时不推进日期水位', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T03:00:00.000Z'));
    const state = {
      id: STATE_ID, tenantId: 'tenant-001', providerCode: 'feishu' as const,
      timeZone: 'Asia/Shanghai', status: 'active' as const,
      cursorKeyId: null, cursorIv: null, cursorCiphertext: null, cursorAuthTag: null,
      nextPollAt: new Date('2026-07-22T02:00:00.000Z'),
    };
    const findOneAndUpdate = vi.fn().mockReturnValue(query(state));
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const mappings = Array.from({ length: 101 }, () => ({
      id: MAPPING_ID, tenantId: 'tenant-001', providerCode: 'feishu', employeeId: 'employee-001',
      externalIdKeyId: 'key-001', externalIdIv: 'A'.repeat(16),
      externalIdCiphertext: 'A'.repeat(32), externalIdAuthTag: 'A'.repeat(22),
    }));
    const mappingModel = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ limit: () => query(mappings) }),
      }),
    };
    const pullBatch = vi.fn().mockResolvedValue([]);
    const protect = vi.fn().mockReturnValue({
      keyId: 'key-001', iv: 'A'.repeat(16), ciphertext: 'A'.repeat(32), authTag: 'A'.repeat(22),
    });
    const context = new TenantContextService();
    const service = new AttendanceProviderPullService(
      { findOneAndUpdate, updateOne } as unknown as Model<AttendanceProviderStateDocument>,
      mappingModel as unknown as Model<AttendanceProviderEmployeeMappingDocument>,
      {} as Model<AttendanceProviderInboxDocument>,
      context,
      {
        unprotect: vi.fn().mockReturnValue('external-user-001'), protect,
      } as unknown as AttendanceDataCryptoService,
      { adapter: vi.fn().mockReturnValue({ pullBatch }) } as unknown as AttendanceProviderRegistry,
      {} as Queue<AttendanceProviderJobData>,
    );

    const count = await context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' },
      actor: {
        tenantId: 'tenant-001', actorId: 'system:test', actorType: 'system_job',
        roleCodes: [], scopes: ['erp:attendance:provider:pull'], departmentIds: [], traceId: 'trace-001',
      },
    }, () => service.pullState(STATE_ID));

    expect(count).toBe(0);
    expect(pullBatch).toHaveBeenCalledTimes(5);
    const firstPull = pullBatch.mock.calls[0]?.[0] as AttendanceProviderPullInput;
    expect(firstPull.fromDate).toBe('2026-07-21');
    expect(firstPull.toDate).toBe('2026-07-22');
    expect(firstPull.externalEmployeeIds).toContain('external-user-001');
    const cursor = protect.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(cursor).toEqual({
      throughDate: '2026-07-21', windowToDate: '2026-07-22', employeeAfterId: MAPPING_ID,
    });
    const finalUpdate = updateOne.mock.calls[0]?.[1] as {
      readonly $set: { readonly nextPollAt: Date };
    };
    expect(finalUpdate.$set.nextPollAt.toISOString()).toBe('2026-07-22T03:00:01.000Z');
  });
});
