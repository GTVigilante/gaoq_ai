import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

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
const PUBLISHED_STATUSES = ['locked', 'disbursing', 'reconciling', 'reconciled'] as const;

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
  ) {}

  async getMyPayslip(period: string): Promise<PayrollPayslipView> {
    this.assertScope('erp:payroll:sheet:read_self');
    if (!MONTH_PATTERN.test(period)) throw new NotFoundException({
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
    const payrollPeriod = await this.periods.findOne({
      tenantId: trusted.tenant.tenantId, period,
      status: { $in: PUBLISHED_STATUSES }, activeRunId: { $type: 'string' },
    }).lean().exec();
    if (payrollPeriod === null || payrollPeriod.activeRunId === null) throw new NotFoundException({
      code: 'PAYROLL_PAYSLIP_NOT_FOUND', message: '薪资单不存在或尚未发布',
    });
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
    const input = this.crypto.unprotect({
      tenantId: trusted.tenant.tenantId, resourceType: 'input_snapshot',
      resourceId: inputRecord.id, version: 1,
    }, protectedValue(inputRecord)) as PayrollCalculationInput;
    const result = this.crypto.unprotect({
      tenantId: trusted.tenant.tenantId, resourceType: 'calculation_line',
      resourceId: resultRecord.id, version: 1,
    }, protectedValue(resultRecord)) as PayrollCalculationResult;
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
        recalculated.resultHash !== resultHash || payrollDigest(withoutHash) !== resultHash
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
  return {
    keyId: value.dataKeyId, iv: value.dataIv,
    ciphertext: value.dataCiphertext, authTag: value.dataAuthTag,
  };
}

function freezeComponents(values: readonly PayrollAmountComponent[]): readonly PayrollAmountComponent[] {
  if (!Array.isArray(values) || values.length > 128) throw integrityError();
  const output: PayrollAmountComponent[] = [];
  for (const raw of values as readonly unknown[]) {
    if (
      raw === null || typeof raw !== 'object' || Array.isArray(raw)
    ) throw integrityError();
    const item = raw as Record<string, unknown>;
    if (
      typeof item['code'] !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(item['code']) ||
      typeof item['amountMinor'] !== 'number' ||
      !Number.isSafeInteger(item['amountMinor']) || item['amountMinor'] < 0
    ) throw integrityError();
    output.push(Object.freeze({ code: item['code'], amountMinor: item['amountMinor'] }));
  }
  return Object.freeze(output);
}

function integrityError(): ConflictException {
  return new ConflictException({
    code: 'PAYROLL_PAYSLIP_INTEGRITY_FAILED', message: '薪资单完整性校验失败',
  });
}
