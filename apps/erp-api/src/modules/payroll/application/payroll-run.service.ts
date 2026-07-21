import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  AttendanceMonthlySnapshotRecord,
  type AttendanceMonthlySnapshotDocument,
} from '../../attendance/persistence/attendance.schemas.js';
import {
  calculatePayroll,
  createPayrollPeriod,
  payrollDigest,
  recordPayrollCalculation,
  startPayrollCollection,
  type PayrollCalculationInput,
  type PayrollCalculationResult,
  type PayrollPeriod,
  type PayrollRulePackSnapshot,
  PayrollCalculationError,
  PayrollPeriodError,
} from '../domain/index.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollCalculationLineRecord,
  type PayrollCalculationLineDocument,
  PayrollCalculationRunRecord,
  type PayrollCalculationRunDocument,
  PayrollCompensationProfileRecord,
  type PayrollCompensationProfileDocument,
  PayrollInputSnapshotRecord,
  type PayrollInputSnapshotDocument,
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
  PayrollRulePackRecord,
  type PayrollRulePackDocument,
} from '../persistence/payroll.schemas.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EMPLOYEES_PER_RUN = 5_000;
const PAYROLL_ENGINE_VERSION = 'cn-cumulative-withholding-v1';

const componentSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  amountMinor: z.number().int().safe().nonnegative(),
}).strict();
const compensationProfileDataSchema = z.object({
  currency: z.literal('CNY'),
  taxableEarnings: z.array(componentSchema).max(128),
  nonTaxableEarnings: z.array(componentSchema).max(128),
  employeeSocialInsuranceMinor: z.number().int().safe().nonnegative(),
  employeeHousingFundMinor: z.number().int().safe().nonnegative(),
  specialAdditionalDeductionMinor: z.number().int().safe().nonnegative(),
  otherPreTaxWithholdingMinor: z.number().int().safe().nonnegative(),
  postTaxDeductionMinor: z.number().int().safe().nonnegative(),
  attendanceAdjustment: z.object({
    overtimePayMinorPerMinute: z.number().int().safe().nonnegative(),
    absenceDeductionMinorPerMinute: z.number().int().safe().nonnegative(),
    unpaidLeaveDeductionMinorPerMinute: z.number().int().safe().nonnegative(),
  }).strict(),
}).strict();
const cumulativeStateSchema = z.object({
  taxableIncomeMinor: z.number().int().safe().nonnegative(),
  basicDeductionMinor: z.number().int().safe().nonnegative(),
  socialInsuranceMinor: z.number().int().safe().nonnegative(),
  housingFundMinor: z.number().int().safe().nonnegative(),
  specialAdditionalDeductionMinor: z.number().int().safe().nonnegative(),
  otherDeductionMinor: z.number().int().safe().nonnegative(),
  taxWithheldMinor: z.number().int().safe().nonnegative(),
}).strict();
const payrollResultSchema = z.object({
  currency: z.literal('CNY'),
  inputHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  grossPayMinor: z.number().int().safe().nonnegative(),
  taxableEarningsMinor: z.number().int().safe().nonnegative(),
  withholdingTaxMinor: z.number().int().safe(),
  netPayMinor: z.number().int().safe().nonnegative(),
  cumulativeAfter: cumulativeStateSchema,
  steps: z.array(z.unknown()),
  resultHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export interface PayrollRunLineInput {
  readonly employeeId: string;
  readonly compensationProfileId: string;
  readonly attendanceSnapshotId: string;
}

export interface ExecutePayrollRunInput {
  readonly periodId: string;
  readonly expectedVersion: number;
  readonly rulePackId: string;
  readonly rulePackVersion: number;
  readonly lines: readonly PayrollRunLineInput[];
}

export interface PayrollPeriodSummary extends Record<string, unknown> {
  readonly id: string;
  readonly period: string;
  readonly status: PayrollPeriod['status'];
  readonly version: number;
  readonly activeRunId: string | null;
  readonly inputSnapshotHash: string | null;
  readonly resultHash: string | null;
  readonly employeeCount: number | null;
  readonly totalGrossMinor: number | null;
  readonly totalTaxMinor: number | null;
  readonly totalNetMinor: number | null;
}

/** 工资周期与计算运行应用服务；仅系统任务可提交已冻结的规范输入。 */
@Injectable()
export class PayrollRunService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly crypto: PayrollDataCryptoService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
    @InjectModel(PayrollRulePackRecord.name)
    private readonly rulePacks: Model<PayrollRulePackDocument>,
    @InjectModel(PayrollCompensationProfileRecord.name)
    private readonly compensationProfiles: Model<PayrollCompensationProfileDocument>,
    @InjectModel(AttendanceMonthlySnapshotRecord.name)
    private readonly attendanceSnapshots: Model<AttendanceMonthlySnapshotDocument>,
    @InjectModel(PayrollCalculationRunRecord.name)
    private readonly runs: Model<PayrollCalculationRunDocument>,
    @InjectModel(PayrollInputSnapshotRecord.name)
    private readonly snapshots: Model<PayrollInputSnapshotDocument>,
    @InjectModel(PayrollCalculationLineRecord.name)
    private readonly calculationLines: Model<PayrollCalculationLineDocument>,
  ) {}

  async createPeriod(key: string, period: string): Promise<PayrollPeriodSummary> {
    this.assertScope('erp:payroll:period:create');
    const trusted = this.context.getRequired();
    if (trusted.actor.actorType !== 'user') throw new ForbiddenException({
      code: 'PAYROLL_PERIOD_HUMAN_REQUIRED', message: '工资周期只能由已验证人员创建',
    });
    return this.run(() => this.idempotency.execute(
      'payroll.period.create', key, { period }, async (session) => {
      const created = createPayrollPeriod({
        id: createEventId(), tenantId: trusted.tenant.tenantId,
        period, preparedBy: trusted.actor.actorId,
      }, new Date());
      await this.periods.create([toPeriodRecord(created)], { session });
      await this.outbox.append({
        type: 'payroll.period.created', tenantId: created.tenantId,
        aggregateId: created.id, version: created.version,
        occurredAt: created.createdAt, data: { period: created.period, status: created.status },
      }, session);
      return payrollPeriodSummary(created);
      },
    ));
  }

  async startCollection(
    key: string,
    periodId: string,
    expectedVersion: number,
  ): Promise<PayrollPeriodSummary> {
    this.assertScope('erp:payroll:period:prepare');
    return this.run(() => this.idempotency.execute(
      'payroll.period.start_collection', key, { periodId, expectedVersion }, async (session) => {
        const current = await this.periods.findOne({
          tenantId: this.tenantId(), id: periodId,
        }).session(session).lean().exec();
        if (current === null) throw new NotFoundException({
          code: 'PAYROLL_PERIOD_NOT_FOUND', message: '工资周期不存在',
        });
        const next = startPayrollCollection(payrollPeriodFromRecord(current), {
          tenantId: this.tenantId(), expectedVersion,
        }, new Date());
        await this.replacePeriod(current, next, session);
        await this.outbox.append({
          type: 'payroll.period.collecting', tenantId: next.tenantId,
          aggregateId: next.id, version: next.version,
          occurredAt: next.updatedAt, data: { period: next.period, status: next.status },
        }, session);
        return payrollPeriodSummary(next);
      },
    ));
  }

  async executeRun(key: string, input: ExecutePayrollRunInput): Promise<PayrollPeriodSummary> {
    this.assertScope('erp:payroll:run:execute');
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'system_job' && actor.actorType !== 'service') {
      throw new ForbiddenException({
        code: 'PAYROLL_RUN_SERVICE_REQUIRED', message: '工资计算只允许受信任计算服务执行',
      });
    }
    this.assertRunInput(input);
    return this.run(() => this.idempotency.execute(
      'payroll.run.execute', key, input, async (session) => {
      const current = await this.periods.findOne({
        tenantId: this.tenantId(), id: input.periodId,
      }).session(session).lean().exec();
      if (current === null) throw new NotFoundException({
        code: 'PAYROLL_PERIOD_NOT_FOUND', message: '工资周期不存在',
      });
      if (current.version !== input.expectedVersion) throw new Error('PAYROLL_VERSION_CONFLICT');
      const rulePack = await this.rulePacks.findOne({
        tenantId: this.tenantId(), id: input.rulePackId, version: input.rulePackVersion,
        status: 'published', effectiveFrom: { $lte: `${current.period}-01` },
        $or: [{ effectiveTo: null }, { effectiveTo: { $gte: monthEnd(current.period) } }],
      }).session(session).lean().exec();
      if (rulePack === null) throw new Error('PAYROLL_RULE_PACK_NOT_EFFECTIVE');
      const ruleSnapshot = toRuleSnapshot(rulePack);
      if (payrollDigest(ruleSnapshot) !== rulePack.rulesHash) {
        throw new Error('PAYROLL_RULE_PACK_INTEGRITY_FAILED');
      }
      const priorRun = await this.runs.findOne({
        tenantId: this.tenantId(), periodId: current.id,
      }).sort({ runNumber: -1 }).session(session).lean().exec();
      const runId = createEventId();
      const runNumber = (priorRun?.runNumber ?? 0) + 1;
      const calculated = await this.calculateLines(current, input.lines, ruleSnapshot, session);
      const inputSnapshotHash = payrollDigest(calculated.map((line) => ({
        employeeId: line.input.employeeId,
        compensationProfileId: line.reference.compensationProfileId,
        attendanceSnapshotId: line.reference.attendanceSnapshotId,
        attendanceSnapshotHash: line.attendanceSnapshotHash,
        inputHash: line.result.inputHash,
      })));
      const resultHash = payrollDigest(calculated.map((line) => ({
        employeeId: line.input.employeeId, resultHash: line.result.resultHash,
      })));
      const totals = totalsOf(calculated.map((line) => line.result));
      const completedAt = new Date();
      const firstLine = required(calculated[0]);
      await this.runs.create([{
        id: runId, tenantId: this.tenantId(), periodId: current.id, period: current.period,
        runNumber, engineVersion: firstLine.input.engineVersion,
        rulePackId: rulePack.id, rulePackVersion: rulePack.version, status: 'completed',
        inputSnapshotHash, resultHash, employeeCount: calculated.length,
        ...totals, completedAt,
      }], { session });
      for (const line of calculated) {
        const snapshotId = createEventId();
        const inputCiphertext = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'input_snapshot',
          resourceId: snapshotId, version: 1,
        }, line.input);
        await this.snapshots.create([{
          id: snapshotId, tenantId: this.tenantId(), runId, periodId: current.id,
          employeeId: line.input.employeeId,
          compensationProfileId: line.reference.compensationProfileId,
          attendanceSnapshotId: line.reference.attendanceSnapshotId,
          attendanceSnapshotHash: line.attendanceSnapshotHash,
          inputHash: line.result.inputHash, ...protectedRecord(inputCiphertext),
        }], { session });
        const calculationLineId = createEventId();
        const resultCiphertext = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'calculation_line',
          resourceId: calculationLineId, version: 1,
        }, line.result);
        await this.calculationLines.create([{
          id: calculationLineId, tenantId: this.tenantId(), runId, periodId: current.id,
          employeeId: line.input.employeeId, resultHash: line.result.resultHash,
          ...protectedRecord(resultCiphertext),
        }], { session });
      }
      const next = recordPayrollCalculation(payrollPeriodFromRecord(current), {
        tenantId: this.tenantId(), expectedVersion: input.expectedVersion,
        run: {
          id: runId, inputSnapshotHash, resultHash, employeeCount: calculated.length,
          totalGrossMinor: totals.totalGrossMinor,
          totalTaxMinor: totals.totalTaxMinor,
          totalNetMinor: totals.totalNetMinor,
        },
      }, completedAt);
      await this.replacePeriod(current, next, session);
      await this.outbox.append({
        type: 'payroll.run.completed', tenantId: next.tenantId,
        aggregateId: next.id, version: next.version, occurredAt: next.updatedAt,
        data: {
          period: next.period, status: next.status, runId,
          inputSnapshotHash, resultHash, employeeCount: calculated.length,
          totalGrossMinor: totals.totalGrossMinor, totalTaxMinor: totals.totalTaxMinor,
          totalNetMinor: totals.totalNetMinor,
        },
      }, session);
      return payrollPeriodSummary(next);
      },
    ));
  }

  async getPeriod(id: string): Promise<PayrollPeriodSummary> {
    this.assertScope('erp:payroll:period:read');
    if (!ID_PATTERN.test(id)) throw new BadRequestException({
      code: 'PAYROLL_PERIOD_ID_INVALID', message: '工资周期标识非法',
    });
    const current = await this.periods.findOne({ tenantId: this.tenantId(), id }).lean().exec();
    if (current === null) throw new NotFoundException({
      code: 'PAYROLL_PERIOD_NOT_FOUND', message: '工资周期不存在',
    });
    return payrollPeriodSummary(payrollPeriodFromRecord(current));
  }

  private async calculateLines(
    period: PayrollPeriodRecord,
    lines: readonly PayrollRunLineInput[],
    rulePack: PayrollRulePackSnapshot,
    session: ClientSession,
  ) {
    const sorted = [...lines].sort((left, right) => left.employeeId.localeCompare(right.employeeId));
    const output: Array<{
      readonly input: PayrollCalculationInput;
      readonly result: PayrollCalculationResult;
      readonly reference: PayrollRunLineInput;
      readonly attendanceSnapshotHash: string;
    }> = [];
    for (const line of sorted) {
      this.assertLineReference(line);
      const compensation = await this.compensationProfiles.findOne({
        tenantId: this.tenantId(), id: line.compensationProfileId,
        employeeId: line.employeeId, status: 'active',
        effectiveFrom: { $lte: `${period.period}-01` },
        $or: [{ effectiveTo: null }, { effectiveTo: { $gte: monthEnd(period.period) } }],
      }).session(session).lean().exec();
      if (compensation === null) throw new Error('PAYROLL_COMPENSATION_PROFILE_NOT_EFFECTIVE');
      const attendance = await this.attendanceSnapshots.findOne({
        tenantId: this.tenantId(), id: line.attendanceSnapshotId,
        employeeId: line.employeeId, month: period.period,
        status: 'active',
      }).session(session).lean().exec();
      if (attendance === null) throw new Error('PAYROLL_ATTENDANCE_SNAPSHOT_INVALID');
      const profileData = compensationProfileDataSchema.parse(this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'compensation_profile',
        resourceId: compensation.id, version: compensation.version,
      }, protectedValue(compensation)));
      if (payrollDigest(profileData) !== compensation.profileHash) {
        throw new Error('PAYROLL_COMPENSATION_PROFILE_INTEGRITY_FAILED');
      }
      const cumulativeBefore = await this.resolveCumulativeBefore(
        period, line.employeeId, session,
      );
      const overtimePayMinor = safeMultiply(
        attendance.overtimeMinutes,
        profileData.attendanceAdjustment.overtimePayMinorPerMinute,
      );
      const attendanceDeductionMinor = safeAddMinor(
        safeMultiply(
          attendance.absentMinutes,
          profileData.attendanceAdjustment.absenceDeductionMinorPerMinute,
        ),
        safeMultiply(
          attendance.leaveMinutes,
          profileData.attendanceAdjustment.unpaidLeaveDeductionMinorPerMinute,
        ),
      );
      const calculation: PayrollCalculationInput = Object.freeze({
        tenantId: this.tenantId(), employeeId: line.employeeId, period: period.period,
        currency: profileData.currency, engineVersion: PAYROLL_ENGINE_VERSION, rulePack,
        taxableEarnings: Object.freeze([
          ...profileData.taxableEarnings,
          ...(overtimePayMinor === 0 ? [] : [{ code: 'ATTENDANCE_OVERTIME', amountMinor: overtimePayMinor }]),
        ]),
        nonTaxableEarnings: Object.freeze([...profileData.nonTaxableEarnings]),
        employeeSocialInsuranceMinor: profileData.employeeSocialInsuranceMinor,
        employeeHousingFundMinor: profileData.employeeHousingFundMinor,
        specialAdditionalDeductionMinor: profileData.specialAdditionalDeductionMinor,
        otherPreTaxWithholdingMinor: profileData.otherPreTaxWithholdingMinor,
        postTaxDeductionMinor: safeAddMinor(
          profileData.postTaxDeductionMinor, attendanceDeductionMinor,
        ),
        cumulativeBefore,
      });
      output.push(Object.freeze({
        input: calculation, result: calculatePayroll(calculation), reference: line,
        attendanceSnapshotHash: attendance.snapshotHash,
      }));
    }
    return Object.freeze(output);
  }

  /** 累计预扣状态只能继承同税年、已经锁定或完成支付链路的最近工资结果。 */
  private async resolveCumulativeBefore(
    period: PayrollPeriodRecord,
    employeeId: string,
    session: ClientSession,
  ): Promise<PayrollCalculationInput['cumulativeBefore']> {
    const previousPeriods = await this.periods.find({
      tenantId: this.tenantId(), period: {
        $gte: `${period.period.slice(0, 4)}-01`, $lt: period.period,
      },
      status: { $in: ['locked', 'disbursing', 'reconciling', 'reconciled'] },
      activeRunId: { $type: 'string' },
    }).sort({ period: -1 }).limit(12).session(session).lean().exec();
    let previousLine: PayrollCalculationLineRecord | null = null;
    for (const previousPeriod of previousPeriods) {
      if (previousPeriod.activeRunId === null) continue;
      previousLine = await this.calculationLines.findOne({
        tenantId: this.tenantId(), runId: previousPeriod.activeRunId, employeeId,
      }).session(session).lean().exec();
      if (previousLine !== null) break;
    }
    if (previousLine === null) return zeroCumulative();
    const previousResult = payrollResultSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(), resourceType: 'calculation_line',
      resourceId: previousLine.id, version: 1,
    }, protectedValue(previousLine)));
    const { resultHash, ...resultWithoutHash } = previousResult;
    if (
      resultHash !== previousLine.resultHash ||
      payrollDigest(resultWithoutHash) !== resultHash
    ) {
      throw new Error('PAYROLL_PRIOR_RESULT_INTEGRITY_FAILED');
    }
    return Object.freeze({ ...previousResult.cumulativeAfter });
  }

  private async replacePeriod(
    current: PayrollPeriodRecord,
    next: PayrollPeriod,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.periods.updateOne(
      { tenantId: this.tenantId(), id: current.id, version: current.version, status: current.status },
      { $set: toMutablePayrollPeriodRecord(next) },
      { session, runValidators: true },
    );
    if (result.modifiedCount !== 1) throw new Error('PAYROLL_PERIOD_WRITE_CONFLICT');
  }

  private assertRunInput(input: ExecutePayrollRunInput): void {
    const rootKeys = Object.keys(input).sort().join(',');
    if (
      rootKeys !== 'expectedVersion,lines,periodId,rulePackId,rulePackVersion' ||
      !ID_PATTERN.test(input.periodId) || !ID_PATTERN.test(input.rulePackId) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      !Number.isSafeInteger(input.rulePackVersion) || input.rulePackVersion < 1 ||
      input.lines.length < 1 || input.lines.length > MAX_EMPLOYEES_PER_RUN ||
      new Set(input.lines.map((line) => line.employeeId)).size !== input.lines.length
    ) throw new BadRequestException({
      code: 'PAYROLL_RUN_INPUT_INVALID', message: '工资运行引用或批量范围非法',
    });
    input.lines.forEach((line) => this.assertLineReference(line));
  }

  private assertLineReference(line: PayrollRunLineInput): void {
    if (
      Object.keys(line).sort().join(',') !==
        'attendanceSnapshotId,compensationProfileId,employeeId' ||
      !ID_PATTERN.test(line.employeeId) || !ID_PATTERN.test(line.compensationProfileId) ||
      !ID_PATTERN.test(line.attendanceSnapshotId)
    ) throw new BadRequestException({
      code: 'PAYROLL_RUN_LINE_REFERENCE_INVALID', message: '工资员工行引用非法',
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof PayrollPeriodError || error instanceof PayrollCalculationError) {
        if (error.code.includes('TENANT')) throw new ForbiddenException({
          code: error.code, message: error.message,
        });
        if (
          error.code.includes('VERSION') || error.code.includes('TRANSITION') ||
          error.code.includes('REQUIRED') || error.code.includes('CONTROL')
        ) throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'PAYROLL_UNIQUE_CONFLICT', message: '工资周期、运行或员工快照已存在',
      });
      if (error instanceof z.ZodError) throw new BadRequestException({
        code: 'PAYROLL_PROTECTED_DATA_INVALID', message: '薪酬数据结构不符合当前版本',
      });
      if (
        error instanceof Error &&
        ['PAYROLL_VERSION_CONFLICT', 'PAYROLL_PERIOD_WRITE_CONFLICT'].includes(error.message)
      ) throw new ConflictException({ code: error.message, message: '工资周期并发版本冲突' });
      throw error;
    }
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少工资业务权限',
    });
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function toRuleSnapshot(record: PayrollRulePackRecord): PayrollRulePackSnapshot {
  return Object.freeze({
    id: record.id, version: record.version,
    monthlyBasicDeductionMinor: record.monthlyBasicDeductionMinor,
    taxBrackets: Object.freeze(record.taxBrackets.map((bracket) => Object.freeze({
      upperBoundMinor: bracket.upperBoundMinor, rateBps: bracket.rateBps,
      quickDeductionMinor: bracket.quickDeductionMinor,
    }))),
    roundingMode: record.roundingMode,
  });
}

function toPeriodRecord(period: PayrollPeriod): Record<string, unknown> {
  return {
    id: period.id, tenantId: period.tenantId, period: period.period, currency: period.currency,
    status: period.status, preparedBy: period.preparedBy, ...toMutablePayrollPeriodRecord(period),
  };
}

export function toMutablePayrollPeriodRecord(period: PayrollPeriod): Record<string, unknown> {
  return {
    status: period.status, activeRunId: period.activeRun?.id ?? null,
    inputSnapshotHash: period.activeRun?.inputSnapshotHash ?? null,
    resultHash: period.activeRun?.resultHash ?? null,
    employeeCount: period.activeRun?.employeeCount ?? null,
    totalGrossMinor: period.activeRun?.totalGrossMinor ?? null,
    totalTaxMinor: period.activeRun?.totalTaxMinor ?? null,
    totalNetMinor: period.activeRun?.totalNetMinor ?? null,
    approvalInstanceId: period.approvalInstanceId, approvedBy: period.approvedBy,
    approvalEvidenceId: period.approvalEvidenceId, lockedBy: period.lockedBy,
    strongAuthEvidenceId: period.strongAuthEvidenceId,
    disbursementBatchId: period.disbursementBatchId,
    disbursementPreparedBy: period.disbursementPreparedBy,
    disbursementExportEvidenceId: period.disbursementExportEvidenceId,
    reconciliationEvidenceId: period.reconciliationEvidenceId,
    reconciledBy: period.reconciledBy, version: period.version,
  };
}

export function payrollPeriodFromRecord(record: PayrollPeriodRecord): PayrollPeriod {
  const activeRun = record.activeRunId === null ? null : Object.freeze({
    id: record.activeRunId,
    inputSnapshotHash: required(record.inputSnapshotHash), resultHash: required(record.resultHash),
    employeeCount: required(record.employeeCount), totalGrossMinor: required(record.totalGrossMinor),
    totalTaxMinor: required(record.totalTaxMinor), totalNetMinor: required(record.totalNetMinor),
  });
  return Object.freeze({
    id: record.id, tenantId: record.tenantId, period: record.period, currency: record.currency,
    status: record.status, preparedBy: record.preparedBy, activeRun,
    approvalInstanceId: record.approvalInstanceId, approvedBy: record.approvedBy,
    approvalEvidenceId: record.approvalEvidenceId, lockedBy: record.lockedBy,
    strongAuthEvidenceId: record.strongAuthEvidenceId,
    disbursementBatchId: record.disbursementBatchId,
    disbursementPreparedBy: record.disbursementPreparedBy,
    disbursementExportEvidenceId: record.disbursementExportEvidenceId,
    reconciliationEvidenceId: record.reconciliationEvidenceId,
    reconciledBy: record.reconciledBy, version: record.version,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  });
}

export function payrollPeriodSummary(period: PayrollPeriod): PayrollPeriodSummary {
  return Object.freeze({
    id: period.id, period: period.period, status: period.status, version: period.version,
    activeRunId: period.activeRun?.id ?? null,
    inputSnapshotHash: period.activeRun?.inputSnapshotHash ?? null,
    resultHash: period.activeRun?.resultHash ?? null,
    employeeCount: period.activeRun?.employeeCount ?? null,
    totalGrossMinor: period.activeRun?.totalGrossMinor ?? null,
    totalTaxMinor: period.activeRun?.totalTaxMinor ?? null,
    totalNetMinor: period.activeRun?.totalNetMinor ?? null,
  });
}

function totalsOf(results: readonly PayrollCalculationResult[]) {
  const values = results.reduce((totals, result) => ({
    gross: totals.gross + BigInt(result.grossPayMinor),
    tax: totals.tax + BigInt(result.withholdingTaxMinor),
    net: totals.net + BigInt(result.netPayMinor),
  }), { gross: 0n, tax: 0n, net: 0n });
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (
    values.gross > limit || values.net > limit || values.tax > limit || values.tax < -limit
  ) throw new Error('PAYROLL_RUN_TOTAL_OVERFLOW');
  return Object.freeze({
    totalGrossMinor: Number(values.gross), totalTaxMinor: Number(values.tax),
    totalNetMinor: Number(values.net),
  });
}

function protectedRecord(value: {
  readonly keyId: string; readonly iv: string; readonly ciphertext: string; readonly authTag: string;
}): Record<string, string> {
  return {
    dataKeyId: value.keyId, dataIv: value.iv,
    dataCiphertext: value.ciphertext, dataAuthTag: value.authTag,
  };
}

function protectedValue(value: {
  readonly dataKeyId: string;
  readonly dataIv: string;
  readonly dataCiphertext: string;
  readonly dataAuthTag: string;
}) {
  return {
    keyId: value.dataKeyId, iv: value.dataIv,
    ciphertext: value.dataCiphertext, authTag: value.dataAuthTag,
  };
}

function zeroCumulative(): PayrollCalculationInput['cumulativeBefore'] {
  return Object.freeze({
    taxableIncomeMinor: 0, basicDeductionMinor: 0, socialInsuranceMinor: 0,
    housingFundMinor: 0, specialAdditionalDeductionMinor: 0,
    otherDeductionMinor: 0, taxWithheldMinor: 0,
  });
}

function monthEnd(period: string): string {
  const [yearText, monthText] = period.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('PAYROLL_PERIOD_INVALID');
  }
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(day).padStart(2, '0')}`;
}

function safeMultiply(left: number, right: number): number {
  const result = BigInt(left) * BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PAYROLL_AMOUNT_OVERFLOW');
  return Number(result);
}

function safeAddMinor(left: number, right: number): number {
  const result = BigInt(left) + BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PAYROLL_AMOUNT_OVERFLOW');
  return Number(result);
}

function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error('PAYROLL_PERIOD_RUN_REFERENCE_INCOMPLETE');
  }
  return value;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
