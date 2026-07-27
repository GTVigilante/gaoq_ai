import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { CareApplicationService } from './application/care-application.service.js';
import { CareExecutionProcessor } from './care-execution.processor.js';
import type { CareJobData } from './care-execution.queue.js';

describe('CareExecutionProcessor', () => {
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
});
