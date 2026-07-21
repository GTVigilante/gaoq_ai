import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { CareApplicationService } from './application/care-application.service.js';
import { CareExecutionProcessor } from './care-execution.processor.js';
import type { CareExecutionJobData } from './care-execution.queue.js';

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
    } as Job<CareExecutionJobData>;
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
    } as Job<CareExecutionJobData>)).rejects.toThrow('CARE_EXECUTION_JOB_UNKNOWN');
    await expect(processor.process({
      name: 'execute:care:case', data: { tenantId: 'tenant-001', careCaseId: 'not-ulid' },
    } as Job<CareExecutionJobData>)).rejects.toThrow();
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
    } as Job<CareExecutionJobData>;
    await expect(processor.process(job)).rejects.toBe(failure);
    expect(audit.record).toHaveBeenCalledWith({
      action: 'care.case.execute', resourceType: 'care_case',
      resourceId: '01J8ZQK7V0A2M4N6P8R0T2W4C1', riskLevel: 'R3', outcome: 'failure',
      metadata: { failureCode: 'CARE_VERSION_CONFLICT' },
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('上游可能含敏感响应');
  });
});
