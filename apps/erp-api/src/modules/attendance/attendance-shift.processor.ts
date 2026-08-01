import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Job } from 'bullmq';
import { z } from 'zod';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { AttendanceShiftApplicationService } from './application/attendance-shift-application.service.js';
import { AttendanceShiftQueueService } from './attendance-shift-queue.service.js';
import {
  ATTENDANCE_SHIFT_EVALUATE_JOB,
  ATTENDANCE_SHIFT_QUEUE,
  ATTENDANCE_SHIFT_SCAN_JOB,
  type AttendanceShiftJobData,
} from './attendance-shift.queue.js';

const evaluateJobSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  shiftPlanId: z.string().regex(ULID_PATTERN),
}).strict();

@Processor(ATTENDANCE_SHIFT_QUEUE, { concurrency: 4 })
export class AttendanceShiftProcessor extends WorkerHost {
  private readonly logger = new Logger(AttendanceShiftProcessor.name);

  constructor(
    private readonly context: TenantContextService,
    private readonly shifts: AttendanceShiftApplicationService,
    private readonly queueService: AttendanceShiftQueueService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  override async process(job: Job<AttendanceShiftJobData>): Promise<number> {
    if (job.name === ATTENDANCE_SHIFT_SCAN_JOB) {
      z.object({}).strict().parse(job.data);
      return this.queueService.enqueueDue();
    }
    if (job.name !== ATTENDANCE_SHIFT_EVALUATE_JOB) {
      throw new Error('ATTENDANCE_SHIFT_JOB_UNKNOWN');
    }
    const data = evaluateJobSchema.parse(job.data);
    return this.context.run({
      tenant: { tenantId: data.tenantId, source: 'service_identity' },
      actor: {
        tenantId: data.tenantId,
        actorId: 'system:attendance-shift-worker',
        actorType: 'system_job',
        roleCodes: [],
        scopes: ['erp:attendance:shift:evaluate'],
        departmentIds: [],
        traceId: `attendance-shift:${job.id ?? data.shiftPlanId}`,
      },
    }, async () => {
      try {
        const result = await this.shifts.evaluate(
          `attendance-shift-job:${job.id ?? data.shiftPlanId}`,
          data.shiftPlanId,
        );
        await this.auditSafely({
          action: 'attendance.shift.evaluate',
          resourceType: 'attendance_shift_plan',
          resourceId: data.shiftPlanId,
          riskLevel: 'R1',
          outcome: 'success',
          metadata: { sourceFactId: result.evaluation.sourceFactId },
        });
        return 1;
      } catch (error) {
        await this.auditSafely({
          action: 'attendance.shift.evaluate',
          resourceType: 'attendance_shift_plan',
          resourceId: data.shiftPlanId,
          riskLevel: 'R1',
          outcome: 'failure',
          metadata: { failureCode: failureCode(error) },
        });
        throw error;
      }
    });
  }

  private async auditSafely(
    input: Parameters<AuditService['record']>[0],
  ): Promise<void> {
    try {
      await this.audit.record(input);
    } catch (error) {
      this.logger.error({
        code: 'ATTENDANCE_SHIFT_AUDIT_FAILED',
        failureCode: failureCode(error),
      });
    }
  }
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) {
    return error.message;
  }
  return 'ATTENDANCE_SHIFT_EVALUATION_FAILED';
}
