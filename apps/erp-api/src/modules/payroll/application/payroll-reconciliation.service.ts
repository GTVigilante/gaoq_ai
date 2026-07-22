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

export interface PayrollReconciliationMigrationControl {
  readonly targetId: string | null;
  readonly expectedPeriodVersion: number;
  readonly expectedTaxFilingId: string;
  readonly reconciledAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
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
    migration?: PayrollReconciliationMigrationControl,
  ): Promise<{ readonly summary: PayrollReconciliationSummary; readonly result: FourWayReconciliationResult }> {
    if (migration === undefined) this.assertScope('erp:payroll:reconciliation:execute');
    else {
      this.assertMigrationWriter();
      assertMigrationControl(migration);
    }
    const migrationInstant = migration === undefined
      ? undefined : strictMigrationInstant(migration.reconciledAt);
    const actor = this.context.getActorRequired();
    if (
      (actor.actorType !== 'service' && actor.actorType !== 'system_job') ||
      (migration === undefined && actor.actorId !== reconciledBy)
    ) throw new ForbiddenException({
      code: 'PAYROLL_RECONCILIATION_IDENTITY_INVALID',
      message: '四方对账只接受当前可信服务身份',
    });
    const existing = await this.reconciliations.findOne({
      tenantId: this.tenantId(), batchId: treasury.batchId,
    }).session(session).lean().exec();
    if (existing !== null && migration === undefined) return Object.freeze({
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
      tax.taxSubmissionEvidenceId === null ||
      (migration !== undefined && tax.id !== migration.expectedTaxFilingId)
    ) throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_TAX_NOT_SUBMITTED', message: '个税申报尚未取得可信提交回执',
    });
    if (migration !== undefined && (tax.migrationEvidenceRef === null ||
      tax.strongAuthReferenceType !== 'migration_tax_approval_evidence' ||
      migrationInstant === undefined || tax.updatedAt.getTime() > migrationInstant.getTime() ||
      tax.preparedBy === reconciledBy || tax.approvedBy === reconciledBy)) {
      throw new ConflictException({
        code: 'PAYROLL_RECONCILIATION_MIGRATION_TAX_INVALID',
        message: '历史个税链路、时间或职责分离控制非法',
      });
    }
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
    if (migration !== undefined && !result.balanced) throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_MIGRATION_NOT_BALANCED',
      message: '历史四方对账重算不守恒，禁止恢复为已对账',
    });
    if (existing !== null && migration !== undefined) {
      this.assertMigrationReplay(existing, period, treasury, bankReturn, tax, result, reconciledBy,
        migration);
      return Object.freeze({ summary: summary(existing), result });
    }
    const now = migrationInstant ?? new Date();
    if (migration !== undefined &&
      (period.status !== 'locked' || period.version !== migration.expectedPeriodVersion ||
        period.updatedAt.getTime() > now.getTime())) {
      throw new ConflictException({
        code: 'PAYROLL_RECONCILIATION_MIGRATION_PERIOD_INVALID',
        message: '历史四方对账要求迁移锁定工资周期及精确版本',
      });
    }
    const reconciliationId = createEventId(now);
    let nextPeriod: PayrollPeriod;
    try {
      nextPeriod = await this.advancePeriod(
        payrollPeriodFromRecord(period), treasury, reconciliationId,
        bankReturn.returnHash, reconciledBy, result.balanced, now, session,
        migration === undefined,
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
      reconciledBy, evidenceReferenceType: migration === undefined
        ? 'online_reconciliation' : 'migration_reconciliation_evidence',
      status: result.balanced ? 'balanced' : 'frozen', version: 1,
      migrationEvidenceRef: migration?.migrationEvidenceRef ?? null,
      migrationEvidenceChecksum: migration?.evidenceChecksum ?? null,
      ...(migration === undefined ? {} : { createdAt: now, updatedAt: now }),
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
      reconciledBy, evidenceReferenceType: migration === undefined
        ? 'online_reconciliation' as const : 'migration_reconciliation_evidence' as const,
      status: result.balanced ? 'balanced' as const : 'frozen' as const,
      migrationEvidenceRef: migration?.migrationEvidenceRef ?? null,
      migrationEvidenceChecksum: migration?.evidenceChecksum ?? null,
      version: 1, createdAt: now, updatedAt: now,
    };
    await this.outbox.append({
      type: migration === undefined
        ? 'payroll.reconciliation.completed' : 'payroll.reconciliation.migrated',
      tenantId: this.tenantId(),
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
    emitLifecycleEvents: boolean,
  ): Promise<PayrollPeriod> {
    let current = initial;
    if (current.status === 'locked') {
      current = startPayrollDisbursement(current, {
        tenantId: this.tenantId(), expectedVersion: current.version,
        batchId: treasury.batchId, preparedBy: treasury.preparedBy,
        exportEvidenceId: treasury.exportEvidenceId, trustedExport: true,
      }, now);
      if (emitLifecycleEvents) await this.outbox.append({
        type: 'payroll.disbursement.started', tenantId: this.tenantId(),
        aggregateId: current.id, version: current.version, occurredAt: current.updatedAt,
        data: { period: current.period, batchId: treasury.batchId, status: 'disbursing' },
      }, session);
    }
    if (current.status === 'disbursing') {
      current = beginPayrollReconciliation(current, {
        tenantId: this.tenantId(), expectedVersion: current.version, batchId: treasury.batchId,
      }, now);
      if (emitLifecycleEvents) await this.outbox.append({
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
    }, { $set: toMutablePayrollPeriodRecord(current) }, {
      session, runValidators: true,
      ...(emitLifecycleEvents ? {} : { timestamps: false }),
    });
    if (updated.modifiedCount !== 1) throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_PERIOD_WRITE_CONFLICT', message: '工资周期对账状态并发冲突',
    });
    return current;
  }

  private assertMigrationReplay(
    record: PayrollReconciliationRecord,
    period: PayrollPeriodRecord,
    treasury: PayrollReconciliationTreasuryEvidence,
    bankReturn: PayrollReconciliationBankReturnEvidence,
    tax: PayrollTaxFilingRecord,
    result: FourWayReconciliationResult,
    reconciledBy: string,
    migration: PayrollReconciliationMigrationControl,
  ): void {
    if (migration.targetId !== record.id || record.periodId !== period.id ||
      record.payrollRunId !== period.activeRunId || record.payrollResultHash !== period.resultHash ||
      record.batchId !== treasury.batchId || record.bankReturnId !== bankReturn.returnId ||
      record.returnHash !== bankReturn.returnHash ||
      record.bankSubmissionId !== treasury.bankSubmissionId ||
      record.disbursementObjectEvidenceId !== treasury.objectEvidenceId ||
      record.bankSubmissionEvidenceId !== treasury.bankSubmissionEvidenceId ||
      record.bankReturnObjectEvidenceId !== bankReturn.objectEvidenceId ||
      record.signatureEvidenceId !== bankReturn.signatureEvidenceId ||
      record.malwareScanEvidenceId !== bankReturn.malwareScanEvidenceId ||
      record.taxFilingId !== tax.id || record.taxSubmissionId !== tax.taxSubmissionId ||
      record.taxSubmissionEvidenceId !== tax.taxSubmissionEvidenceId ||
      record.taxContentHash !== tax.contentHash ||
      record.settlementChainHash !== treasury.settlementChainHash ||
      record.employeeCount !== result.employeeCount || record.bankLineCount !== result.bankLineCount ||
      record.totalGrossMinor !== result.totalGrossMinor || record.totalNetMinor !== result.totalNetMinor ||
      record.bankSubmittedMinor !== result.bankSubmittedMinor ||
      record.bankReturnedMinor !== result.bankReturnedMinor ||
      record.totalTaxableEarningsMinor !== result.totalTaxableEarningsMinor ||
      record.payrollWithholdingTaxMinor !== result.payrollWithholdingTaxMinor ||
      record.filedWithholdingTaxMinor !== result.filedWithholdingTaxMinor ||
      JSON.stringify(record.differences) !== JSON.stringify(result.differences) ||
      record.evidenceHash !== result.evidenceHash || record.reconciledBy !== reconciledBy ||
      record.status !== 'balanced' || record.version !== 1 ||
      record.evidenceReferenceType !== 'migration_reconciliation_evidence' ||
      record.migrationEvidenceRef !== migration.migrationEvidenceRef ||
      record.migrationEvidenceChecksum !== migration.evidenceChecksum ||
      record.createdAt.toISOString() !== migration.reconciledAt ||
      record.updatedAt.toISOString() !== migration.reconciledAt ||
      period.status !== 'reconciled' ||
      period.version !== migration.expectedPeriodVersion + 3 ||
      period.disbursementBatchId !== treasury.batchId || period.reconciledBy !== reconciledBy ||
      period.reconciliationEvidenceId !== record.id ||
      period.updatedAt.toISOString() !== migration.reconciledAt) {
      throw new ConflictException({
        code: 'PAYROLL_RECONCILIATION_MIGRATION_IMMUTABLE',
        message: '既有四方对账、工资周期或迁移证据不一致，禁止覆盖',
      });
    }
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

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:payroll:migration:write') ||
      !actor.scopes.includes('erp:treasury:migration:write')) {
      throw new ForbiddenException({
        code: 'PAYROLL_RECONCILIATION_MIGRATION_WRITER_DENIED',
        message: '四方对账迁移必须由受信任服务身份执行',
      });
    }
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

const MIGRATION_EVIDENCE_REF =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;

function assertMigrationControl(control: PayrollReconciliationMigrationControl): void {
  if (Object.keys(control).sort().join(',') !==
      'evidenceChecksum,expectedPeriodVersion,expectedTaxFilingId,migrationEvidenceRef,reconciledAt,targetId' ||
    (control.targetId !== null && !ULID.test(control.targetId)) ||
    !Number.isSafeInteger(control.expectedPeriodVersion) || control.expectedPeriodVersion !== 6 ||
    !ULID.test(control.expectedTaxFilingId) ||
    !MIGRATION_EVIDENCE_REF.test(control.migrationEvidenceRef) ||
    !HASH.test(control.evidenceChecksum)) {
    throw new BadRequestException({
      code: 'PAYROLL_RECONCILIATION_MIGRATION_INPUT_INVALID',
      message: '四方对账迁移控制信息非法',
    });
  }
  strictMigrationInstant(control.reconciledAt);
}

function strictMigrationInstant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value ||
    parsed.getTime() > Date.now() + 5 * 60_000) {
    throw new BadRequestException({
      code: 'PAYROLL_RECONCILIATION_MIGRATION_INPUT_INVALID',
      message: '四方对账迁移时间非法',
    });
  }
  return parsed;
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
