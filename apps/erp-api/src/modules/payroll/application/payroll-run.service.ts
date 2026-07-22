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
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
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
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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

export interface ImportPayrollPeriodFromMigrationInput {
  readonly targetId: string | null;
  readonly period: string;
  readonly status: 'draft' | 'collecting';
  readonly preparedByEmployeeId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface ImportPayrollCalculationRunLineFromMigrationInput extends PayrollRunLineInput {
  readonly expectedGrossMinor: number;
  readonly expectedWithholdingTaxMinor: number;
  readonly expectedNetMinor: number;
}

export interface ImportPayrollCalculationRunFromMigrationInput {
  readonly targetId: string | null;
  readonly periodId: string;
  readonly expectedPeriodVersion: number;
  readonly runNumber: number;
  readonly rulePackId: string;
  readonly rulePackVersion: number;
  readonly lines: readonly ImportPayrollCalculationRunLineFromMigrationInput[];
  readonly expectedEmployeeCount: number;
  readonly expectedTotalGrossMinor: number;
  readonly expectedTotalTaxMinor: number;
  readonly expectedTotalNetMinor: number;
  readonly completedAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface PayrollCalculationRunMigrationSummary extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
  readonly periodId: string;
  readonly runNumber: number;
  readonly inputSnapshotHash: string;
  readonly resultHash: string;
  readonly employeeCount: number;
  readonly totalGrossMinor: number;
  readonly totalTaxMinor: number;
  readonly totalNetMinor: number;
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

export interface LockedPayrollDisbursementSource {
  readonly periodId: string;
  readonly period: string;
  readonly payrollRunId: string;
  readonly payrollLockedBy: string;
  readonly payrollVersion: number;
  readonly resultHash: string;
  readonly totalNetMinor: number;
  readonly lines: readonly {
    readonly calculationLineId: string;
    readonly employeeId: string;
    readonly netPayMinor: number;
    readonly resultHash: string;
  }[];
}

interface CalculatedPayrollLine {
  readonly input: PayrollCalculationInput;
  readonly result: PayrollCalculationResult;
  readonly reference: PayrollRunLineInput;
  readonly attendanceSnapshotHash: string;
}

/** 工资周期与计算运行应用服务；仅系统任务可提交已冻结的规范输入。 */
@Injectable()
export class PayrollRunService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly profiles: AccessProfileRepository,
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

  /** 迁移专用：只恢复未进入计算/审批链的工资周期基线。 */
  async importPeriodFromMigration(
    key: string,
    input: ImportPayrollPeriodFromMigrationInput,
  ): Promise<PayrollPeriodSummary> {
    this.assertMigrationWriter();
    assertPeriodMigrationInput(input);
    return this.run(() => this.idempotency.execute(
      'payroll.period.import_from_migration', key, input, async (session) => {
        const preparedBy = await this.profiles.findActorIdByEmployee(
          this.tenantId(), input.preparedByEmployeeId, session,
        );
        if (preparedBy === null) throw new NotFoundException({
          code: 'PAYROLL_MIGRATION_PREPARER_IDENTITY_NOT_FOUND',
          message: '迁移工资周期制单员工未绑定可信身份',
        });
        if (input.targetId !== null) {
          const existing = await this.periods.findOne({
            tenantId: this.tenantId(), id: input.targetId,
          }).session(session).lean().exec();
          if (existing === null || existing.period !== input.period ||
            existing.status !== input.status || existing.preparedBy !== preparedBy ||
            existing.version !== (input.status === 'draft' ? 1 : 2) ||
            existing.createdAt.toISOString() !== input.createdAt ||
            existing.updatedAt.toISOString() !== input.updatedAt ||
            existing.migrationEvidenceRef !== input.migrationEvidenceRef ||
            existing.migrationEvidenceChecksum !== input.evidenceChecksum ||
            existing.activeRunId !== null) throw new ConflictException({
            code: 'PAYROLL_MIGRATION_PERIOD_IMMUTABLE',
            message: '既有工资周期基线或 WORM 证据不一致，禁止覆盖',
          });
          return payrollPeriodSummary(payrollPeriodFromRecord(existing));
        }
        const createdAt = strictMigrationInstant(input.createdAt);
        const updatedAt = strictMigrationInstant(input.updatedAt);
        const id = createEventId(createdAt);
        let period = createPayrollPeriod({
          id, tenantId: this.tenantId(), period: input.period, preparedBy,
        }, createdAt);
        if (input.status === 'collecting') period = startPayrollCollection(period, {
          tenantId: this.tenantId(), expectedVersion: 1,
        }, updatedAt);
        await this.periods.create([{
          ...toPeriodRecord(period), createdAt, updatedAt,
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
        }], { session });
        await this.outbox.append({
          type: 'payroll.period.migrated', tenantId: period.tenantId,
          aggregateId: period.id, version: period.version, occurredAt: period.updatedAt,
          data: { period: period.period, status: period.status },
        }, session);
        return payrollPeriodSummary(period);
      },
    ));
  }

  /** 迁移专用：使用目标规则、薪酬与考勤事实重算，拒绝来源结果直写。 */
  async importCalculationRunFromMigration(
    key: string,
    input: ImportPayrollCalculationRunFromMigrationInput,
  ): Promise<PayrollCalculationRunMigrationSummary> {
    this.assertMigrationWriter();
    assertCalculationRunMigrationInput(input);
    return this.run(() => this.idempotency.execute(
      'payroll.run.import_from_migration', key, input, async (session) => {
        const current = await this.periods.findOne({
          tenantId: this.tenantId(), id: input.periodId,
        }).session(session).lean().exec();
        if (current === null) throw new NotFoundException({
          code: 'PAYROLL_MIGRATION_PERIOD_NOT_FOUND', message: '迁移工资周期不存在',
        });
        if (input.targetId !== null) {
          return this.verifyMigratedRunReplay(current, input, session);
        }
        const expectedStatus = input.runNumber === 1 ? 'collecting' : 'review';
        if (current.status !== expectedStatus || current.version !== input.expectedPeriodVersion) {
          throw new ConflictException({
            code: 'PAYROLL_MIGRATION_PERIOD_STATE_INVALID',
            message: '迁移计算只能按运行序号写入声明版本的采集或复核周期',
          });
        }
        const rulePack = await this.requireEffectiveRulePack(
          current, input.rulePackId, input.rulePackVersion, session,
        );
        const priorRun = await this.runs.findOne({
          tenantId: this.tenantId(), periodId: current.id,
        }).sort({ runNumber: -1 }).session(session).lean().exec();
        if ((priorRun?.runNumber ?? 0) + 1 !== input.runNumber) throw new ConflictException({
          code: 'PAYROLL_MIGRATION_RUN_CHAIN_INVALID', message: '迁移工资运行序号不连续',
        });
        if (priorRun === null && (current.activeRunId !== null ||
          current.inputSnapshotHash !== null || current.resultHash !== null ||
          current.employeeCount !== null || current.totalGrossMinor !== null ||
          current.totalTaxMinor !== null || current.totalNetMinor !== null)) {
          throw new ConflictException({
            code: 'PAYROLL_MIGRATION_RUN_CHAIN_INVALID',
            message: '迁移工资首个运行的周期基线不为空',
          });
        }
        if (priorRun !== null && (priorRun.migrationEvidenceRef === null ||
          priorRun.migrationEvidenceChecksum === null || current.activeRunId !== priorRun.id ||
          current.inputSnapshotHash !== priorRun.inputSnapshotHash ||
          current.resultHash !== priorRun.resultHash ||
          current.employeeCount !== priorRun.employeeCount ||
          current.totalGrossMinor !== priorRun.totalGrossMinor ||
          current.totalTaxMinor !== priorRun.totalTaxMinor ||
          current.totalNetMinor !== priorRun.totalNetMinor)) throw new ConflictException({
          code: 'PAYROLL_MIGRATION_PRIOR_RUN_INTEGRITY_FAILED',
          message: '迁移工资前一运行不是完整可信的迁移重算结果',
        });
        const completedAt = strictMigrationInstant(input.completedAt);
        if (completedAt.getTime() < current.updatedAt.getTime()) throw new BadRequestException({
          code: 'PAYROLL_MIGRATION_RUN_TIME_INVALID', message: '计算完成时间早于工资周期基线',
        });
        const calculated = await this.calculateLines(
          current, input.lines.map(lineReference), toRuleSnapshot(rulePack), session, true,
        );
        assertMigrationRunControls(input, calculated);
        const runId = createEventId(completedAt);
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
        const firstLine = required(calculated[0]);
        const runRecord = {
          id: runId, tenantId: this.tenantId(), periodId: current.id, period: current.period,
          runNumber: input.runNumber, engineVersion: firstLine.input.engineVersion,
          rulePackId: rulePack.id, rulePackVersion: rulePack.version, status: 'completed' as const,
          inputSnapshotHash, resultHash, employeeCount: calculated.length, ...totals,
          completedAt, createdAt: completedAt, updatedAt: completedAt,
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
        };
        await this.runs.create([runRecord], { session });
        await this.writeCalculatedLines(current, runId, calculated, completedAt, session);
        const next = recordPayrollCalculation(payrollPeriodFromRecord(current), {
          tenantId: this.tenantId(), expectedVersion: input.expectedPeriodVersion,
          run: {
            id: runId, inputSnapshotHash, resultHash, employeeCount: calculated.length,
            totalGrossMinor: totals.totalGrossMinor, totalTaxMinor: totals.totalTaxMinor,
            totalNetMinor: totals.totalNetMinor,
          },
        }, completedAt);
        await this.replacePeriod(current, next, session, true);
        await this.outbox.append({
          type: 'payroll.run.migrated', tenantId: next.tenantId,
          aggregateId: next.id, version: next.version, occurredAt: next.updatedAt,
          data: {
            period: next.period, status: next.status, runId,
            inputSnapshotHash, resultHash, employeeCount: calculated.length,
            totalGrossMinor: totals.totalGrossMinor, totalTaxMinor: totals.totalTaxMinor,
            totalNetMinor: totals.totalNetMinor,
          },
        }, session);
        return migrationRunSummary(runRecord);
      },
    ));
  }

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

  /** Treasury 内部只读端口：只输出已锁定且通过逐行与运行级摘要复核的实发来源。 */
  async getLockedDisbursementSource(
    periodId: string,
    expectedVersion: number,
  ): Promise<LockedPayrollDisbursementSource> {
    this.assertScope('erp:treasury:disbursement:prepare');
    if (!ID_PATTERN.test(periodId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new BadRequestException({
        code: 'PAYROLL_DISBURSEMENT_SOURCE_REFERENCE_INVALID', message: '代发工资来源引用非法',
      });
    }
    const period = await this.periods.findOne({
      tenantId: this.tenantId(), id: periodId,
    }).lean().exec();
    if (
      period === null || period.version !== expectedVersion || period.status !== 'locked' ||
      period.activeRunId === null || period.lockedBy === null || period.resultHash === null ||
      period.employeeCount === null || period.totalNetMinor === null
    ) throw new ConflictException({
      code: 'PAYROLL_DISBURSEMENT_SOURCE_NOT_LOCKED', message: '工资周期未锁定或版本已变化',
    });
    const records = await this.calculationLines.find({
      tenantId: this.tenantId(), periodId: period.id, runId: period.activeRunId,
    }).sort({ employeeId: 1 }).lean().exec();
    if (
      records.length !== period.employeeCount || records.length < 1 ||
      new Set(records.map((record) => record.employeeId)).size !== records.length
    ) throw new ConflictException({
      code: 'PAYROLL_DISBURSEMENT_SOURCE_INTEGRITY_FAILED', message: '锁定工资员工行不完整',
    });
    const lines = records.map((record) => {
      try {
        const result = payrollResultSchema.parse(this.crypto.unprotect({
          tenantId: this.tenantId(), resourceType: 'calculation_line',
          resourceId: record.id, version: 1,
        }, protectedValue(record)));
        const { resultHash, ...withoutHash } = result;
        if (resultHash !== record.resultHash || payrollDigest(withoutHash) !== resultHash) {
          throw new Error('PAYROLL_RESULT_HASH_MISMATCH');
        }
        return Object.freeze({
          calculationLineId: record.id, employeeId: record.employeeId,
          netPayMinor: result.netPayMinor, resultHash,
        });
      } catch {
        throw new ConflictException({
          code: 'PAYROLL_DISBURSEMENT_SOURCE_INTEGRITY_FAILED', message: '锁定工资结果完整性失败',
        });
      }
    });
    const aggregateHash = payrollDigest(lines.map((line) => ({
      employeeId: line.employeeId, resultHash: line.resultHash,
    })));
    const total = lines.reduce((sum, line) => sum + BigInt(line.netPayMinor), 0n);
    if (
      aggregateHash !== period.resultHash || total !== BigInt(period.totalNetMinor) ||
      total > BigInt(Number.MAX_SAFE_INTEGER)
    ) throw new ConflictException({
      code: 'PAYROLL_DISBURSEMENT_SOURCE_INTEGRITY_FAILED', message: '锁定工资运行汇总不一致',
    });
    return Object.freeze({
      periodId: period.id, period: period.period, payrollRunId: period.activeRunId,
      payrollLockedBy: period.lockedBy, payrollVersion: period.version,
      resultHash: period.resultHash, totalNetMinor: Number(total),
      lines: Object.freeze(lines),
    });
  }

  private async requireEffectiveRulePack(
    period: PayrollPeriodRecord,
    rulePackId: string,
    rulePackVersion: number,
    session: ClientSession,
  ): Promise<PayrollRulePackRecord> {
    const rulePack = await this.rulePacks.findOne({
      tenantId: this.tenantId(), id: rulePackId, version: rulePackVersion,
      status: 'published', effectiveFrom: { $lte: `${period.period}-01` },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: monthEnd(period.period) } }],
    }).session(session).lean().exec();
    if (rulePack === null) throw new Error('PAYROLL_RULE_PACK_NOT_EFFECTIVE');
    if (payrollDigest(toRuleSnapshot(rulePack)) !== rulePack.rulesHash) {
      throw new Error('PAYROLL_RULE_PACK_INTEGRITY_FAILED');
    }
    return rulePack;
  }

  private async writeCalculatedLines(
    period: PayrollPeriodRecord,
    runId: string,
    calculated: readonly CalculatedPayrollLine[],
    occurredAt: Date,
    session: ClientSession,
  ): Promise<void> {
    for (let offset = 0; offset < calculated.length; offset += 250) {
      const chunk = calculated.slice(offset, offset + 250);
      const snapshotRecords = chunk.map((line) => {
        const id = createEventId(occurredAt);
        const protectedData = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'input_snapshot', resourceId: id, version: 1,
        }, line.input);
        return {
          id, tenantId: this.tenantId(), runId, periodId: period.id,
          employeeId: line.input.employeeId,
          compensationProfileId: line.reference.compensationProfileId,
          attendanceSnapshotId: line.reference.attendanceSnapshotId,
          attendanceSnapshotHash: line.attendanceSnapshotHash,
          inputHash: line.result.inputHash, ...protectedRecord(protectedData),
          createdAt: occurredAt, updatedAt: occurredAt,
        };
      });
      const calculationRecords = chunk.map((line) => {
        const id = createEventId(occurredAt);
        const protectedData = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'calculation_line', resourceId: id, version: 1,
        }, line.result);
        return {
          id, tenantId: this.tenantId(), runId, periodId: period.id,
          employeeId: line.input.employeeId, resultHash: line.result.resultHash,
          ...protectedRecord(protectedData), createdAt: occurredAt, updatedAt: occurredAt,
        };
      });
      await this.snapshots.create(snapshotRecords, { session });
      await this.calculationLines.create(calculationRecords, { session });
    }
  }

  private async verifyMigratedRunReplay(
    period: PayrollPeriodRecord,
    input: ImportPayrollCalculationRunFromMigrationInput,
    session: ClientSession,
  ): Promise<PayrollCalculationRunMigrationSummary> {
    const run = await this.runs.findOne({
      tenantId: this.tenantId(), id: input.targetId,
    }).session(session).lean().exec();
    if (run === null || run.periodId !== input.periodId || run.period !== period.period ||
      run.runNumber !== input.runNumber || run.engineVersion !== PAYROLL_ENGINE_VERSION ||
      run.rulePackId !== input.rulePackId || run.rulePackVersion !== input.rulePackVersion ||
      run.status !== 'completed' || run.employeeCount !== input.expectedEmployeeCount ||
      run.totalGrossMinor !== input.expectedTotalGrossMinor ||
      run.totalTaxMinor !== input.expectedTotalTaxMinor ||
      run.totalNetMinor !== input.expectedTotalNetMinor ||
      run.completedAt.toISOString() !== input.completedAt ||
      run.createdAt.toISOString() !== input.completedAt ||
      run.updatedAt.toISOString() !== input.completedAt ||
      run.migrationEvidenceRef !== input.migrationEvidenceRef ||
      run.migrationEvidenceChecksum !== input.evidenceChecksum ||
      period.status !== 'review' || period.version !== input.expectedPeriodVersion + 1 ||
      period.activeRunId !== run.id || period.inputSnapshotHash !== run.inputSnapshotHash ||
      period.resultHash !== run.resultHash || period.employeeCount !== run.employeeCount ||
      period.totalGrossMinor !== run.totalGrossMinor || period.totalTaxMinor !== run.totalTaxMinor ||
      period.totalNetMinor !== run.totalNetMinor ||
      period.updatedAt.toISOString() !== input.completedAt) throw new ConflictException({
      code: 'PAYROLL_MIGRATION_RUN_IMMUTABLE',
      message: '既有工资计算运行、周期引用或 WORM 证据不一致，禁止覆盖',
    });
    const [snapshots, resultLines] = await Promise.all([
      this.snapshots.find({ tenantId: this.tenantId(), runId: run.id })
        .sort({ employeeId: 1 }).session(session).lean().exec(),
      this.calculationLines.find({ tenantId: this.tenantId(), runId: run.id })
        .sort({ employeeId: 1 }).session(session).lean().exec(),
    ]);
    const expected = [...input.lines].sort((left, right) =>
      left.employeeId.localeCompare(right.employeeId));
    if (snapshots.length !== expected.length || resultLines.length !== expected.length) {
      throw migratedRunImmutable();
    }
    const verified: PayrollCalculationResult[] = [];
    for (const [index, expectedLine] of expected.entries()) {
      const snapshot = required(snapshots[index]);
      const resultLine = required(resultLines[index]);
      if (snapshot.employeeId !== expectedLine.employeeId ||
        resultLine.employeeId !== expectedLine.employeeId ||
        snapshot.compensationProfileId !== expectedLine.compensationProfileId ||
        snapshot.attendanceSnapshotId !== expectedLine.attendanceSnapshotId) {
        throw migratedRunImmutable();
      }
      const protectedInput = this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'input_snapshot',
        resourceId: snapshot.id, version: 1,
      }, protectedValue(snapshot)) as PayrollCalculationInput;
      if (protectedInput.tenantId !== this.tenantId() ||
        protectedInput.employeeId !== expectedLine.employeeId ||
        protectedInput.period !== period.period || protectedInput.currency !== 'CNY' ||
        protectedInput.engineVersion !== PAYROLL_ENGINE_VERSION ||
        protectedInput.rulePack.id !== input.rulePackId ||
        protectedInput.rulePack.version !== input.rulePackVersion) throw migratedRunImmutable();
      const recalculated = calculatePayroll(protectedInput);
      const stored = payrollResultSchema.parse(this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'calculation_line',
        resourceId: resultLine.id, version: 1,
      }, protectedValue(resultLine)));
      if (recalculated.inputHash !== snapshot.inputHash ||
        recalculated.resultHash !== resultLine.resultHash ||
        payrollDigest(recalculated) !== payrollDigest(stored) ||
        stored.grossPayMinor !== expectedLine.expectedGrossMinor ||
        stored.withholdingTaxMinor !== expectedLine.expectedWithholdingTaxMinor ||
        stored.netPayMinor !== expectedLine.expectedNetMinor) throw migratedRunImmutable();
      verified.push(recalculated);
    }
    const inputSnapshotHash = payrollDigest(snapshots.map((snapshot) => ({
      employeeId: snapshot.employeeId,
      compensationProfileId: snapshot.compensationProfileId,
      attendanceSnapshotId: snapshot.attendanceSnapshotId,
      attendanceSnapshotHash: snapshot.attendanceSnapshotHash,
      inputHash: snapshot.inputHash,
    })));
    const resultHash = payrollDigest(resultLines.map((line) => ({
      employeeId: line.employeeId, resultHash: line.resultHash,
    })));
    const totals = totalsOf(verified);
    if (inputSnapshotHash !== run.inputSnapshotHash || resultHash !== run.resultHash ||
      totals.totalGrossMinor !== run.totalGrossMinor || totals.totalTaxMinor !== run.totalTaxMinor ||
      totals.totalNetMinor !== run.totalNetMinor) throw migratedRunImmutable();
    return migrationRunSummary(run);
  }

  private async calculateLines(
    period: PayrollPeriodRecord,
    lines: readonly PayrollRunLineInput[],
    rulePack: PayrollRulePackSnapshot,
    session: ClientSession,
    allowMigratedPrior = false,
  ): Promise<readonly CalculatedPayrollLine[]> {
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
        period, line.employeeId, session, allowMigratedPrior,
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
    allowMigratedPrior: boolean,
  ): Promise<PayrollCalculationInput['cumulativeBefore']> {
    const trustedStatuses: PayrollPeriod['status'][] = allowMigratedPrior
      ? ['review', 'pending_approval', 'approved', 'locked', 'disbursing', 'reconciling', 'reconciled']
      : ['locked', 'disbursing', 'reconciling', 'reconciled'];
    const previousPeriods = await this.periods.find({
      tenantId: this.tenantId(), period: {
        $gte: `${period.period.slice(0, 4)}-01`, $lt: period.period,
      },
      status: { $in: trustedStatuses },
      activeRunId: { $type: 'string' },
    }).sort({ period: -1 }).limit(12).session(session).lean().exec();
    let previousLine: PayrollCalculationLineRecord | null = null;
    for (const previousPeriod of previousPeriods) {
      if (previousPeriod.activeRunId === null) continue;
      if (['review', 'pending_approval', 'approved'].includes(previousPeriod.status)) {
        const migratedRun = await this.runs.findOne({
          tenantId: this.tenantId(), id: previousPeriod.activeRunId,
          periodId: previousPeriod.id, status: 'completed',
        }).session(session).lean().exec();
        if (migratedRun === null || (migratedRun.migrationEvidenceRef === null &&
          migratedRun.migrationEvidenceChecksum === null)) continue;
        if (migratedRun.migrationEvidenceRef === null ||
          migratedRun.migrationEvidenceChecksum === null ||
          migratedRun.resultHash !== previousPeriod.resultHash ||
          migratedRun.inputSnapshotHash !== previousPeriod.inputSnapshotHash ||
          migratedRun.employeeCount !== previousPeriod.employeeCount ||
          migratedRun.totalGrossMinor !== previousPeriod.totalGrossMinor ||
          migratedRun.totalTaxMinor !== previousPeriod.totalTaxMinor ||
          migratedRun.totalNetMinor !== previousPeriod.totalNetMinor) {
          throw new Error('PAYROLL_MIGRATION_PRIOR_RUN_INTEGRITY_FAILED');
        }
      }
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
    preserveHistoricalTimestamp = false,
  ): Promise<void> {
    const result = await this.periods.updateOne(
      { tenantId: this.tenantId(), id: current.id, version: current.version, status: current.status },
      { $set: {
        ...toMutablePayrollPeriodRecord(next),
        ...(preserveHistoricalTimestamp ? { updatedAt: new Date(next.updatedAt) } : {}),
      } },
      {
        session, runValidators: true,
        ...(preserveHistoricalTimestamp ? { timestamps: false } : {}),
      },
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

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:payroll:migration:write')) {
      throw new ForbiddenException({
        code: 'PAYROLL_MIGRATION_WRITER_DENIED',
        message: '工资运行迁移必须由受信任服务身份执行',
      });
    }
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

function migrationRunSummary(record: {
  readonly id: string;
  readonly periodId: string;
  readonly runNumber: number;
  readonly inputSnapshotHash: string;
  readonly resultHash: string;
  readonly employeeCount: number;
  readonly totalGrossMinor: number;
  readonly totalTaxMinor: number;
  readonly totalNetMinor: number;
}): PayrollCalculationRunMigrationSummary {
  return Object.freeze({
    id: record.id, version: record.runNumber, periodId: record.periodId,
    runNumber: record.runNumber, inputSnapshotHash: record.inputSnapshotHash,
    resultHash: record.resultHash, employeeCount: record.employeeCount,
    totalGrossMinor: record.totalGrossMinor, totalTaxMinor: record.totalTaxMinor,
    totalNetMinor: record.totalNetMinor,
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

function assertPeriodMigrationInput(input: ImportPayrollPeriodFromMigrationInput): void {
  const createdAt = strictMigrationInstant(input.createdAt);
  const updatedAt = strictMigrationInstant(input.updatedAt);
  if (Object.keys(input).sort().join(',') !==
      'createdAt,evidenceChecksum,migrationEvidenceRef,period,preparedByEmployeeId,status,targetId,updatedAt' ||
    (input.targetId !== null && !ULID_PATTERN.test(input.targetId)) ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period) ||
    !['draft', 'collecting'].includes(input.status) ||
    !ID_PATTERN.test(input.preparedByEmployeeId) ||
    !MIGRATION_EVIDENCE_REF_PATTERN.test(input.migrationEvidenceRef) ||
    !HASH_PATTERN.test(input.evidenceChecksum) || updatedAt.getTime() < createdAt.getTime() ||
    (input.status === 'draft' && updatedAt.getTime() !== createdAt.getTime())) {
    throw new BadRequestException({
      code: 'PAYROLL_MIGRATION_PERIOD_INPUT_INVALID', message: '迁移工资周期基线非法',
    });
  }
}

function assertCalculationRunMigrationInput(
  input: ImportPayrollCalculationRunFromMigrationInput,
): void {
  strictMigrationInstant(input.completedAt);
  if (Object.keys(input).sort().join(',') !==
      'completedAt,evidenceChecksum,expectedEmployeeCount,expectedPeriodVersion,expectedTotalGrossMinor,expectedTotalNetMinor,expectedTotalTaxMinor,lines,migrationEvidenceRef,periodId,rulePackId,rulePackVersion,runNumber,targetId' ||
    (input.targetId !== null && !ULID_PATTERN.test(input.targetId)) ||
    !ULID_PATTERN.test(input.periodId) || !ULID_PATTERN.test(input.rulePackId) ||
    !Number.isSafeInteger(input.expectedPeriodVersion) || input.expectedPeriodVersion < 2 ||
    !Number.isSafeInteger(input.runNumber) || input.runNumber < 1 || input.runNumber > 10_000 ||
    input.expectedPeriodVersion !== input.runNumber + 1 ||
    !Number.isSafeInteger(input.rulePackVersion) || input.rulePackVersion < 1 ||
    input.lines.length < 1 || input.lines.length > MAX_EMPLOYEES_PER_RUN ||
    input.expectedEmployeeCount !== input.lines.length ||
    !Number.isSafeInteger(input.expectedEmployeeCount) ||
    !nonnegativeSafeInteger(input.expectedTotalGrossMinor) ||
    !Number.isSafeInteger(input.expectedTotalTaxMinor) ||
    !nonnegativeSafeInteger(input.expectedTotalNetMinor) ||
    !MIGRATION_EVIDENCE_REF_PATTERN.test(input.migrationEvidenceRef) ||
    !HASH_PATTERN.test(input.evidenceChecksum) ||
    new Set(input.lines.map((line) => line.employeeId)).size !== input.lines.length) {
    throw new BadRequestException({
      code: 'PAYROLL_MIGRATION_RUN_INPUT_INVALID', message: '迁移工资计算运行控制信息非法',
    });
  }
  for (const line of input.lines) {
    if (Object.keys(line).sort().join(',') !==
      'attendanceSnapshotId,compensationProfileId,employeeId,expectedGrossMinor,expectedNetMinor,expectedWithholdingTaxMinor' ||
      !ID_PATTERN.test(line.employeeId) || !ULID_PATTERN.test(line.compensationProfileId) ||
      !ULID_PATTERN.test(line.attendanceSnapshotId) ||
      !nonnegativeSafeInteger(line.expectedGrossMinor) ||
      !Number.isSafeInteger(line.expectedWithholdingTaxMinor) ||
      !nonnegativeSafeInteger(line.expectedNetMinor)) throw new BadRequestException({
      code: 'PAYROLL_MIGRATION_RUN_LINE_INVALID', message: '迁移工资员工行引用或控制金额非法',
    });
  }
}

function assertMigrationRunControls(
  input: ImportPayrollCalculationRunFromMigrationInput,
  calculated: readonly CalculatedPayrollLine[],
): void {
  const expected = new Map(input.lines.map((line) => [line.employeeId, line]));
  for (const line of calculated) {
    const declared = expected.get(line.input.employeeId);
    if (declared === undefined || line.result.grossPayMinor !== declared.expectedGrossMinor ||
      line.result.withholdingTaxMinor !== declared.expectedWithholdingTaxMinor ||
      line.result.netPayMinor !== declared.expectedNetMinor) throw new ConflictException({
      code: 'PAYROLL_MIGRATION_RUN_LINE_MISMATCH',
      message: '目标确定性重算与来源员工行控制金额不一致',
    });
  }
  const totals = totalsOf(calculated.map((line) => line.result));
  if (calculated.length !== input.expectedEmployeeCount ||
    totals.totalGrossMinor !== input.expectedTotalGrossMinor ||
    totals.totalTaxMinor !== input.expectedTotalTaxMinor ||
    totals.totalNetMinor !== input.expectedTotalNetMinor) throw new ConflictException({
    code: 'PAYROLL_MIGRATION_RUN_TOTAL_MISMATCH',
    message: '目标确定性重算与来源工资运行汇总不一致',
  });
}

function lineReference(
  line: ImportPayrollCalculationRunLineFromMigrationInput,
): PayrollRunLineInput {
  return {
    employeeId: line.employeeId, compensationProfileId: line.compensationProfileId,
    attendanceSnapshotId: line.attendanceSnapshotId,
  };
}

function strictMigrationInstant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value ||
    parsed.getTime() > Date.now() + 5 * 60 * 1_000) throw new BadRequestException({
    code: 'PAYROLL_MIGRATION_TIME_INVALID', message: '薪资迁移时间必须为历史 UTC 毫秒时间',
  });
  return parsed;
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function migratedRunImmutable(): ConflictException {
  return new ConflictException({
    code: 'PAYROLL_MIGRATION_RUN_IMMUTABLE',
    message: '既有工资计算运行、密文快照或控制金额不一致，禁止覆盖',
  });
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
