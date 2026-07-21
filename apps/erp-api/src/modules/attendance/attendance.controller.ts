import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  AttendanceApplicationService,
  type AttendanceCorrectionSummary,
  type AttendanceFactSummary,
  type AttendanceMonthSummary,
} from './application/attendance-application.service.js';
import {
  CloseAttendanceMonthDto,
  IngestAttendanceSourceFactDto,
  RegisterAttendanceCorrectionDto,
} from './application/attendance.dto.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Post('source-facts')
  @RequiredScopes('erp:attendance:source:ingest')
  async ingest(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: IngestAttendanceSourceFactDto,
  ): Promise<{ readonly fact: AttendanceFactSummary }> {
    const result = await this.attendance.ingest(this.key(key), body);
    await this.audit.record({
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
    await this.audit.record({
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

  @Post('months/close')
  @RequiredScopes('erp:attendance:month:close')
  async closeMonth(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CloseAttendanceMonthDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly month: AttendanceMonthSummary }> {
    const result = await this.attendance.closeMonth(this.key(key), body);
    response.setHeader('ETag', `"${result.month.snapshotVersion}"`);
    await this.auditMonth('attendance.month.close', result.month, 'R2');
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
  ): Promise<void> {
    await this.audit.record({
      action, resourceType: 'attendance_monthly_snapshot', resourceId: month.id,
      riskLevel, outcome: 'success', metadata: {
        employeeId: month.employeeId, month: month.month,
        snapshotVersion: month.snapshotVersion, snapshotHash: month.snapshotHash,
      },
    });
  }
}
