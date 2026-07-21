import type { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { CareExecutionQueueService } from './care-execution-queue.service.js';
import type { CareExecutionJobData } from './care-execution.queue.js';

afterEach(() => vi.useRealTimers());

describe('CareExecutionQueueService', () => {
  it('按租户与案件生成稳定 JobId，并延迟到权限失效时刻', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const context = new TenantContextService();
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const service = new CareExecutionQueueService(
      context, queue as unknown as Queue<CareExecutionJobData>,
    );
    const trusted = {
      tenant: { tenantId: 'tenant-001', source: 'service_identity' as const },
      actor: {
        actorId: 'worker', actorType: 'service' as const, tenantId: 'tenant-001',
        roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-001',
      },
    };
    await context.run(trusted, () => service.schedule({
      id: 'care-001', employeeId: 'employee-001', employmentId: 'employment-001',
      separationType: 'voluntary_resignation', reasonCode: 'PERSONAL_REASON',
      lastWorkingDate: '2026-07-31', accessDisableAt: '2026-07-31T10:00:00.000Z',
      status: 'scheduled', approvalInstanceId: 'approval-001', tasks: {
        handover_accepted: 'completed', assets_cleared: 'completed',
        finance_cleared: 'completed', data_retention_confirmed: 'completed',
      }, version: 8,
    }));
    expect(queue.add.mock.calls[0]?.[0]).toBe('execute:care:case');
    expect(queue.add.mock.calls[0]?.[1]).toEqual({
      tenantId: 'tenant-001', careCaseId: 'care-001',
    });
    const options = queue.add.mock.calls[0]?.[2] as {
      readonly jobId?: string;
      readonly delay?: number;
    } | undefined;
    expect(options?.jobId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options?.delay).toBe(900_000_000);
  });
});
