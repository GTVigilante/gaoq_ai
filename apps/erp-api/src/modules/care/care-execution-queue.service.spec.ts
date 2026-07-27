import type { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { CareExecutionQueueService } from './care-execution-queue.service.js';
import type { CareJobData } from './care-execution.queue.js';

afterEach(() => vi.useRealTimers());

describe('CareExecutionQueueService', () => {
  it('按租户与案件生成稳定 JobId，并延迟到权限失效时刻', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const context = new TenantContextService();
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const service = new CareExecutionQueueService(
      context, queue as unknown as Queue<CareJobData>,
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

  it('按租户与授权生成稳定 JobId，并延迟到授权到期时刻', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const context = new TenantContextService();
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const service = new CareExecutionQueueService(
      context, queue as unknown as Queue<CareJobData>,
    );
    await context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' },
      actor: {
        actorId: 'service', actorType: 'service', tenantId: 'tenant-001',
        roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-001',
      },
    }, () => service.scheduleAlumniConsentExpiry({
      id: '01J8ZQK7V0A2M4N6P8R0T2W4C4', careCaseId: 'care-001',
      purpose: 'alumni_network', channels: ['email'],
      grantedAt: '2026-07-21T00:00:00.000Z',
      expiresAt: '2027-07-21T00:00:00.000Z',
      status: 'active', version: 1,
    }));
    expect(queue.add.mock.calls[0]?.[0]).toBe('expire:care:alumni-consent');
    expect(queue.add.mock.calls[0]?.[1]).toEqual({
      tenantId: 'tenant-001',
      consentId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
    });
    const options = queue.add.mock.calls[0]?.[2] as {
      readonly jobId?: string;
      readonly delay?: number;
    } | undefined;
    expect(options?.jobId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(options?.delay).toBe(365 * 24 * 60 * 60 * 1_000);
  });

  it('关怀投递队列只携带可信租户与任务标识，并注册空载荷周期对账', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
    const context = new TenantContextService();
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const service = new CareExecutionQueueService(
      context,
      queue as unknown as Queue<CareJobData>,
    );
    await context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' },
      actor: {
        actorId: 'system:care', actorType: 'system_job', tenantId: 'tenant-001',
        roleCodes: [], scopes: [], departmentIds: [], traceId: 'trace-001',
      },
    }, () => service.scheduleOccasion({
      id: 'care-task-001',
      tenantId: 'tenant-001',
      personId: 'person-001',
      employeeId: 'employee-001',
      employmentId: 'employment-001',
      occasionType: 'birthday',
      occurrenceYear: 2026,
      scheduledAt: '2026-07-27T01:00:00.000Z',
      templateCode: 'CARE_BIRTHDAY_V1',
      policyVersion: 'care-v1',
      preferredChannels: ['feishu'],
      sourceDigest: 's'.repeat(43),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: '2026-07-27T01:00:00.000Z',
      lockedAt: null,
      lockedBy: null,
      denialCode: null,
      deliveryEvidenceId: null,
      deliveredAt: null,
      version: 1,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    }));
    expect(queue.add.mock.calls[0]?.slice(0, 2)).toEqual([
      'dispatch:care:occasion',
      { tenantId: 'tenant-001', occasionTaskId: 'care-task-001' },
    ]);
    expect(JSON.stringify(queue.add.mock.calls[0]?.[1])).not.toMatch(
      /employee|person|birthday|contact|template|body|evidence/iu,
    );
    await service.ensureOccasionReconcileSchedule();
    expect(queue.add.mock.calls[1]?.[0]).toBe('reconcile:care:occasions');
    expect(queue.add.mock.calls[1]?.[1]).toEqual({});
    expect(queue.add.mock.calls[1]?.[2]).toMatchObject({
      jobId: 'care-occasion-reconcile-v1',
      repeat: { every: 900_000 },
    });
  });
});
