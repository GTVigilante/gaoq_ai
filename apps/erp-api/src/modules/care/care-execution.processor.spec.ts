import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { CareApplicationService } from './application/care-application.service.js';
import type { CareOccasionApplicationService } from './application/care-occasion-application.service.js';
import type { CareAlumniCleanupApplicationService } from './application/care-alumni-cleanup-application.service.js';
import type { CareAlumniCleanupCoordinatorService } from './application/care-alumni-cleanup-coordinator.service.js';
import { CareExecutionProcessor } from './care-execution.processor.js';
import type { CareJobData } from './care-execution.queue.js';

describe('CareExecutionProcessor', () => {
  const occasions = {
    dispatchTask: vi.fn(),
    reconcileRegisteredTenants: vi.fn(),
  } as unknown as CareOccasionApplicationService;
  const alumniCleanup = {
    dispatchTask: vi.fn(),
  } as unknown as CareAlumniCleanupApplicationService;
  const alumniCoordinator = {
    relayBatch: vi.fn(),
    reconcileAndEnqueue: vi.fn(),
  } as unknown as CareAlumniCleanupCoordinatorService;

  it('只从队列数据建立可信系统身份，不接受数据内 Scope 或执行参数', async () => {
    const context = new TenantContextService();
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const executeScheduledJob = vi.fn().mockImplementation(() => {
      const trusted = context.getRequired();
      expect(trusted.tenant.tenantId).toBe('tenant-001');
      expect(trusted.actor.scopes).toEqual([
        'erp:care:execution:run', 'erp:care:employment:terminate',
      ]);
      return Promise.resolve({
        careCase: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4C1', status: 'completed',
          lastWorkingDate: '2026-07-20', version: 10,
        },
      });
    });
    const processor = new CareExecutionProcessor(
      context, { executeScheduledJob } as unknown as CareApplicationService,
      audit as unknown as AuditService,
      occasions,
      alumniCleanup,
      alumniCoordinator,
    );
    const job = {
      id: 'job-001', name: 'execute:care:case',
      data: { tenantId: 'tenant-001', careCaseId: '01J8ZQK7V0A2M4N6P8R0T2W4C1' },
    } as Job<CareJobData>;
    await expect(processor.process(job)).resolves.toBe(1);
    expect(executeScheduledJob).toHaveBeenCalledWith(
      '01J8ZQK7V0A2M4N6P8R0T2W4C1', 'care-job-job-001',
    );
    expect(audit.record).toHaveBeenCalledWith({
      action: 'care.case.execute', resourceType: 'care_case',
      resourceId: '01J8ZQK7V0A2M4N6P8R0T2W4C1', riskLevel: 'R3', outcome: 'success',
      metadata: { status: 'completed', lastWorkingDate: '2026-07-20', version: 10 },
    });
  });

  it('拒绝未知任务与非严格队列数据', async () => {
    const processor = new CareExecutionProcessor(
      new TenantContextService(),
      { executeScheduledJob: vi.fn() } as unknown as CareApplicationService,
      { record: vi.fn() } as unknown as AuditService,
      occasions,
      alumniCleanup,
      alumniCoordinator,
    );
    await expect(processor.process({
      name: 'unknown', data: {},
    } as Job<CareJobData>)).rejects.toThrow('CARE_EXECUTION_JOB_UNKNOWN');
    await expect(processor.process({
      name: 'execute:care:case', data: { tenantId: 'tenant-001', careCaseId: 'not-ulid' },
    } as Job<CareJobData>)).rejects.toThrow();
  });

  it('R3 执行失败记录白名单错误码并保留原异常', async () => {
    const context = new TenantContextService();
    const failure = Object.assign(new Error('上游可能含敏感响应'), {
      response: { code: 'CARE_VERSION_CONFLICT' },
    });
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const processor = new CareExecutionProcessor(
      context,
      { executeScheduledJob: vi.fn().mockRejectedValue(failure) } as unknown as CareApplicationService,
      audit as unknown as AuditService,
      occasions,
      alumniCleanup,
      alumniCoordinator,
    );
    const job = {
      id: 'job-002', name: 'execute:care:case',
      data: { tenantId: 'tenant-001', careCaseId: '01J8ZQK7V0A2M4N6P8R0T2W4C1' },
    } as Job<CareJobData>;
    await expect(processor.process(job)).rejects.toBe(failure);
    expect(audit.record).toHaveBeenCalledWith({
      action: 'care.case.execute', resourceType: 'care_case',
      resourceId: '01J8ZQK7V0A2M4N6P8R0T2W4C1', riskLevel: 'R3', outcome: 'failure',
      metadata: { failureCode: 'CARE_VERSION_CONFLICT' },
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('上游可能含敏感响应');
  });

  it('授权到期任务只建立最小系统身份并写入脱敏成功审计', async () => {
    const context = new TenantContextService();
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const expireAlumniConsent = vi.fn().mockImplementation(() => {
      const trusted = context.getRequired();
      expect(trusted.tenant.tenantId).toBe('tenant-001');
      expect(trusted.actor.scopes).toEqual(['erp:care:alumni:consent:expire']);
      return Promise.resolve({
        consent: {
          id: '01J8ZQK7V0A2M4N6P8R0T2W4C4', status: 'expired',
          expiresAt: '2027-07-21T00:00:00.000Z', version: 2,
        },
      });
    });
    const processor = new CareExecutionProcessor(
      context, { expireAlumniConsent } as unknown as CareApplicationService,
      audit as unknown as AuditService,
      occasions,
      alumniCleanup,
      alumniCoordinator,
    );
    await expect(processor.process({
      id: 'job-expiry-001', name: 'expire:care:alumni-consent',
      data: {
        tenantId: 'tenant-001',
        consentId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
      },
    } as Job<CareJobData>)).resolves.toBe(1);
    expect(expireAlumniConsent).toHaveBeenCalledWith('01J8ZQK7V0A2M4N6P8R0T2W4C4');
    expect(audit.record).toHaveBeenCalledWith({
      action: 'care.alumni_consent.expire', resourceType: 'care_alumni_consent',
      resourceId: '01J8ZQK7V0A2M4N6P8R0T2W4C4', riskLevel: 'R1', outcome: 'success',
      metadata: {
        status: 'expired', expiresAt: '2027-07-21T00:00:00.000Z', version: 2,
      },
    });
  });

  it('成功审计故障不被误记为业务失败', async () => {
    const auditFailure = new Error('AUDIT_UNAVAILABLE');
    const audit = { record: vi.fn().mockRejectedValue(auditFailure) };
    const processor = new CareExecutionProcessor(
      new TenantContextService(),
      {
        executeScheduledJob: vi.fn().mockResolvedValue({
          careCase: {
            id: '01J8ZQK7V0A2M4N6P8R0T2W4C1', status: 'completed',
            lastWorkingDate: '2026-07-20', version: 10,
          },
        }),
      } as unknown as CareApplicationService,
      audit as unknown as AuditService,
      occasions,
      alumniCleanup,
      alumniCoordinator,
    );
    await expect(processor.process({
      id: 'job-audit-001', name: 'execute:care:case',
      data: {
        tenantId: 'tenant-001',
        careCaseId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
      },
    } as Job<CareJobData>)).rejects.toBe(auditFailure);
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
      action: 'care.case.execute', outcome: 'success',
    });
  });

  it('关怀 Worker 只从最小队列数据建立可信身份并写脱敏终态审计', async () => {
    const context = new TenantContextService();
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const dispatchTask = vi.fn().mockImplementation(() => {
      const trusted = context.getRequired();
      expect(trusted.actor.scopes).toEqual([
        'erp:care:occasion:dispatch',
        'erp:care:occasion:source:read',
      ]);
      return Promise.resolve({
        id: 'care-task-001',
        occasionType: 'birthday',
        status: 'delivered',
        attempts: 1,
        version: 3,
      });
    });
    const processor = new CareExecutionProcessor(
      context,
      {} as CareApplicationService,
      audit as unknown as AuditService,
      {
        dispatchTask,
        reconcileRegisteredTenants: vi.fn(),
      } as unknown as CareOccasionApplicationService,
      alumniCleanup,
      alumniCoordinator,
    );
    const data = {
      tenantId: 'tenant-001',
      occasionTaskId: 'care-task-001',
    };
    await expect(processor.process({
      id: 'occasion-job-001',
      name: 'dispatch:care:occasion',
      data,
    } as Job<CareJobData>)).resolves.toBe(1);
    expect(dispatchTask).toHaveBeenCalledWith('care-task-001', 'occasion-job-001');
    expect(JSON.stringify(data)).not.toMatch(
      /employee|birthdayMonthDay|contact|template|body|evidence/iu,
    );
    expect(audit.record).toHaveBeenCalledWith({
      action: 'care.occasion.dispatch',
      resourceType: 'care_occasion_task',
      resourceId: 'care-task-001',
      riskLevel: 'R1',
      outcome: 'success',
      metadata: {
        occasionType: 'birthday',
        status: 'delivered',
        attempts: 1,
        version: 3,
      },
    });
    await expect(processor.process({
      name: 'dispatch:care:occasion',
      data: { ...data, preferredChannels: ['sms'] },
    } as unknown as Job<CareJobData>)).rejects.toThrow();
  });

  it('关怀周期对账只接受空载荷，禁止队列指定租户或员工范围', async () => {
    const reconcileRegisteredTenants = vi.fn().mockResolvedValue(2);
    const processor = new CareExecutionProcessor(
      new TenantContextService(),
      {} as CareApplicationService,
      { record: vi.fn() } as unknown as AuditService,
      {
        dispatchTask: vi.fn(),
        reconcileRegisteredTenants,
      } as unknown as CareOccasionApplicationService,
      alumniCleanup,
      alumniCoordinator,
    );
    await expect(processor.process({
      name: 'reconcile:care:occasions',
      data: {},
    } as Job<CareJobData>)).resolves.toBe(2);
    await expect(processor.process({
      name: 'reconcile:care:occasions',
      data: { tenantId: 'tenant-spoofed' },
    } as unknown as Job<CareJobData>)).rejects.toThrow();
    expect(reconcileRegisteredTenants).toHaveBeenCalledOnce();
  });

  it('校友清理投递使用最小可信身份，relay 与对账拒绝任何队列范围参数', async () => {
    const context = new TenantContextService();
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const dispatchTask = vi.fn().mockImplementation(() => {
      expect(context.getActorRequired().scopes).toEqual([
        'erp:care:alumni:cleanup:dispatch',
      ]);
      return Promise.resolve({
        id: 'A'.repeat(43),
        targetCode: 'crm',
        policyVersion: 'privacy-v1',
        status: 'completed',
        attempts: 1,
        version: 3,
      });
    });
    const relayBatch = vi.fn().mockResolvedValue(2);
    const reconcileAndEnqueue = vi.fn().mockResolvedValue(3);
    const processor = new CareExecutionProcessor(
      context,
      {} as CareApplicationService,
      audit as unknown as AuditService,
      occasions,
      { dispatchTask } as unknown as CareAlumniCleanupApplicationService,
      {
        relayBatch,
        reconcileAndEnqueue,
      } as unknown as CareAlumniCleanupCoordinatorService,
    );
    const data = { tenantId: 'tenant-001', cleanupTaskId: 'A'.repeat(43) };
    await expect(processor.process({
      id: 'cleanup-job-001',
      name: 'dispatch:care:alumni-cleanup',
      data,
    } as Job<CareJobData>)).resolves.toBe(1);
    expect(dispatchTask).toHaveBeenCalledWith(
      'A'.repeat(43),
      'care-cleanup:cleanup-job-001',
    );
    expect(JSON.stringify(data)).not.toMatch(/consent|purpose|proof|contact/iu);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'care.alumni_cleanup.dispatch',
      resourceType: 'care_alumni_cleanup_task',
      riskLevel: 'R2',
      outcome: 'success',
    }));
    await expect(processor.process({
      id: 'relay-job-001',
      name: 'relay:care:alumni-cleanup',
      data: {},
    } as Job<CareJobData>)).resolves.toBe(2);
    await expect(processor.process({
      id: 'reconcile-job-001',
      name: 'reconcile:care:alumni-cleanup',
      data: {},
    } as Job<CareJobData>)).resolves.toBe(3);
    await expect(processor.process({
      name: 'relay:care:alumni-cleanup',
      data: { tenantId: 'tenant-spoofed' },
    } as unknown as Job<CareJobData>)).rejects.toThrow();
  });
});
