import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import type { AuditRecordInput } from '../../core/audit/audit.types.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  AttendanceApplicationService,
  type AttendanceCorrectionRequestSummary,
  type AttendanceCorrectionSummary,
  type AttendanceFactSummary,
  type AttendanceMonthSummary,
} from './application/attendance-application.service.js';
import {
  AttendanceShiftApplicationService,
  type AttendanceShiftEvaluationSummary,
  type AttendanceShiftPlanSummary,
} from './application/attendance-shift-application.service.js';
import {
  AssignAttendanceShiftPlanDto,
  CloseAttendanceMonthDto,
  IngestAttendanceSourceFactDto,
  RegisterAttendanceCorrectionDto,
  RequestAttendanceCorrectionDto,
} from './application/attendance.dto.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

@Controller('attendance')
export class AttendanceController {
  private readonly logger = new Logger(AttendanceController.name);

  constructor(
    private readonly attendance: AttendanceApplicationService,
    private readonly shifts: AttendanceShiftApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Post('shift-plans')
  @RequiredScopes('erp:attendance:shift_plan:write')
  async assignShiftPlan(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AssignAttendanceShiftPlanDto,
  ): Promise<{ readonly shiftPlan: AttendanceShiftPlanSummary }> {
    const result = await this.shifts.assign(this.key(key), body);
    await this.auditAfterCommit({
      action: 'attendance.shift_plan.assign',
      resourceType: 'attendance_shift_plan',
      resourceId: result.shiftPlan.id,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: {
        employeeId: result.shiftPlan.employeeId,
        businessDate: result.shiftPlan.businessDate,
        planCode: result.shiftPlan.planCode,
        rulesetVersion: result.shiftPlan.rulesetVersion,
      },
    });
    return result;
  }

  @Post('shift-plans/:shiftPlanId/evaluate')
  @RequiredScopes('erp:attendance:shift:evaluate')
  async evaluateShift(
    @Headers('idempotency-key') key: string | undefined,
    @Param('shiftPlanId') shiftPlanId: string,
  ): Promise<{ readonly evaluation: AttendanceShiftEvaluationSummary }> {
    const result = await this.shifts.evaluate(this.key(key), shiftPlanId);
    await this.auditAfterCommit({
      action: 'attendance.shift.evaluate',
      resourceType: 'attendance_shift_plan',
      resourceId: result.evaluation.shiftPlanId,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: {
        sourceFactId: result.evaluation.sourceFactId,
        businessDate: result.evaluation.businessDate,
      },
    });
    return result;
  }

  @Post('source-facts')
  @RequiredScopes('erp:attendance:source:ingest')
  async ingest(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: IngestAttendanceSourceFactDto,
  ): Promise<{ readonly fact: AttendanceFactSummary }> {
    const result = await this.attendance.ingest(this.key(key), body);
    await this.auditAfterCommit({
      action: 'attendance.source_fact.ingest', resourceType: 'attendance_source_fact',
      resourceId: result.fact.id, riskLevel: 'R1', outcome: 'success', metadata: {
        employeeId: result.fact.employeeId, providerCode: result.fact.providerCode,
        factType: result.fact.factType, businessDate: result.fact.businessDate,
      },
    });
    return result;
  }

  @Post('corrections')
  @RequiredScopes('erp:attendance:correction:attest', 'erp:attendance:approval:sync')
  async registerCorrection(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: RegisterAttendanceCorrectionDto,
  ): Promise<{ readonly correction: AttendanceCorrectionSummary }> {
    const result = await this.attendance.registerCorrection(this.key(key), body);
    await this.auditAfterCommit({
      action: 'attendance.correction.register', resourceType: 'attendance_correction',
      resourceId: result.correction.id, riskLevel: 'R2', outcome: 'success', metadata: {
        employeeId: result.correction.employeeId,
        sourceFactId: result.correction.sourceFactId,
        businessDate: result.correction.businessDate,
        approvalInstanceId: result.correction.approvalInstanceId,
      },
    });
    return result;
  }

  @Post('correction-requests')
  @RequiredScopes('erp:attendance:correction:request', 'erp:approval:instance:submit')
  async requestCorrection(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: RequestAttendanceCorrectionDto,
  ): Promise<{ readonly request: AttendanceCorrectionRequestSummary }> {
    const result = await this.attendance.requestCorrection(this.key(key), body);
    await this.auditAfterCommit({
      action: 'attendance.correction.request', resourceType: 'attendance_correction_request',
      resourceId: result.request.approvalInstanceId, riskLevel: 'R1', outcome: 'success',
      metadata: {
        employeeId: result.request.employeeId, sourceFactId: result.request.sourceFactId,
        businessDate: result.request.businessDate,
        approvalStatus: result.request.approvalStatus,
      },
    });
    return result;
  }

  @Post('months/close')
  @RequiredScopes('erp:attendance:month:close')
  async closeMonth(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CloseAttendanceMonthDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly month: AttendanceMonthSummary }> {
    const result = await this.attendance.closeMonth(this.key(key), body);
    response.setHeader('ETag', `"${result.month.snapshotVersion}"`);
    await this.auditMonth('attendance.month.close', result.month, 'R2', true);
    return result;
  }

  @Get('months/:month/me')
  @RequiredScopes('erp:attendance:month:read_self')
  async getMyMonth(
    @Param('month') month: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AttendanceMonthSummary> {
    const result = await this.attendance.getMyMonth(this.month(month));
    response.setHeader('ETag', `"${result.snapshotVersion}"`);
    await this.auditMonth('attendance.month.read_self', result, 'R0');
    return result;
  }

  private key(value: string | undefined): string {
    if (value === undefined || value.length === 0) throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key',
    });
    return value;
  }

  private month(value: string): string {
    if (!MONTH.test(value)) throw new BadRequestException({
      code: 'ATTENDANCE_MONTH_INVALID', message: '月份必须为 YYYY-MM',
    });
    return value;
  }

  private async auditMonth(
    action: string,
    month: AttendanceMonthSummary,
    riskLevel: 'R0' | 'R2',
    afterCommit = false,
  ): Promise<void> {
    const input: AuditRecordInput = {
      action, resourceType: 'attendance_monthly_snapshot', resourceId: month.id,
      riskLevel, outcome: 'success', metadata: {
        employeeId: month.employeeId, month: month.month,
        snapshotVersion: month.snapshotVersion, snapshotHash: month.snapshotHash,
      },
    };
    if (afterCommit) {
      await this.auditAfterCommit(input);
      return;
    }
    await this.audit.record(input);
  }

  /** 考勤写事务已提交后，审计故障只记录稳定告警，禁止客户端重复追加事实。 */
  private async auditAfterCommit(input: AuditRecordInput): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      this.logger.error({
        code: 'ATTENDANCE_AUDIT_AFTER_COMMIT_FAILED',
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        riskLevel: input.riskLevel,
      });
    }
  }
}
