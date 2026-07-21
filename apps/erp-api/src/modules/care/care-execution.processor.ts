import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { CareApplicationService } from './application/care-application.service.js';
import {
  CARE_EXECUTE_CASE_JOB,
  CARE_EXECUTION_QUEUE,
  type CareExecutionJobData,
} from './care-execution.queue.js';

const jobSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  careCaseId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
}).strict();

@Processor(CARE_EXECUTION_QUEUE, { concurrency: 4, limiter: { max: 20, duration: 1_000 } })
export class CareExecutionProcessor extends WorkerHost {
  constructor(
    private readonly context: TenantContextService,
    private readonly care: CareApplicationService,
    private readonly audit: AuditService,
  ) { super(); }

  override async process(job: Job<CareExecutionJobData>): Promise<number> {
    if (job.name !== CARE_EXECUTE_CASE_JOB) throw new Error('CARE_EXECUTION_JOB_UNKNOWN');
    const data = jobSchema.parse(job.data);
    await this.context.run({
      tenant: { tenantId: data.tenantId, source: 'service_identity' },
      actor: {
        actorId: 'system:care-execution', actorType: 'system_job', tenantId: data.tenantId,
        roleCodes: ['CARE_EXECUTION_WORKER'],
        scopes: ['erp:care:execution:run', 'erp:care:employment:terminate'],
        departmentIds: [], traceId: String(job.id ?? data.careCaseId),
      },
    }, async () => {
      try {
        const result = await this.care.executeScheduledJob(
          data.careCaseId, `care-job-${String(job.id)}`,
        );
        await this.audit.record({
          action: 'care.case.execute', resourceType: 'care_case',
          resourceId: result.careCase.id, riskLevel: 'R3', outcome: 'success',
          metadata: {
            status: result.careCase.status,
            lastWorkingDate: result.careCase.lastWorkingDate,
            version: result.careCase.version,
          },
        });
      } catch (error) {
        await this.audit.record({
          action: 'care.case.execute', resourceType: 'care_case',
          resourceId: data.careCaseId, riskLevel: 'R3', outcome: 'failure',
          metadata: { failureCode: safeFailureCode(error) },
        });
        throw error;
      }
    });
    return 1;
  }
}

/** 审计只记录白名单错误码，禁止把异常消息或上游响应写入审计。 */
function safeFailureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: unknown }).response;
    if (typeof response === 'object' && response !== null) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    }
  }
  if (error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)) return error.message;
  return 'CARE_EXECUTION_FAILED';
}
