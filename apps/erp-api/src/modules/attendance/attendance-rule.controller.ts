import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  Post,
} from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import type { AuditRecordInput } from '../../core/audit/audit.types.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  AttendanceRuleApplicationService,
  type AttendanceShiftAssignmentSummary,
  type AttendanceShiftRuleSummary,
} from './application/attendance-rule-application.service.js';
import {
  AttestAttendanceShiftAssignmentDto,
  AttestAttendanceShiftRuleDto,
} from './application/attendance.dto.js';

@Controller('attendance')
export class AttendanceRuleController {
  private readonly logger = new Logger(AttendanceRuleController.name);

  constructor(
    private readonly rules: AttendanceRuleApplicationService,
    private readonly audit: AuditService,
  ) {}

  @Post('shift-rules/attest')
  @RequiredScopes('erp:attendance:rule:attest')
  async attestRule(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AttestAttendanceShiftRuleDto,
  ): Promise<{ readonly rule: AttendanceShiftRuleSummary }> {
    const result = await this.rules.attestRule(this.key(key), body);
    await this.auditAfterCommit({
      action: 'attendance.shift_rule.attest',
      resourceType: 'attendance_shift_rule',
      resourceId: result.rule.id,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        rulesetVersion: result.rule.rulesetVersion,
        shiftCode: result.rule.shiftCode,
        effectiveFrom: result.rule.effectiveFrom,
        effectiveTo: result.rule.effectiveTo ?? 'open',
      },
    });
    return result;
  }

  @Post('shift-assignments/attest')
  @RequiredScopes('erp:attendance:shift_assignment:attest')
  async attestAssignment(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AttestAttendanceShiftAssignmentDto,
  ): Promise<{ readonly assignment: AttendanceShiftAssignmentSummary }> {
    const result = await this.rules.attestAssignment(this.key(key), body);
    await this.auditAfterCommit({
      action: 'attendance.shift_assignment.attest',
      resourceType: 'attendance_shift_assignment',
      resourceId: result.assignment.id,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        employeeId: result.assignment.employeeId,
        shiftRuleId: result.assignment.shiftRuleId,
        providerCode: result.assignment.providerCode,
        effectiveFrom: result.assignment.effectiveFrom,
        effectiveTo: result.assignment.effectiveTo ?? 'open',
      },
    });
    return result;
  }

  private key(value: string | undefined): string {
    if (value === undefined || value.length < 8 || value.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: '必须提供 8..128 字符合法 Idempotency-Key',
      });
    }
    return value;
  }

  /** 业务与 Outbox 事务已经提交，审计故障只形成稳定告警。 */
  private async auditAfterCommit(input: AuditRecordInput): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      this.logger.error({
        code: 'ATTENDANCE_RULE_AUDIT_AFTER_COMMIT_FAILED',
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        riskLevel: input.riskLevel,
      });
    }
  }
}
