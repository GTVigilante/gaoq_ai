import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';

import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { CareApplicationService } from './application/care-application.service.js';
import {
  CARE_EXECUTE_CASE_JOB,
  CARE_EXPIRE_ALUMNI_CONSENT_JOB,
  CARE_EXECUTION_QUEUE,
  type CareAlumniConsentExpiryJobData,
  type CareExecutionJobData,
  type CareJobData,
} from './care-execution.queue.js';

const executionJobSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  careCaseId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
}).strict();
const consentExpiryJobSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  consentId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
}).strict();

@Processor(CARE_EXECUTION_QUEUE, { concurrency: 4, limiter: { max: 20, duration: 1_000 } })
export class CareExecutionProcessor extends WorkerHost {
  constructor(
    private readonly context: TenantContextService,
    private readonly care: CareApplicationService,
    private readonly audit: AuditService,
  ) { super(); }

  override async process(job: Job<CareJobData>): Promise<number> {
    if (job.name === CARE_EXECUTE_CASE_JOB) {
      return this.processCase(job as Job<CareExecutionJobData>);
    }
    if (job.name === CARE_EXPIRE_ALUMNI_CONSENT_JOB) {
      return this.processConsentExpiry(job as Job<CareAlumniConsentExpiryJobData>);
    }
    throw new Error('CARE_EXECUTION_JOB_UNKNOWN');
  }

  private async processCase(job: Job<CareExecutionJobData>): Promise<number> {
    const data = executionJobSchema.parse(job.data);
    await this.context.run({
      tenant: { tenantId: data.tenantId, source: 'service_identity' },
      actor: {
        actorId: 'system:care-execution', actorType: 'system_job', tenantId: data.tenantId,
        roleCodes: ['CARE_EXECUTION_WORKER'],
        scopes: ['erp:care:execution:run', 'erp:care:employment:terminate'],
        departmentIds: [], traceId: String(job.id ?? data.careCaseId),
      },
    }, async () => {
      let result: Awaited<ReturnType<CareApplicationService['executeScheduledJob']>>;
      try {
        result = await this.care.executeScheduledJob(
          data.careCaseId, `care-job-${String(job.id)}`,
        );
      } catch (error) {
        await this.recordFailureWithoutMasking({
          action: 'care.case.execute', resourceType: 'care_case',
          resourceId: data.careCaseId, riskLevel: 'R3', outcome: 'failure',
          metadata: { failureCode: safeFailureCode(error) },
        });
        throw error;
      }
      await this.audit.record({
        action: 'care.case.execute', resourceType: 'care_case',
        resourceId: result.careCase.id, riskLevel: 'R3', outcome: 'success',
        metadata: {
          status: result.careCase.status,
          lastWorkingDate: result.careCase.lastWorkingDate,
          version: result.careCase.version,
        },
      });
    });
    return 1;
  }

  private async processConsentExpiry(
    job: Job<CareAlumniConsentExpiryJobData>,
  ): Promise<number> {
    const data = consentExpiryJobSchema.parse(job.data);
    await this.context.run({
      tenant: { tenantId: data.tenantId, source: 'service_identity' },
      actor: {
        actorId: 'system:care-consent-expiry', actorType: 'system_job',
        tenantId: data.tenantId, roleCodes: ['CARE_CONSENT_EXPIRY_WORKER'],
        scopes: ['erp:care:alumni:consent:expire'],
        departmentIds: [], traceId: String(job.id ?? data.consentId),
      },
    }, async () => {
      let result: Awaited<ReturnType<CareApplicationService['expireAlumniConsent']>>;
      try {
        result = await this.care.expireAlumniConsent(data.consentId);
      } catch (error) {
        await this.recordFailureWithoutMasking({
          action: 'care.alumni_consent.expire', resourceType: 'care_alumni_consent',
          resourceId: data.consentId, riskLevel: 'R1', outcome: 'failure',
          metadata: { failureCode: safeFailureCode(error) },
        });
        throw error;
      }
      await this.audit.record({
        action: 'care.alumni_consent.expire', resourceType: 'care_alumni_consent',
        resourceId: result.consent.id, riskLevel: 'R1', outcome: 'success',
        metadata: {
          status: result.consent.status,
          expiresAt: result.consent.expiresAt,
          version: result.consent.version,
        },
      });
    });
    return 1;
  }

  private async recordFailureWithoutMasking(
    input: Parameters<AuditService['record']>[0],
  ): Promise<void> {
    await this.audit.record(input).catch(() => undefined);
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
