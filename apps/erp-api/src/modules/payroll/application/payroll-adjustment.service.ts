import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  createPayrollAdjustment,
  payrollDigest,
  PayrollAdjustmentError,
  type PayrollCalculationResult,
} from '../domain/index.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollAdjustmentRecord,
  type PayrollAdjustmentDocument,
  PayrollCalculationLineRecord,
  type PayrollCalculationLineDocument,
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
} from '../persistence/payroll.schemas.js';
import {
  PayrollRunService,
  type PayrollRunLineInput,
} from './payroll-run.service.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const cumulativeSchema = z.object({
  taxableIncomeMinor: z.number().int().safe().nonnegative(),
  basicDeductionMinor: z.number().int().safe().nonnegative(),
  socialInsuranceMinor: z.number().int().safe().nonnegative(),
  housingFundMinor: z.number().int().safe().nonnegative(),
  specialAdditionalDeductionMinor: z.number().int().safe().nonnegative(),
  otherDeductionMinor: z.number().int().safe().nonnegative(),
  taxWithheldMinor: z.number().int().safe().nonnegative(),
}).strict();
const resultSchema = z.object({
  currency: z.literal('CNY'), inputHash: z.string().regex(HASH),
  grossPayMinor: z.number().int().safe().nonnegative(),
  taxableEarningsMinor: z.number().int().safe().nonnegative(),
  withholdingTaxMinor: z.number().int().safe(),
  netPayMinor: z.number().int().safe().nonnegative(),
  cumulativeAfter: cumulativeSchema, steps: z.array(z.unknown()),
  resultHash: z.string().regex(HASH),
}).strict();
const adjustmentSchema = z.object({
  type: z.enum(['supplement', 'reversal', 'tax_only']),
  currency: z.literal('CNY'), originalCalculationLineId: z.string().regex(ULID),
  originalInputHash: z.string().regex(HASH), originalResultHash: z.string().regex(HASH),
  correctedInputHash: z.string().regex(HASH), correctedResultHash: z.string().regex(HASH),
  reasonCode: z.string().regex(REASON),
  delta: z.object({
    grossPayMinor: z.number().int().safe(),
    taxableEarningsMinor: z.number().int().safe(),
    withholdingTaxMinor: z.number().int().safe(),
    netPayMinor: z.number().int().safe(),
    cumulativeAfter: z.object({
      taxableIncomeMinor: z.number().int().safe(),
      basicDeductionMinor: z.number().int().safe(),
      socialInsuranceMinor: z.number().int().safe(),
      housingFundMinor: z.number().int().safe(),
      specialAdditionalDeductionMinor: z.number().int().safe(),
      otherDeductionMinor: z.number().int().safe(),
      taxWithheldMinor: z.number().int().safe(),
    }).strict(),
  }).strict(),
  payableMinor: z.number().int().safe().nonnegative(),
  receivableMinor: z.number().int().safe().nonnegative(),
  adjustmentHash: z.string().regex(HASH),
}).strict();

export interface PreparePayrollAdjustmentInput {
  readonly periodId: string;
  readonly originalCalculationLineId: string;
  readonly rulePackId: string;
  readonly rulePackVersion: number;
  readonly reasonCode: string;
  readonly correctedLine: PayrollRunLineInput;
}

export interface PayrollAdjustmentSummary extends Record<string, unknown> {
  readonly id: string;
  readonly periodId: string;
  readonly period: string;
  readonly originalCalculationLineId: string;
  readonly adjustmentNumber: number;
  readonly type: 'supplement' | 'reversal' | 'tax_only';
  readonly reasonCode: string;
  readonly status:
    | 'prepared'
    | 'pending_approval'
    | 'approved'
    | 'locked'
    | 'settled'
    | 'cancelled';
  readonly version: number;
  readonly adjustmentHash: string;
  readonly grossDeltaMinor: number;
  readonly taxDeltaMinor: number;
  readonly netDeltaMinor: number;
  readonly payableMinor: number;
  readonly receivableMinor: number;
}

export interface PayrollAdjustmentControlSummary extends Record<string, unknown> {
  readonly id: string;
  readonly period: string;
  readonly adjustmentNumber: number;
  readonly type: 'supplement' | 'reversal' | 'tax_only';
  readonly reasonCode: string;
  readonly status: PayrollAdjustmentSummary['status'];
  readonly version: number;
  readonly adjustmentHash: string;
}

/** 锁定工资追加式更正；只准备差额，不执行补发支付、扣款或税务重报。 */
@Injectable()
export class PayrollAdjustmentService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly runs: PayrollRunService,
    private readonly crypto: PayrollDataCryptoService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
    @InjectModel(PayrollCalculationLineRecord.name)
    private readonly calculationLines: Model<PayrollCalculationLineDocument>,
    @InjectModel(PayrollAdjustmentRecord.name)
    private readonly adjustments: Model<PayrollAdjustmentDocument>,
  ) {}

  async prepare(
    key: string,
    input: PreparePayrollAdjustmentInput,
  ): Promise<PayrollAdjustmentSummary> {
    this.assertPrepareActor();
    assertPrepareInput(input);
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment.prepare', key, input, async (session) => {
        const period = await this.periods.findOne({
          tenantId: this.tenantId(), id: input.periodId,
        }).session(session).lean().exec();
        if (period === null) throw new NotFoundException({
          code: 'PAYROLL_ADJUSTMENT_PERIOD_NOT_FOUND', message: '工资调整原周期不存在',
        });
        if (!['locked', 'disbursing', 'reconciling', 'reconciled'].includes(period.status) ||
          period.activeRunId === null) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_PERIOD_NOT_LOCKED',
          message: '只有已锁定或后续终态工资周期可准备调整',
        });
        const originalLine = await this.calculationLines.findOne({
          tenantId: this.tenantId(), id: input.originalCalculationLineId,
          periodId: period.id, runId: period.activeRunId,
          employeeId: input.correctedLine.employeeId,
        }).session(session).lean().exec();
        if (originalLine === null) throw new NotFoundException({
          code: 'PAYROLL_ADJUSTMENT_ORIGINAL_LINE_NOT_FOUND',
          message: '活动锁定运行中不存在声明的原工资行',
        });
        const prior = await this.adjustments.findOne({
          tenantId: this.tenantId(),
          originalCalculationLineId: originalLine.id,
        }).sort({ adjustmentNumber: -1 }).session(session).lean().exec();
        if (prior !== null && prior.status !== 'cancelled') throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_ACTIVE_CHAIN_EXISTS',
          message: '原工资行已有未取消调整，必须先完成或关闭既有控制链',
        });
        const adjustmentNumber = (prior?.adjustmentNumber ?? 0) + 1;
        const original = resultSchema.parse(this.crypto.unprotect({
          tenantId: this.tenantId(), resourceType: 'calculation_line',
          resourceId: originalLine.id, version: 1,
        }, protectedValue(originalLine))) as PayrollCalculationResult;
        if (original.resultHash !== originalLine.resultHash) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_ORIGINAL_LINE_INTEGRITY_FAILED',
          message: '原工资行控制摘要与密文不一致',
        });
        const corrected = await this.runs.calculateAdjustmentCandidate(
          period, input.rulePackId, input.rulePackVersion, input.correctedLine, session,
        );
        const adjustment = createPayrollAdjustment({
          tenantId: this.tenantId(), employeeId: originalLine.employeeId,
          period: period.period, originalCalculationLineId: originalLine.id,
          reasonCode: input.reasonCode,
          originalPeriodStatus: period.status as
            | 'locked' | 'disbursing' | 'reconciling' | 'reconciled',
          original, corrected: corrected.result,
        });
        const now = new Date();
        const id = createEventId(now);
        const protectedData = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'payroll_adjustment',
          resourceId: id, version: 1,
        }, {
          originalResult: original,
          correctedInput: corrected.input,
          correctedResult: corrected.result,
          attendanceSnapshotHash: corrected.attendanceSnapshotHash,
          adjustment,
        });
        const record = {
          id, tenantId: this.tenantId(), periodId: period.id, period: period.period,
          originalRunId: period.activeRunId,
          originalCalculationLineId: originalLine.id,
          employeeId: originalLine.employeeId, adjustmentNumber,
          type: adjustment.type, reasonCode: adjustment.reasonCode,
          originalResultHash: adjustment.originalResultHash,
          correctedInputHash: adjustment.correctedInputHash,
          correctedResultHash: adjustment.correctedResultHash,
          adjustmentHash: adjustment.adjustmentHash,
          grossDeltaMinor: adjustment.delta.grossPayMinor,
          taxDeltaMinor: adjustment.delta.withholdingTaxMinor,
          netDeltaMinor: adjustment.delta.netPayMinor,
          payableMinor: adjustment.payableMinor,
          receivableMinor: adjustment.receivableMinor,
          preparedBy: this.context.getActorRequired().actorId,
          status: 'prepared' as const, version: 1,
          dataKeyId: protectedData.keyId, dataIv: protectedData.iv,
          dataCiphertext: protectedData.ciphertext, dataAuthTag: protectedData.authTag,
          createdAt: now, updatedAt: now,
        };
        await this.adjustments.create([record], { session });
        await this.outbox.append({
          type: 'payroll.adjustment.prepared', tenantId: this.tenantId(),
          aggregateId: id, version: 1, occurredAt: now.toISOString(),
          data: {
            period: period.period, type: adjustment.type,
            reasonCode: adjustment.reasonCode, status: 'prepared',
            adjustmentHash: adjustment.adjustmentHash,
          },
        }, session);
        return summary(record);
      },
    ));
  }

  async get(id: string): Promise<PayrollAdjustmentSummary> {
    this.assertScope('erp:payroll:adjustment:read');
    if (!ULID.test(id)) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_ID_INVALID', message: '工资调整标识非法',
    });
    const record = await this.adjustments.findOne({
      tenantId: this.tenantId(), id,
    }).lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'PAYROLL_ADJUSTMENT_NOT_FOUND', message: '工资调整不存在',
    });
    const bundle = z.object({ adjustment: adjustmentSchema }).passthrough().parse(
      this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'payroll_adjustment',
        resourceId: record.id, version: 1,
      }, protectedValue(record)),
    );
    const { adjustmentHash, ...withoutHash } = bundle.adjustment;
    if (
      payrollDigest({
        tenantId: record.tenantId, employeeId: record.employeeId,
        period: record.period, ...withoutHash,
      }) !== adjustmentHash ||
      adjustmentHash !== record.adjustmentHash ||
      bundle.adjustment.type !== record.type ||
      bundle.adjustment.reasonCode !== record.reasonCode ||
      bundle.adjustment.originalResultHash !== record.originalResultHash ||
      bundle.adjustment.correctedInputHash !== record.correctedInputHash ||
      bundle.adjustment.correctedResultHash !== record.correctedResultHash ||
      bundle.adjustment.delta.grossPayMinor !== record.grossDeltaMinor ||
      bundle.adjustment.delta.withholdingTaxMinor !== record.taxDeltaMinor ||
      bundle.adjustment.delta.netPayMinor !== record.netDeltaMinor ||
      bundle.adjustment.payableMinor !== record.payableMinor ||
      bundle.adjustment.receivableMinor !== record.receivableMinor
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_RECORD_INTEGRITY_FAILED',
      message: '工资调整控制字段与密文不一致',
    });
    return summary(record);
  }

  /** AI/控制面只读脱敏摘要；先执行完整密文一致性验证再删去人员与金额。 */
  async getControlStatus(id: string): Promise<PayrollAdjustmentControlSummary> {
    const value = await this.get(id);
    return Object.freeze({
      id: value.id, period: value.period,
      adjustmentNumber: value.adjustmentNumber, type: value.type,
      reasonCode: value.reasonCode, status: value.status,
      version: value.version, adjustmentHash: value.adjustmentHash,
    });
  }

  private assertPrepareActor(): void {
    this.assertScope('erp:payroll:adjustment:prepare');
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType)) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_SERVICE_REQUIRED',
      message: '工资更正重算只允许受信任计算服务执行',
    });
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少工资调整权限',
    });
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PayrollAdjustmentError) {
        if (error.code.includes('UNCHANGED') || error.code.includes('ZERO')) {
          throw new ConflictException({ code: error.code, message: error.message });
        }
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (error instanceof z.ZodError) throw new ConflictException({
        code: 'PAYROLL_ADJUSTMENT_PROTECTED_DATA_INVALID',
        message: '工资调整原结果密文结构非法',
      });
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'PAYROLL_ADJUSTMENT_WRITE_CONFLICT',
        message: '工资调整编号或标识冲突',
      });
      throw error;
    }
  }
}

function assertPrepareInput(input: PreparePayrollAdjustmentInput): void {
  const lineKeys = Object.keys(input.correctedLine).sort().join(',');
  const profileIds = [
    input.correctedLine.compensationProfileId,
    ...(input.correctedLine.additionalCompensationProfileIds ?? []),
  ];
  if (Object.keys(input).sort().join(',') !==
      'correctedLine,originalCalculationLineId,periodId,reasonCode,rulePackId,rulePackVersion' ||
    !ULID.test(input.periodId) || !ULID.test(input.originalCalculationLineId) ||
    !ULID.test(input.rulePackId) || !REASON.test(input.reasonCode) ||
    !Number.isSafeInteger(input.rulePackVersion) || input.rulePackVersion < 1 ||
    ![
      'attendanceSnapshotId,compensationProfileId,employeeId',
      'additionalCompensationProfileIds,attendanceSnapshotId,compensationProfileId,employeeId',
    ].includes(lineKeys) ||
    !ID.test(input.correctedLine.employeeId) ||
    !ID.test(input.correctedLine.attendanceSnapshotId) ||
    profileIds.length < 1 || profileIds.length > 31 ||
    profileIds.some((value) => !ID.test(value)) ||
    new Set(profileIds).size !== profileIds.length) {
    throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_INPUT_INVALID',
      message: '工资调整只接受规范引用、原因码与规则版本',
    });
  }
}

function summary(record: PayrollAdjustmentRecord): PayrollAdjustmentSummary {
  return Object.freeze({
    id: record.id, periodId: record.periodId, period: record.period,
    originalCalculationLineId: record.originalCalculationLineId,
    adjustmentNumber: record.adjustmentNumber, type: record.type,
    reasonCode: record.reasonCode, status: record.status, version: record.version,
    adjustmentHash: record.adjustmentHash,
    grossDeltaMinor: record.grossDeltaMinor, taxDeltaMinor: record.taxDeltaMinor,
    netDeltaMinor: record.netDeltaMinor, payableMinor: record.payableMinor,
    receivableMinor: record.receivableMinor,
  });
}

function protectedValue(record: {
  readonly dataKeyId: string;
  readonly dataIv: string;
  readonly dataCiphertext: string;
  readonly dataAuthTag: string;
}) {
  return {
    keyId: record.dataKeyId, iv: record.dataIv,
    ciphertext: record.dataCiphertext, authTag: record.dataAuthTag,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { readonly code?: unknown }).code === 11000;
}
