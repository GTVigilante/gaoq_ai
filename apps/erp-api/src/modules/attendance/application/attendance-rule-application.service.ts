import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { EmploymentRepository } from '../../org/persistence/org.repositories.js';
import {
  AttendanceDomainError,
  createAttendanceProviderCoverage,
  createAttendanceShiftAssignment,
  createAttendanceShiftRule,
  evaluateAttendanceMonth,
  type AttendanceCorrection,
  type AttendanceProviderCode,
  type AttendanceRuleEvaluation,
  type AttendanceSourceFact,
} from '../domain/index.js';
import { AttendanceOutboxWriter } from '../persistence/attendance-outbox.writer.js';
import {
  AttendanceProviderCoverageRepository,
  AttendanceShiftAssignmentRepository,
  AttendanceShiftRuleRepository,
} from '../persistence/attendance-rules.repositories.js';
import type {
  AttestAttendanceShiftAssignmentDto,
  AttestAttendanceShiftRuleDto,
} from './attendance.dto.js';

export interface AttendanceProviderCoverageAttestationInput {
  readonly employeeId: string;
  readonly providerCode: AttendanceProviderCode;
  readonly providerStateId: string;
  readonly providerMappingId: string;
  readonly month: string;
  readonly throughBusinessDate: string;
  readonly sourceCutoffAt: string;
}

export interface AttendanceShiftRuleSummary extends Record<string, unknown> {
  readonly id: string;
  readonly rulesetVersion: string;
  readonly shiftCode: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface AttendanceShiftAssignmentSummary extends Record<string, unknown> {
  readonly id: string;
  readonly employeeId: string;
  readonly shiftRuleId: string;
  readonly providerCode: AttendanceProviderCode;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface AttendanceProviderCoverageSummary extends Record<string, unknown> {
  readonly id: string;
  readonly employeeId: string;
  readonly providerCode: AttendanceProviderCode;
  readonly month: string;
  readonly throughBusinessDate: string;
  readonly sourceCutoffAt: string;
  readonly evidenceChecksum: string;
}

@Injectable()
export class AttendanceRuleApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly employments: EmploymentRepository,
    private readonly rules: AttendanceShiftRuleRepository,
    private readonly assignments: AttendanceShiftAssignmentRepository,
    private readonly coverages: AttendanceProviderCoverageRepository,
    private readonly outbox: AttendanceOutboxWriter,
  ) {}

  async attestRule(
    key: string,
    input: AttestAttendanceShiftRuleDto,
  ): Promise<{ readonly rule: AttendanceShiftRuleSummary }> {
    this.assertTrustedWriter('erp:attendance:rule:attest');
    return this.run(() => this.idempotency.execute(
      'attendance.shift_rule.attest',
      key,
      input,
      async (session) => {
        const now = new Date();
        const rule = createAttendanceShiftRule({
          id: createEventId(now),
          tenantId: this.context.getTenantRequired().tenantId,
          rulesetVersion: input.rulesetVersion,
          shiftCode: input.shiftCode,
          timeZone: input.timeZone,
          startLocalTime: input.startLocalTime,
          endLocalTime: input.endLocalTime,
          workdays: input.workdays,
          plannedMinutes: input.plannedMinutes,
          lateGraceMinutes: input.lateGraceMinutes,
          earlyLeaveGraceMinutes: input.earlyLeaveGraceMinutes,
          crossMidnightPunchOutGraceMinutes: input.crossMidnightPunchOutGraceMinutes,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          governanceEvidenceId: input.governanceEvidenceId,
          evidenceChecksum: input.evidenceChecksum,
        }, now);
        await this.rules.insert(rule, session);
        await this.outbox.append({
          type: 'attendance.shift_rule.attested',
          tenantId: rule.tenantId,
          aggregateId: rule.id,
          version: 1,
          occurredAt: rule.createdAt,
          data: {
            rulesetVersion: rule.rulesetVersion,
            shiftCode: rule.shiftCode,
            effectiveFrom: rule.effectiveFrom,
            effectiveTo: rule.effectiveTo,
            evidenceChecksum: rule.evidenceChecksum,
          },
        }, session);
        return { rule: ruleSummary(rule) };
      },
    ));
  }

  async attestAssignment(
    key: string,
    input: AttestAttendanceShiftAssignmentDto,
  ): Promise<{ readonly assignment: AttendanceShiftAssignmentSummary }> {
    this.assertTrustedWriter('erp:attendance:shift_assignment:attest');
    return this.run(() => this.idempotency.execute(
      'attendance.shift_assignment.attest',
      key,
      input,
      async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const now = new Date();
        const assignment = createAttendanceShiftAssignment({
          id: createEventId(now),
          tenantId,
          employeeId: input.employeeId,
          shiftRuleId: input.shiftRuleId,
          providerCode: input.providerCode,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          governanceEvidenceId: input.governanceEvidenceId,
          evidenceChecksum: input.evidenceChecksum,
        }, now);
        await this.assignments.serializeEmployee(assignment.employeeId, session);
        const [rule, overlappingAssignments, overlappingEmployments] = await Promise.all([
          this.rules.findById(assignment.shiftRuleId, session),
          this.assignments.findOverlapping(
            assignment.employeeId,
            assignment.effectiveFrom,
            assignment.effectiveTo,
            session,
          ),
          this.employments.findOverlappingByEmployeeIds(
            [assignment.employeeId],
            assignment.effectiveFrom,
            assignment.effectiveTo ?? '9999-12-31',
            session,
          ),
        ]);
        if (rule === null) {
          throw new NotFoundException({
            code: 'ATTENDANCE_SHIFT_RULE_NOT_FOUND',
            message: '排班引用的班次规则不存在',
          });
        }
        if (
          assignment.effectiveFrom < rule.effectiveFrom ||
          (rule.effectiveTo !== null &&
            (assignment.effectiveTo === null || assignment.effectiveTo > rule.effectiveTo))
        ) {
          throw new ConflictException({
            code: 'ATTENDANCE_SHIFT_RULE_INTERVAL_MISMATCH',
            message: '排班有效区间超出班次规则有效区间',
          });
        }
        if (overlappingAssignments.length !== 0) {
          throw new ConflictException({
            code: 'ATTENDANCE_SHIFT_ASSIGNMENT_OVERLAP',
            message: '员工排班有效区间重叠',
          });
        }
        const coveringEmployment = overlappingEmployments.filter((employment) =>
          employment.employeeId === assignment.employeeId &&
          employment.effectiveFrom <= assignment.effectiveFrom &&
          (employment.effectiveTo === null ||
            (assignment.effectiveTo !== null &&
              employment.effectiveTo >= assignment.effectiveTo)));
        if (coveringEmployment.length !== 1) {
          throw new ConflictException({
            code: 'ATTENDANCE_SHIFT_OUTSIDE_EMPLOYMENT',
            message: '排班必须完整位于唯一劳动关系有效区间内',
          });
        }
        await this.assignments.insert(assignment, session);
        await this.outbox.append({
          type: 'attendance.shift_assignment.attested',
          tenantId,
          aggregateId: assignment.id,
          version: 1,
          occurredAt: assignment.createdAt,
          data: {
            employeeId: assignment.employeeId,
            shiftRuleId: assignment.shiftRuleId,
            providerCode: assignment.providerCode,
            effectiveFrom: assignment.effectiveFrom,
            effectiveTo: assignment.effectiveTo,
            evidenceChecksum: assignment.evidenceChecksum,
          },
        }, session);
        return { assignment: assignmentSummary(assignment) };
      },
    ));
  }

  /** 仅供可信 Provider 对账边界写入；游标、外部员工 ID 和原始响应不会进入本模块。 */
  async attestProviderCoverage(
    key: string,
    input: AttendanceProviderCoverageAttestationInput,
  ): Promise<{ readonly coverage: AttendanceProviderCoverageSummary }> {
    this.assertTrustedWriter('erp:attendance:coverage:attest');
    return this.run(() => this.idempotency.execute(
      'attendance.provider_coverage.attest',
      key,
      input,
      async (session) => {
        const now = new Date();
        const coverage = createAttendanceProviderCoverage({
          id: createEventId(now),
          tenantId: this.context.getTenantRequired().tenantId,
          ...input,
        }, now);
        await this.coverages.insert(coverage, session);
        await this.outbox.append({
          type: 'attendance.provider_coverage.reconciled',
          tenantId: coverage.tenantId,
          aggregateId: coverage.id,
          version: 1,
          occurredAt: coverage.createdAt,
          data: {
            employeeId: coverage.employeeId,
            providerCode: coverage.providerCode,
            month: coverage.month,
            throughBusinessDate: coverage.throughBusinessDate,
            sourceCutoffAt: coverage.sourceCutoffAt,
            evidenceChecksum: coverage.evidenceChecksum,
          },
        }, session);
        return { coverage: coverageSummary(coverage) };
      },
    ));
  }

  async evaluateMonth(
    input: {
      readonly employeeId: string;
      readonly month: string;
      readonly rulesetVersion: string;
      readonly sourceCutoffAt: string;
      readonly facts: readonly AttendanceSourceFact[];
      readonly corrections: readonly AttendanceCorrection[];
    },
    session: ClientSession,
  ): Promise<AttendanceRuleEvaluation> {
    return this.run(async () => {
      const monthStart = `${input.month}-01`;
      const monthEnd = endOfMonth(input.month);
      const [employments, rules, assignments, coverages] = await Promise.all([
        this.employments.findOverlappingByEmployeeIds(
          [input.employeeId],
          monthStart,
          monthEnd,
          session,
        ),
        this.rules.findForMonth(input.rulesetVersion, input.month, session),
        this.assignments.findForMonth(input.employeeId, input.month, session),
        this.coverages.findForMonth(
          input.employeeId,
          input.month,
          new Date(input.sourceCutoffAt),
          session,
        ),
      ]);
      return evaluateAttendanceMonth({
        tenantId: this.context.getTenantRequired().tenantId,
        ...input,
        employments,
        rules,
        assignments,
        coverages,
      });
    });
  }

  private assertTrustedWriter(scope: string): void {
    const actor = this.context.getActorRequired();
    if (
      !['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes(scope)
    ) {
      throw new ForbiddenException({
        code: 'ATTENDANCE_RULE_TRUSTED_WRITER_REQUIRED',
        message: '考勤规则与覆盖证明只能由受信任服务身份登记',
      });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AttendanceDomainError) {
        if (
          error.code.includes('OVERLAP') ||
          error.code.includes('MISSING') ||
          error.code.includes('MISMATCH') ||
          error.code.includes('OUTSIDE') ||
          error.code.includes('TAMPERED')
        ) {
          throw new ConflictException({ code: error.code, message: error.message });
        }
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) {
        throw new ConflictException({
          code: 'ATTENDANCE_RULE_UNIQUE_CONFLICT',
          message: '考勤规则、排班或覆盖证明已存在',
        });
      }
      throw error;
    }
  }
}

function ruleSummary(rule: Awaited<ReturnType<typeof createAttendanceShiftRule>>):
AttendanceShiftRuleSummary {
  return Object.freeze({
    id: rule.id,
    rulesetVersion: rule.rulesetVersion,
    shiftCode: rule.shiftCode,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
  });
}

function assignmentSummary(
  assignment: Awaited<ReturnType<typeof createAttendanceShiftAssignment>>,
): AttendanceShiftAssignmentSummary {
  return Object.freeze({
    id: assignment.id,
    employeeId: assignment.employeeId,
    shiftRuleId: assignment.shiftRuleId,
    providerCode: assignment.providerCode,
    effectiveFrom: assignment.effectiveFrom,
    effectiveTo: assignment.effectiveTo,
  });
}

function coverageSummary(
  coverage: Awaited<ReturnType<typeof createAttendanceProviderCoverage>>,
): AttendanceProviderCoverageSummary {
  return Object.freeze({
    id: coverage.id,
    employeeId: coverage.employeeId,
    providerCode: coverage.providerCode,
    month: coverage.month,
    throughBusinessDate: coverage.throughBusinessDate,
    sourceCutoffAt: coverage.sourceCutoffAt,
    evidenceChecksum: coverage.evidenceChecksum,
  });
}

function endOfMonth(month: string): string {
  const [yearValue, monthValue] = month.split('-');
  return new Date(Date.UTC(Number(yearValue), Number(monthValue), 0))
    .toISOString()
    .slice(0, 10);
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11_000;
}
