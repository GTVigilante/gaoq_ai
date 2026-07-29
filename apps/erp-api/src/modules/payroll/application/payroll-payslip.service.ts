import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';

import type { AppEnvironment } from '../../../config/environment.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import {
  calculatePayroll,
  payrollDigest,
  type PayrollAmountComponent,
  type PayrollCalculationInput,
  type PayrollCalculationResult,
} from '../domain/index.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import {
  PayrollCalculationLineRecord,
  type PayrollCalculationLineDocument,
  PayrollInputSnapshotRecord,
  type PayrollInputSnapshotDocument,
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
} from '../persistence/payroll.schemas.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PUBLISHED_STATUSES = ['locked', 'disbursing', 'reconciling', 'reconciled'] as const;
const amountSchema = z.number().int().safe().nonnegative();
const signedAmountSchema = z.number().int().safe();
const identifierSchema = z.string().regex(ID_PATTERN);
const hashSchema = z.string().regex(HASH_PATTERN);
const componentSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  amountMinor: amountSchema,
}).strict();
const cumulativeStateSchema = z.object({
  taxableIncomeMinor: amountSchema,
  basicDeductionMinor: amountSchema,
  socialInsuranceMinor: amountSchema,
  housingFundMinor: amountSchema,
  specialAdditionalDeductionMinor: amountSchema,
  otherDeductionMinor: amountSchema,
  taxWithheldMinor: amountSchema,
}).strict();
const payrollInputSchema = z.object({
  tenantId: identifierSchema,
  employeeId: identifierSchema,
  period: z.string().regex(MONTH_PATTERN),
  currency: z.literal('CNY'),
  engineVersion: identifierSchema,
  rulePack: z.object({
    id: identifierSchema,
    version: z.number().int().safe().positive(),
    monthlyBasicDeductionMinor: amountSchema,
    taxBrackets: z.array(z.object({
      upperBoundMinor: amountSchema.nullable(),
      rateBps: z.number().int().min(0).max(10_000),
      quickDeductionMinor: amountSchema,
    }).strict()).min(1).max(64),
    roundingMode: z.literal('HALF_UP'),
  }).strict(),
  taxableEarnings: z.array(componentSchema).max(128),
  nonTaxableEarnings: z.array(componentSchema).max(128),
  employeeSocialInsuranceMinor: amountSchema,
  employeeHousingFundMinor: amountSchema,
  specialAdditionalDeductionMinor: amountSchema,
  otherPreTaxWithholdingMinor: amountSchema,
  postTaxDeductionMinor: amountSchema,
  cumulativeBefore: cumulativeStateSchema,
}).strict();
const payrollResultSchema = z.object({
  currency: z.literal('CNY'),
  inputHash: hashSchema,
  grossPayMinor: amountSchema,
  taxableEarningsMinor: amountSchema,
  withholdingTaxMinor: signedAmountSchema,
  netPayMinor: amountSchema,
  cumulativeAfter: cumulativeStateSchema,
  steps: z.array(z.object({
    sequence: z.number().int().min(1).max(5),
    code: z.enum([
      'gross_pay',
      'cumulative_taxable_income',
      'cumulative_tax_liability',
      'withholding_tax',
      'net_pay',
    ]),
    amountMinor: signedAmountSchema,
    inputDigest: hashSchema,
    ruleVersion: z.number().int().safe().positive(),
    roundingMode: z.literal('HALF_UP'),
  }).strict()).length(5),
  resultHash: hashSchema,
}).strict();

export interface PayrollPayslipView extends Record<string, unknown> {
  readonly period: string;
  readonly currency: 'CNY';
  readonly taxableEarnings: readonly PayrollAmountComponent[];
  readonly nonTaxableEarnings: readonly PayrollAmountComponent[];
  readonly grossPayMinor: number;
  readonly employeeSocialInsuranceMinor: number;
  readonly employeeHousingFundMinor: number;
  /** 专项附加扣除只影响计税基础，不从实发再次扣减。 */
  readonly specialAdditionalDeductionMinor: number;
  readonly otherPreTaxWithholdingMinor: number;
  readonly postTaxDeductionMinor: number;
  readonly withholdingTaxMinor: number;
  readonly netPayMinor: number;
  readonly inputHash: string;
  readonly resultHash: string;
  readonly publishedAt: string;
}

/** 员工本人薪资单读取服务；不提供按 employeeId 查询的公共入口。 */
@Injectable()
export class PayrollPayslipService {
  constructor(
    private readonly context: TenantContextService,
    private readonly profiles: AccessProfileRepository,
    private readonly crypto: PayrollDataCryptoService,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
    @InjectModel(PayrollInputSnapshotRecord.name)
    private readonly inputs: Model<PayrollInputSnapshotDocument>,
    @InjectModel(PayrollCalculationLineRecord.name)
    private readonly results: Model<PayrollCalculationLineDocument>,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async getMyPayslip(period: string): Promise<PayrollPayslipView> {
    this.assertScope('erp:payroll:sheet:read_self');
    this.assertLegacyBoundary();
    if (typeof period !== 'string' || !MONTH_PATTERN.test(period)) throw new NotFoundException({
      code: 'PAYROLL_PAYSLIP_NOT_FOUND', message: '薪资单不存在或尚未发布',
    });
    const trusted = this.context.getRequired();
    if (trusted.actor.actorType !== 'user') throw new ForbiddenException({
      code: 'PAYROLL_PAYSLIP_USER_REQUIRED', message: '本人薪资单只允许人员主体读取',
    });
    const profile = await this.profiles.resolveActive(
      trusted.tenant.tenantId, trusted.actor.actorId,
    );
    if (profile === null) throw new ForbiddenException({
      code: 'PAYROLL_EMPLOYEE_IDENTITY_REQUIRED', message: '当前主体未绑定有效 ERP 员工身份',
    });
    if (!ID_PATTERN.test(profile.employeeId)) throw new ForbiddenException({
      code: 'PAYROLL_EMPLOYEE_IDENTITY_REQUIRED', message: '当前主体未绑定有效 ERP 员工身份',
    });
    const payrollPeriod = await this.periods.findOne({
      tenantId: trusted.tenant.tenantId, period,
      status: { $in: PUBLISHED_STATUSES }, activeRunId: { $type: 'string' },
    }).lean().exec();
    if (payrollPeriod === null || payrollPeriod.activeRunId === null) throw new NotFoundException({
      code: 'PAYROLL_PAYSLIP_NOT_FOUND', message: '薪资单不存在或尚未发布',
    });
    this.assertPeriodRecord(payrollPeriod, trusted.tenant.tenantId, period);
    const [inputRecord, resultRecord] = await Promise.all([
      this.inputs.findOne({
        tenantId: trusted.tenant.tenantId, runId: payrollPeriod.activeRunId,
        periodId: payrollPeriod.id, employeeId: profile.employeeId,
      }).lean().exec(),
      this.results.findOne({
        tenantId: trusted.tenant.tenantId, runId: payrollPeriod.activeRunId,
        periodId: payrollPeriod.id, employeeId: profile.employeeId,
      }).lean().exec(),
    ]);
    if (inputRecord === null || resultRecord === null) throw new NotFoundException({
      code: 'PAYROLL_PAYSLIP_NOT_FOUND', message: '薪资单不存在或尚未发布',
    });
    this.assertLineRecord(inputRecord, {
      tenantId: trusted.tenant.tenantId,
      runId: payrollPeriod.activeRunId,
      periodId: payrollPeriod.id,
      employeeId: profile.employeeId,
      hashField: 'inputHash',
    });
    this.assertLineRecord(resultRecord, {
      tenantId: trusted.tenant.tenantId,
      runId: payrollPeriod.activeRunId,
      periodId: payrollPeriod.id,
      employeeId: profile.employeeId,
      hashField: 'resultHash',
    });
    let input: PayrollCalculationInput;
    let result: PayrollCalculationResult;
    try {
      input = payrollInputSchema.parse(this.crypto.unprotect({
        tenantId: trusted.tenant.tenantId, resourceType: 'input_snapshot',
        resourceId: inputRecord.id, version: 1,
      }, protectedValue(inputRecord)));
      result = payrollResultSchema.parse(this.crypto.unprotect({
        tenantId: trusted.tenant.tenantId, resourceType: 'calculation_line',
        resourceId: resultRecord.id, version: 1,
      }, protectedValue(resultRecord)));
    } catch {
      throw integrityError();
    }
    this.assertIntegrity(input, result, inputRecord.inputHash, resultRecord.resultHash, {
      tenantId: trusted.tenant.tenantId, employeeId: profile.employeeId, period,
    });
    return Object.freeze({
      period, currency: result.currency,
      taxableEarnings: freezeComponents(input.taxableEarnings),
      nonTaxableEarnings: freezeComponents(input.nonTaxableEarnings),
      grossPayMinor: result.grossPayMinor,
      employeeSocialInsuranceMinor: input.employeeSocialInsuranceMinor,
      employeeHousingFundMinor: input.employeeHousingFundMinor,
      specialAdditionalDeductionMinor: input.specialAdditionalDeductionMinor,
      otherPreTaxWithholdingMinor: input.otherPreTaxWithholdingMinor,
      postTaxDeductionMinor: input.postTaxDeductionMinor,
      withholdingTaxMinor: result.withholdingTaxMinor, netPayMinor: result.netPayMinor,
      inputHash: result.inputHash, resultHash: result.resultHash,
      publishedAt: payrollPeriod.updatedAt.toISOString(),
    });
  }

  private assertLegacyBoundary(): void {
    if (this.config.get('PAYROLL_SYSTEM_MODE', { infer: true }) === 'legacy') return;
    throw new GoneException({
      code: 'PAYROLL_MOVED_TO_PROFESSIONAL_SYSTEM',
      message: '工资能力已迁移至专业算薪系统',
      payrollWebOrigin: this.config.get('PAYROLL_WEB_ORIGIN', { infer: true }),
    });
  }

  private assertPeriodRecord(
    record: PayrollPeriodRecord,
    tenantId: string,
    period: string,
  ): void {
    try {
      assertPlainDataObject(record);
      if (
        record.tenantId !== tenantId ||
        record.period !== period ||
        record.currency !== 'CNY' ||
        !PUBLISHED_STATUSES.some((status) => status === record.status) ||
        typeof record.activeRunId !== 'string' ||
        !ULID_PATTERN.test(record.activeRunId) ||
        !ULID_PATTERN.test(record.id) ||
        !(record.updatedAt instanceof Date) ||
        !Number.isFinite(record.updatedAt.getTime())
      ) throw integrityError();
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw integrityError();
    }
  }

  private assertLineRecord(
    record: PayrollInputSnapshotRecord | PayrollCalculationLineRecord,
    expected: {
      readonly tenantId: string;
      readonly runId: string;
      readonly periodId: string;
      readonly employeeId: string;
      readonly hashField: 'inputHash' | 'resultHash';
    },
  ): void {
    try {
      assertPlainDataObject(record);
      const hash = expected.hashField === 'inputHash'
        ? (record as PayrollInputSnapshotRecord).inputHash
        : (record as PayrollCalculationLineRecord).resultHash;
      if (
        record.tenantId !== expected.tenantId ||
        record.runId !== expected.runId ||
        record.periodId !== expected.periodId ||
        record.employeeId !== expected.employeeId ||
        !ULID_PATTERN.test(record.id) ||
        typeof hash !== 'string' ||
        !HASH_PATTERN.test(hash)
      ) throw integrityError();
      protectedValue(record);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw integrityError();
    }
  }

  private assertIntegrity(
    input: PayrollCalculationInput,
    result: PayrollCalculationResult,
    storedInputHash: string,
    storedResultHash: string,
    binding: { readonly tenantId: string; readonly employeeId: string; readonly period: string },
  ): void {
    try {
      if (
        input === null || typeof input !== 'object' || result === null || typeof result !== 'object' ||
        input.tenantId !== binding.tenantId || input.employeeId !== binding.employeeId ||
        input.period !== binding.period || result.inputHash !== storedInputHash ||
        result.resultHash !== storedResultHash
      ) throw integrityError();
      const recalculated = calculatePayroll(input);
      const { resultHash, ...withoutHash } = result;
      if (
        recalculated.inputHash !== storedInputHash ||
        recalculated.resultHash !== resultHash ||
        payrollDigest(withoutHash) !== resultHash ||
        payrollDigest(recalculated) !== payrollDigest(result)
      ) throw integrityError();
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw integrityError();
    }
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少本人薪资单读取权限',
    });
  }
}

function protectedValue(value: {
  readonly dataKeyId: string; readonly dataIv: string;
  readonly dataCiphertext: string; readonly dataAuthTag: string;
}) {
  const dataKeyId = value.dataKeyId;
  const dataIv = value.dataIv;
  const dataCiphertext = value.dataCiphertext;
  const dataAuthTag = value.dataAuthTag;
  if (
    typeof dataKeyId !== 'string' ||
    dataKeyId.length > 64 ||
    !ID_PATTERN.test(dataKeyId) ||
    typeof dataIv !== 'string' ||
    dataIv.length !== 16 ||
    !/^[A-Za-z0-9_-]+$/.test(dataIv) ||
    typeof dataCiphertext !== 'string' ||
    dataCiphertext.length < 1 ||
    dataCiphertext.length > 11_184_811 ||
    !/^[A-Za-z0-9_-]+$/.test(dataCiphertext) ||
    typeof dataAuthTag !== 'string' ||
    dataAuthTag.length !== 22 ||
    !/^[A-Za-z0-9_-]+$/.test(dataAuthTag)
  ) throw integrityError();
  return {
    keyId: dataKeyId, iv: dataIv,
    ciphertext: dataCiphertext, authTag: dataAuthTag,
  };
}

function assertPlainDataObject(value: object): void {
  const prototype: unknown = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.some((key) => typeof key === 'symbol') ||
    ownKeys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined;
    })
  ) throw integrityError();
}

function freezeComponents(values: readonly PayrollAmountComponent[]): readonly PayrollAmountComponent[] {
  return Object.freeze(values.map((item) =>
    Object.freeze({ code: item.code, amountMinor: item.amountMinor })));
}

function integrityError(): ConflictException {
  return new ConflictException({
    code: 'PAYROLL_PAYSLIP_INTEGRITY_FAILED', message: '薪资单完整性校验失败',
  });
}
