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

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  beginPayrollReconciliation,
  completePayrollReconciliation,
  FourWayReconciliationError,
  recordPayrollReconciliationMismatch,
  reconcilePayrollFourWay,
  startPayrollDisbursement,
  type FourWayReconciliationResult,
  type PayrollReconciliationDifferenceCode,
  PayrollPeriodError,
  type PayrollPeriod,
} from '../domain/index.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
  PayrollReconciliationRecord,
  type PayrollReconciliationDocument,
  PayrollTaxFilingRecord,
  type PayrollTaxFilingDocument,
} from '../persistence/payroll.schemas.js';
import {
  payrollPeriodFromRecord,
  toMutablePayrollPeriodRecord,
} from './payroll-run.service.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface PayrollReconciliationTreasuryEvidence {
  readonly batchId: string;
  readonly payrollPeriodId: string;
  readonly payrollRunId: string;
  readonly payrollResultHash: string;
  readonly status: 'reconciling';
  readonly version: number;
  readonly lineCount: number;
  readonly totalMinor: number;
  readonly settledLineCount: number;
  readonly settledMinor: number;
  readonly settlementChainHash: string;
  readonly preparedBy: string;
  readonly exportEvidenceId: string;
  readonly objectEvidenceId: string;
  readonly bankSubmissionId: string;
  readonly bankSubmissionEvidenceId: string;
}

export interface PayrollReconciliationBankReturnEvidence {
  readonly returnId: string;
  readonly batchId: string;
  readonly returnHash: string;
  readonly outcome: 'accepted';
  readonly successfulCount: number;
  readonly successfulMinor: number;
  readonly failedCount: number;
  readonly failedMinor: number;
  readonly objectEvidenceId: string;
  readonly signatureEvidenceId: string;
  readonly malwareScanEvidenceId: string;
}

export interface PayrollReconciliationSummary extends Record<string, unknown> {
  readonly id: string;
  readonly periodId: string;
  readonly payrollRunId: string;
  readonly batchId: string;
  readonly bankReturnId: string;
  readonly taxFilingId: string;
  readonly status: 'balanced' | 'frozen';
  readonly differences: readonly PayrollReconciliationDifferenceCode[];
  readonly evidenceHash: string;
  readonly employeeCount: number;
  readonly bankLineCount: number;
  readonly totalGrossMinor: number;
  readonly totalNetMinor: number;
  readonly bankSubmittedMinor: number;
  readonly bankReturnedMinor: number;
  readonly totalTaxableEarningsMinor: number;
  readonly payrollWithholdingTaxMinor: number;
  readonly filedWithholdingTaxMinor: number;
  readonly version: number;
}

/** 四方对账应用服务；跨域输入只接受 Treasury 已验证的聚合证据。 */
@Injectable()
export class PayrollReconciliationService {
  constructor(
    private readonly context: TenantContextService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
    @InjectModel(PayrollTaxFilingRecord.name)
    private readonly taxFilings: Model<PayrollTaxFilingDocument>,
    @InjectModel(PayrollReconciliationRecord.name)
    private readonly reconciliations: Model<PayrollReconciliationDocument>,
  ) {}

  async getStatus(id: string): Promise<PayrollReconciliationSummary> {
    this.assertScope('erp:payroll:reconciliation:read');
    if (!ULID.test(id)) throw new BadRequestException({
      code: 'PAYROLL_RECONCILIATION_ID_INVALID', message: '四方对账标识非法',
    });
    return summary(await this.requireReconciliation(id));
  }

  async getForBatch(
    batchId: string,
    session: ClientSession,
  ): Promise<PayrollReconciliationSummary | null> {
    this.assertScope('erp:payroll:reconciliation:execute');
    const record = await this.reconciliations.findOne({
      tenantId: this.tenantId(), batchId,
    }).session(session).lean().exec();
    return record === null ? null : summary(record);
  }

  async reconcile(
    treasury: PayrollReconciliationTreasuryEvidence,
    bankReturn: PayrollReconciliationBankReturnEvidence,
    reconciledBy: string,
    session: ClientSession,
  ): Promise<{ readonly summary: PayrollReconciliationSummary; readonly result: FourWayReconciliationResult }> {
    this.assertScope('erp:payroll:reconciliation:execute');
    const actor = this.context.getActorRequired();
    if (
      (actor.actorType !== 'service' && actor.actorType !== 'system_job') ||
      actor.actorId !== reconciledBy
    ) throw new ForbiddenException({
      code: 'PAYROLL_RECONCILIATION_IDENTITY_INVALID',
      message: '四方对账只接受当前可信服务身份',
    });
    const existing = await this.reconciliations.findOne({
      tenantId: this.tenantId(), batchId: treasury.batchId,
    }).session(session).lean().exec();
    if (existing !== null) return Object.freeze({
      summary: summary(existing), result: resultFromRecord(existing),
    });
    const period = await this.periods.findOne({
      tenantId: this.tenantId(), id: treasury.payrollPeriodId,
    }).session(session).lean().exec();
    if (
      period === null || period.activeRunId === null || period.resultHash === null ||
      period.employeeCount === null || period.totalGrossMinor === null ||
      period.totalNetMinor === null || period.totalTaxMinor === null
    ) throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_PERIOD_NOT_READY', message: '工资周期或锁定控制量不完整',
    });
    const tax = await this.taxFilings.findOne({
      tenantId: this.tenantId(), periodId: period.id,
    }).session(session).lean().exec();
    if (
      tax === null || tax.status !== 'submitted' || tax.taxSubmissionId === null ||
      tax.taxSubmissionEvidenceId === null
    ) throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_TAX_NOT_SUBMITTED', message: '个税申报尚未取得可信提交回执',
    });
    let result: FourWayReconciliationResult;
    try {
      result = reconcilePayrollFourWay({
        tenantId: this.tenantId(),
        payroll: {
          periodId: period.id, payrollRunId: period.activeRunId, resultHash: period.resultHash,
          employeeCount: period.employeeCount, totalGrossMinor: period.totalGrossMinor,
          totalNetMinor: period.totalNetMinor, totalWithholdingTaxMinor: period.totalTaxMinor,
        },
        disbursement: {
          batchId: treasury.batchId, payrollPeriodId: treasury.payrollPeriodId,
          payrollRunId: treasury.payrollRunId,
          payrollResultHash: treasury.payrollResultHash, status: 'reconciling',
          lineCount: treasury.lineCount, totalMinor: treasury.totalMinor,
          settledLineCount: treasury.settledLineCount,
          settledMinor: treasury.settledMinor,
          settlementChainHash: treasury.settlementChainHash,
          objectEvidenceId: treasury.objectEvidenceId,
          bankSubmissionId: treasury.bankSubmissionId,
          bankSubmissionEvidenceId: treasury.bankSubmissionEvidenceId,
        },
        bankReturn: {
          returnId: bankReturn.returnId, batchId: bankReturn.batchId,
          returnHash: bankReturn.returnHash, outcome: 'accepted',
          successfulCount: bankReturn.successfulCount,
          successfulMinor: bankReturn.successfulMinor,
          failedCount: bankReturn.failedCount, failedMinor: bankReturn.failedMinor,
          objectEvidenceId: bankReturn.objectEvidenceId,
          signatureEvidenceId: bankReturn.signatureEvidenceId,
          malwareScanEvidenceId: bankReturn.malwareScanEvidenceId,
        },
        taxFiling: {
          filingId: tax.id, payrollRunId: tax.payrollRunId,
          payrollResultHash: tax.payrollResultHash, status: 'submitted',
          employeeCount: tax.employeeCount,
          totalTaxableEarningsMinor: tax.totalTaxableEarningsMinor,
          totalWithholdingTaxMinor: tax.totalWithholdingTaxMinor,
          contentHash: tax.contentHash, taxSubmissionId: tax.taxSubmissionId,
          taxSubmissionEvidenceId: tax.taxSubmissionEvidenceId,
        },
      });
    } catch (error) {
      if (error instanceof FourWayReconciliationError) throw new ConflictException({
        code: error.code, message: error.message,
      });
      throw error;
    }
    const reconciliationId = createEventId();
    const now = new Date();
    let nextPeriod: PayrollPeriod;
    try {
      nextPeriod = await this.advancePeriod(
        payrollPeriodFromRecord(period), treasury, reconciliationId,
        bankReturn.returnHash, reconciledBy, result.balanced, now, session,
      );
    } catch (error) {
      if (error instanceof PayrollPeriodError) throw new ConflictException({
        code: error.code, message: error.message,
      });
      throw error;
    }
    try { await this.reconciliations.create([{
      id: reconciliationId, tenantId: this.tenantId(), periodId: period.id,
      payrollRunId: period.activeRunId, payrollResultHash: period.resultHash,
      batchId: treasury.batchId, bankReturnId: bankReturn.returnId,
      returnHash: bankReturn.returnHash, bankSubmissionId: treasury.bankSubmissionId,
      disbursementObjectEvidenceId: treasury.objectEvidenceId,
      bankSubmissionEvidenceId: treasury.bankSubmissionEvidenceId,
      bankReturnObjectEvidenceId: bankReturn.objectEvidenceId,
      signatureEvidenceId: bankReturn.signatureEvidenceId,
      malwareScanEvidenceId: bankReturn.malwareScanEvidenceId,
      taxFilingId: tax.id, taxSubmissionId: tax.taxSubmissionId,
      taxSubmissionEvidenceId: tax.taxSubmissionEvidenceId,
      taxContentHash: tax.contentHash, settlementChainHash: treasury.settlementChainHash,
      employeeCount: result.employeeCount,
      bankLineCount: result.bankLineCount, totalGrossMinor: result.totalGrossMinor,
      totalNetMinor: result.totalNetMinor, bankSubmittedMinor: result.bankSubmittedMinor,
      bankReturnedMinor: result.bankReturnedMinor,
      totalTaxableEarningsMinor: result.totalTaxableEarningsMinor,
      payrollWithholdingTaxMinor: result.payrollWithholdingTaxMinor,
      filedWithholdingTaxMinor: result.filedWithholdingTaxMinor,
      differences: [...result.differences], evidenceHash: result.evidenceHash,
      reconciledBy, status: result.balanced ? 'balanced' : 'frozen', version: 1,
    }], { session }); } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000) {
        throw new ConflictException({
          code: 'PAYROLL_RECONCILIATION_ALREADY_EXISTS',
          message: '工资周期、运行或代发批次已存在四方对账证据',
        });
      }
      throw error;
    }
    const record = {
      id: reconciliationId, tenantId: this.tenantId(), periodId: period.id,
      payrollRunId: period.activeRunId, payrollResultHash: period.resultHash,
      batchId: treasury.batchId, bankReturnId: bankReturn.returnId,
      returnHash: bankReturn.returnHash, bankSubmissionId: treasury.bankSubmissionId,
      disbursementObjectEvidenceId: treasury.objectEvidenceId,
      bankSubmissionEvidenceId: treasury.bankSubmissionEvidenceId,
      bankReturnObjectEvidenceId: bankReturn.objectEvidenceId,
      signatureEvidenceId: bankReturn.signatureEvidenceId,
      malwareScanEvidenceId: bankReturn.malwareScanEvidenceId,
      taxFilingId: tax.id, taxSubmissionId: tax.taxSubmissionId,
      taxSubmissionEvidenceId: tax.taxSubmissionEvidenceId,
      taxContentHash: tax.contentHash, settlementChainHash: treasury.settlementChainHash,
      employeeCount: result.employeeCount,
      bankLineCount: result.bankLineCount, totalGrossMinor: result.totalGrossMinor,
      totalNetMinor: result.totalNetMinor, bankSubmittedMinor: result.bankSubmittedMinor,
      bankReturnedMinor: result.bankReturnedMinor,
      totalTaxableEarningsMinor: result.totalTaxableEarningsMinor,
      payrollWithholdingTaxMinor: result.payrollWithholdingTaxMinor,
      filedWithholdingTaxMinor: result.filedWithholdingTaxMinor,
      differences: [...result.differences], evidenceHash: result.evidenceHash,
      reconciledBy, status: result.balanced ? 'balanced' as const : 'frozen' as const,
      version: 1, createdAt: now, updatedAt: now,
    };
    await this.outbox.append({
      type: 'payroll.reconciliation.completed', tenantId: this.tenantId(),
      aggregateId: period.id, version: nextPeriod.version,
      occurredAt: nextPeriod.updatedAt, data: {
        period: period.period, batchId: treasury.batchId,
        reconciliationId, evidenceHash: result.evidenceHash,
        differenceCount: result.differences.length,
        status: result.balanced ? 'reconciled' : 'frozen',
      },
    }, session);
    return Object.freeze({ summary: summary(record), result });
  }

  private async advancePeriod(
    initial: PayrollPeriod,
    treasury: PayrollReconciliationTreasuryEvidence,
    evidenceId: string,
    returnHash: string,
    reconciledBy: string,
    balanced: boolean,
    now: Date,
    session: ClientSession,
  ): Promise<PayrollPeriod> {
    let current = initial;
    if (current.status === 'locked') {
      current = startPayrollDisbursement(current, {
        tenantId: this.tenantId(), expectedVersion: current.version,
        batchId: treasury.batchId, preparedBy: treasury.preparedBy,
        exportEvidenceId: treasury.exportEvidenceId, trustedExport: true,
      }, now);
      await this.outbox.append({
        type: 'payroll.disbursement.started', tenantId: this.tenantId(),
        aggregateId: current.id, version: current.version, occurredAt: current.updatedAt,
        data: { period: current.period, batchId: treasury.batchId, status: 'disbursing' },
      }, session);
    }
    if (current.status === 'disbursing') {
      current = beginPayrollReconciliation(current, {
        tenantId: this.tenantId(), expectedVersion: current.version, batchId: treasury.batchId,
      }, now);
      await this.outbox.append({
        type: 'payroll.reconciliation.started', tenantId: this.tenantId(),
        aggregateId: current.id, version: current.version, occurredAt: current.updatedAt,
        data: {
          period: current.period, batchId: treasury.batchId,
          returnHash, status: 'reconciling',
        },
      }, session);
    }
    if (current.status !== 'reconciling') throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_STATE_INVALID', message: '工资周期不处于可对账状态',
    });
    current = balanced
      ? completePayrollReconciliation(current, {
        tenantId: this.tenantId(), expectedVersion: current.version,
        reconciledBy, reconciliationEvidenceId: evidenceId,
        balanced: true, trustedReconciliation: true,
      }, now)
      : recordPayrollReconciliationMismatch(current, {
        tenantId: this.tenantId(), expectedVersion: current.version,
        reconciliationEvidenceId: evidenceId, trustedReconciliation: true,
      }, now);
    const updated = await this.periods.updateOne({
      tenantId: this.tenantId(), id: initial.id,
      status: initial.status, version: initial.version,
    }, { $set: toMutablePayrollPeriodRecord(current) }, { session, runValidators: true });
    if (updated.modifiedCount !== 1) throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_PERIOD_WRITE_CONFLICT', message: '工资周期对账状态并发冲突',
    });
    return current;
  }

  private async requireReconciliation(
    id: string,
    session?: ClientSession,
  ): Promise<PayrollReconciliationRecord> {
    const query = this.reconciliations.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'PAYROLL_RECONCILIATION_NOT_FOUND', message: '四方对账记录不存在',
    });
    return record;
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少四方对账权限',
    });
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function summary(record: PayrollReconciliationRecord): PayrollReconciliationSummary {
  const differences = differenceCodes(record.differences);
  if ((record.status === 'balanced') !== (differences.length === 0)) {
    throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_EVIDENCE_INVALID', message: '四方对账状态与差异证据不一致',
    });
  }
  return Object.freeze({
    id: record.id, periodId: record.periodId, payrollRunId: record.payrollRunId,
    batchId: record.batchId, bankReturnId: record.bankReturnId,
    taxFilingId: record.taxFilingId, status: record.status,
    differences, evidenceHash: record.evidenceHash,
    employeeCount: record.employeeCount, bankLineCount: record.bankLineCount,
    totalGrossMinor: record.totalGrossMinor, totalNetMinor: record.totalNetMinor,
    bankSubmittedMinor: record.bankSubmittedMinor,
    bankReturnedMinor: record.bankReturnedMinor,
    totalTaxableEarningsMinor: record.totalTaxableEarningsMinor,
    payrollWithholdingTaxMinor: record.payrollWithholdingTaxMinor,
    filedWithholdingTaxMinor: record.filedWithholdingTaxMinor, version: record.version,
  });
}

function resultFromRecord(record: PayrollReconciliationRecord): FourWayReconciliationResult {
  return Object.freeze({
    balanced: record.status === 'balanced', differences: differenceCodes(record.differences),
    evidenceHash: record.evidenceHash, employeeCount: record.employeeCount,
    bankLineCount: record.bankLineCount, totalGrossMinor: record.totalGrossMinor,
    totalNetMinor: record.totalNetMinor, bankSubmittedMinor: record.bankSubmittedMinor,
    bankReturnedMinor: record.bankReturnedMinor,
    totalTaxableEarningsMinor: record.totalTaxableEarningsMinor,
    payrollWithholdingTaxMinor: record.payrollWithholdingTaxMinor,
    filedWithholdingTaxMinor: record.filedWithholdingTaxMinor,
  });
}

const DIFFERENCE_CODES = new Set<PayrollReconciliationDifferenceCode>([
  'PAYROLL_BANK_AMOUNT_MISMATCH', 'BANK_RETURN_AMOUNT_MISMATCH',
  'BANK_RETURN_COUNT_MISMATCH', 'PAYROLL_TAX_AMOUNT_MISMATCH',
  'PAYROLL_TAX_EMPLOYEE_COUNT_MISMATCH',
]);

function differenceCodes(values: readonly string[]): readonly PayrollReconciliationDifferenceCode[] {
  if (
    new Set(values).size !== values.length ||
    !values.every((value): value is PayrollReconciliationDifferenceCode =>
      DIFFERENCE_CODES.has(value as PayrollReconciliationDifferenceCode))
  ) throw new ConflictException({
    code: 'PAYROLL_RECONCILIATION_EVIDENCE_INVALID', message: '四方对账差异证据非法',
  });
  return Object.freeze([...values]);
}
