import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createEventId } from '@gaoq/shared-utils';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  EmployeeRepository,
  EmploymentRepository,
} from '../../org/persistence/org.repositories.js';
import {
  AttendanceDomainError,
  assertShiftPlanCaptureWindowAvailable,
  createAttendanceShiftPlan,
  createAttendanceSourceFact,
  evaluateAttendanceShift,
  type AttendanceShiftPlan,
  type AttendanceSourceFact,
} from '../domain/index.js';
import { AttendanceDataCryptoService } from '../persistence/attendance-data-crypto.service.js';
import { AttendanceOutboxWriter } from '../persistence/attendance-outbox.writer.js';
import {
  AttendanceShiftPlanRepository,
  AttendanceSourceFactRepository,
} from '../persistence/attendance.repositories.js';
import type { AssignAttendanceShiftPlanDto } from './attendance.dto.js';

export interface AttendanceShiftPlanSummary extends Record<string, unknown> {
  readonly id: string;
  readonly employeeId: string;
  readonly planCode: string;
  readonly businessDate: string;
  readonly rulesetVersion: string;
}

export interface AttendanceShiftEvaluationSummary extends Record<string, unknown> {
  readonly shiftPlanId: string;
  readonly sourceFactId: string;
  readonly businessDate: string;
  readonly status: 'completed';
}

@Injectable()
export class AttendanceShiftApplicationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly employees: EmployeeRepository,
    private readonly employments: EmploymentRepository,
    private readonly crypto: AttendanceDataCryptoService,
    private readonly plans: AttendanceShiftPlanRepository,
    private readonly facts: AttendanceSourceFactRepository,
    private readonly outbox: AttendanceOutboxWriter,
  ) {}

  async assign(
    key: string,
    input: AssignAttendanceShiftPlanDto,
  ): Promise<{ readonly shiftPlan: AttendanceShiftPlanSummary }> {
    this.assertTrusted('erp:attendance:shift_plan:write');
    return this.run(async () => this.idempotency.execute(
      'attendance.shift_plan.assign',
      key,
      input,
      async (session) => {
        const tenantId = this.context.getTenantRequired().tenantId;
        const [employee, employments] = await Promise.all([
          this.employees.findById(input.employeeId, session),
          this.employments.findOverlappingByEmployeeIds(
            [input.employeeId],
            input.businessDate,
            input.businessDate,
            session,
          ),
        ]);
        if (employee === null) throw new NotFoundException({
          code: 'ATTENDANCE_EMPLOYEE_NOT_FOUND',
          message: 'ERP 员工主数据不存在',
        });
        if (!employments.some((employment) =>
          employment.effectiveFrom <= input.businessDate &&
          (employment.effectiveTo === null || employment.effectiveTo >= input.businessDate))) {
          throw new ConflictException({
            code: 'ATTENDANCE_SHIFT_OUTSIDE_EMPLOYMENT',
            message: '班次不在员工劳动关系有效区间内',
          });
        }
        const fingerprints = this.crypto.sourceEventFingerprints(
          tenantId,
          input.providerCode,
          input.externalPlanId,
        );
        const collision = await this.plans.findByEventFingerprints(fingerprints, session);
        const now = new Date();
        const candidate = createAttendanceShiftPlan({
          id: collision?.id ?? createEventId(now),
          tenantId,
          employeeId: input.employeeId,
          providerCode: input.providerCode,
          planCode: input.planCode,
          businessDate: input.businessDate,
          rulesetVersion: input.rulesetVersion,
          timeZone: input.timeZone,
          scheduledStartAt: normalizeInstant(input.scheduledStartAt),
          scheduledEndAt: normalizeInstant(input.scheduledEndAt),
          breakMinutes: input.breakMinutes,
          graceMinutes: input.graceMinutes,
          earlyArrivalWindowMinutes: input.earlyArrivalWindowMinutes,
          lateDepartureWindowMinutes: input.lateDepartureWindowMinutes,
          sourceObservedAt: normalizeInstant(input.sourceObservedAt),
        }, now);
        if (collision !== null) {
          if (!samePlan(collision, candidate)) throw new ConflictException({
            code: 'ATTENDANCE_SHIFT_SOURCE_COLLISION',
            message: '同一外部班次标识绑定了不同内容',
          });
          return { shiftPlan: planSummary(collision) };
        }
        const nearby = await this.plans.findNearBusinessDate(
          input.employeeId,
          shiftDate(input.businessDate, -2),
          shiftDate(input.businessDate, 2),
          session,
        );
        assertShiftPlanCaptureWindowAvailable(candidate, nearby);
        await this.plans.insert(candidate, fingerprints, session);
        await this.outbox.append({
          type: 'attendance.shift_plan.assigned',
          tenantId,
          aggregateId: candidate.id,
          version: 1,
          occurredAt: now.toISOString(),
          data: {
            employeeId: candidate.employeeId,
            businessDate: candidate.businessDate,
            planCode: candidate.planCode,
            rulesetVersion: candidate.rulesetVersion,
          },
        }, session);
        return { shiftPlan: planSummary(candidate) };
      },
    ));
  }

  async evaluate(
    key: string,
    shiftPlanId: string,
  ): Promise<{ readonly evaluation: AttendanceShiftEvaluationSummary }> {
    this.assertTrusted('erp:attendance:shift:evaluate');
    return this.run(async () => this.idempotency.execute(
      'attendance.shift.evaluate',
      key,
      { shiftPlanId },
      async (session) => {
        const plan = await this.plans.findById(shiftPlanId, session);
        if (plan === null) throw new NotFoundException({
          code: 'ATTENDANCE_SHIFT_PLAN_NOT_FOUND',
          message: '班次计划不存在',
        });
        const existing = await this.facts.findByShiftPlanId(plan.id, session);
        if (existing !== null) {
          await this.plans.markEvaluated(plan.id, existing.id, new Date(), session);
          return { evaluation: evaluationSummary(plan, existing) };
        }
        const punches = await this.facts.findPunchesForDateRange(
          plan.employeeId,
          shiftDate(plan.businessDate, -1),
          shiftDate(plan.businessDate, 2),
          session,
        );
        const now = new Date();
        const evaluation = evaluateAttendanceShift(plan, punches, now);
        const fingerprints = this.crypto.sourceEventFingerprints(
          plan.tenantId,
          'attendance_rules',
          plan.id,
        );
        const collision = await this.facts.findByEventFingerprints(fingerprints, session);
        if (collision !== null) throw new ConflictException({
          code: 'ATTENDANCE_SHIFT_DERIVATION_COLLISION',
          message: '班次派生事实外部标识冲突',
        });
        const fact = createAttendanceSourceFact({
          id: createEventId(now),
          tenantId: plan.tenantId,
          employeeId: plan.employeeId,
          providerCode: 'attendance_rules',
          factType: 'shift',
          shiftPlanId: plan.id,
          occurredAt: plan.scheduledStartAt,
          timeZone: plan.timeZone,
          impact: evaluation.impact,
          sourceObservedAt: now.toISOString(),
        }, now);
        await this.facts.insert(fact, fingerprints, session);
        await this.plans.markEvaluated(plan.id, fact.id, now, session);
        await this.outbox.append({
          type: 'attendance.shift.evaluated',
          tenantId: plan.tenantId,
          aggregateId: fact.id,
          version: 1,
          occurredAt: now.toISOString(),
          data: {
            employeeId: plan.employeeId,
            shiftPlanId: plan.id,
            businessDate: plan.businessDate,
            rulesetVersion: plan.rulesetVersion,
          },
        }, session);
        return { evaluation: evaluationSummary(plan, fact) };
      },
    ));
  }

  private assertTrusted(scope: string): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) || !actor.scopes.includes(scope)) {
      throw new ForbiddenException({
        code: 'ATTENDANCE_SHIFT_WRITER_DENIED',
        message: '班次计划与规则计算必须由受信任服务身份执行',
      });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AttendanceDomainError) {
        if (error.code.includes('OVERLAP') || error.code.includes('COLLISION') ||
          error.code.includes('NOT_ENDED')) {
          throw new ConflictException({ code: error.code, message: error.message });
        }
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'ATTENDANCE_SHIFT_UNIQUE_CONFLICT',
        message: '班次计划或派生事实已存在',
      });
      throw error;
    }
  }
}

function planSummary(plan: AttendanceShiftPlan): AttendanceShiftPlanSummary {
  return Object.freeze({
    id: plan.id,
    employeeId: plan.employeeId,
    planCode: plan.planCode,
    businessDate: plan.businessDate,
    rulesetVersion: plan.rulesetVersion,
  });
}

function evaluationSummary(
  plan: AttendanceShiftPlan,
  fact: AttendanceSourceFact,
): AttendanceShiftEvaluationSummary {
  return Object.freeze({
    shiftPlanId: plan.id,
    sourceFactId: fact.id,
    businessDate: plan.businessDate,
    status: 'completed' as const,
  });
}

function samePlan(left: AttendanceShiftPlan, right: AttendanceShiftPlan): boolean {
  return left.id === right.id &&
    left.tenantId === right.tenantId &&
    left.employeeId === right.employeeId &&
    left.providerCode === right.providerCode &&
    left.planCode === right.planCode &&
    left.businessDate === right.businessDate &&
    left.rulesetVersion === right.rulesetVersion &&
    left.timeZone === right.timeZone &&
    left.scheduledStartAt === right.scheduledStartAt &&
    left.scheduledEndAt === right.scheduledEndAt &&
    left.breakMinutes === right.breakMinutes &&
    left.graceMinutes === right.graceMinutes &&
    left.earlyArrivalWindowMinutes === right.earlyArrivalWindowMinutes &&
    left.lateDepartureWindowMinutes === right.lateDepartureWindowMinutes &&
    left.sourceObservedAt === right.sourceObservedAt;
}

function normalizeInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new BadRequestException({
    code: 'ATTENDANCE_SHIFT_INSTANT_INVALID',
    message: '班次时间非法',
  });
  return parsed.toISOString();
}

function shiftDate(value: string, days: number): string {
  const instant = new Date(`${value}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { readonly code?: unknown }).code === 11_000;
}
