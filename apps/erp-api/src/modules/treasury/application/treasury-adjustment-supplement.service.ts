import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  PayrollAdjustmentService,
  type LockedPayrollSupplementSource,
} from '../../payroll/application/payroll-adjustment.service.js';
import { payrollDigest } from '../../payroll/domain/index.js';
import { LegacyPayrollBoundaryService } from '../../payroll/legacy-payroll-boundary.service.js';
import { TreasuryDataCryptoService } from '../persistence/treasury-data-crypto.service.js';
import { TreasuryOutboxWriter } from '../persistence/treasury-outbox.writer.js';
import {
  TreasuryBankAccountRecord,
  type TreasuryBankAccountDocument,
  TreasuryDisbursementBatchRecord,
  type TreasuryDisbursementBatchDocument,
  TreasuryPaymentInstructionRecord,
  type TreasuryPaymentInstructionDocument,
} from '../persistence/treasury.schemas.js';
import {
  TreasuryDisbursementService,
  type TreasuryDisbursementSummary,
} from './treasury-disbursement.service.js';
import type { PrepareTreasuryAdjustmentSupplementDto } from './treasury.dto.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const accountSchema = z.object({
  accountName: z.string().min(1).max(140),
  account: z.string().regex(/^[0-9]{8,32}$/),
  clearingCode: z.string().regex(/^[0-9A-Z]{8,12}$/),
  currency: z.literal('CNY'),
}).strict();
const parentSnapshotSchema = z.object({
  messageId: z.string().regex(ID),
  paymentInformationId: z.string().regex(ID),
  creationDateTime: z.iso.datetime({ offset: true }),
  requestedExecutionDate: z.string().regex(DATE),
  debtorBankAccountId: z.string().regex(ID),
  debtorName: z.string().min(1).max(140),
  debtorAccount: z.string().regex(/^[0-9]{8,32}$/),
  debtorAgentClearingCode: z.string().regex(/^[0-9A-Z]{8,12}$/),
  payrollResultHash: z.string().regex(HASH),
  payableResultHash: z.string().regex(HASH),
}).strict();

/**
 * 将已锁定正向工资调整变为关联原代发批次的单行 supplement 子批次。
 * 客户端不能选择员工、金额、收款账户或付款账户。
 */
@Injectable()
export class TreasuryAdjustmentSupplementService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly boundary: LegacyPayrollBoundaryService,
    private readonly payrollAdjustments: PayrollAdjustmentService,
    private readonly crypto: TreasuryDataCryptoService,
    private readonly outbox: TreasuryOutboxWriter,
    private readonly disbursements: TreasuryDisbursementService,
    @InjectModel(TreasuryBankAccountRecord.name)
    private readonly accounts: Model<TreasuryBankAccountDocument>,
    @InjectModel(TreasuryPaymentInstructionRecord.name)
    private readonly instructions: Model<TreasuryPaymentInstructionDocument>,
    @InjectModel(TreasuryDisbursementBatchRecord.name)
    private readonly batches: Model<TreasuryDisbursementBatchDocument>,
  ) {}

  async prepare(
    key: string,
    adjustmentId: string,
    input: PrepareTreasuryAdjustmentSupplementDto,
  ): Promise<TreasuryDisbursementSummary> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'user' ||
      !actor.scopes.includes('erp:treasury:adjustment:prepare') ||
      !actor.scopes.includes('erp:treasury:adjustment:source:read')
    ) throw new ForbiddenException({
      code: 'TREASURY_ADJUSTMENT_PREPARER_DENIED',
      message: '工资补发子批次只允许受控人工资金制备人执行',
    });
    this.boundary.assertLegacy();
    if (!DATE.test(input.requestedExecutionDate) ||
      !Number.isSafeInteger(input.expectedAdjustmentVersion) ||
      input.expectedAdjustmentVersion < 1) throw new BadRequestException({
      code: 'TREASURY_ADJUSTMENT_INPUT_INVALID',
      message: '工资补发调整版本或执行日期非法',
    });
    const staged = await this.run(() => this.idempotency.execute(
      'treasury.adjustment_supplement.prepare',
      key,
      {
        adjustmentId,
        expectedAdjustmentVersion: input.expectedAdjustmentVersion,
        requestedExecutionDate: input.requestedExecutionDate,
      },
      async (session) => {
        const source = await this.payrollAdjustments.getLockedSupplementSource(
          adjustmentId,
          input.expectedAdjustmentVersion,
          session,
        );
        if (source.controlActorIds.includes(actor.actorId)) throw new ForbiddenException({
          code: 'TREASURY_ADJUSTMENT_INDEPENDENCE_REQUIRED',
          message: '补发制备人必须独立于调整重算、送审、审批和锁定控制链',
        });
        return this.stage(
          source,
          input.requestedExecutionDate,
          actor.actorId,
          session,
        );
      },
    ));
    return this.disbursements.materializeStaged(
      deriveKey(key, 'materialize-adjustment-supplement'),
      staged.id,
    );
  }

  private async stage(
    source: LockedPayrollSupplementSource,
    requestedExecutionDate: string,
    preparedBy: string,
    session: ClientSession,
  ): Promise<TreasuryDisbursementSummary> {
    const existing = await this.batches.findOne({
      tenantId: this.tenantId(),
      adjustmentSourceId: source.adjustmentId,
    }).session(session).lean().exec();
    if (existing !== null) return existingSupplementSummary(existing, source);
    const parent = await this.batches.findOne({
      tenantId: this.tenantId(),
      payrollPeriodId: source.periodId,
      payrollRunId: source.payrollRunId,
      purpose: 'regular',
      status: { $in: ['submitted', 'reconciling', 'reconciled', 'frozen'] },
      bankSubmissionId: { $type: 'string' },
    }).sort({ batchSequence: -1 }).session(session).lean().exec();
    if (parent === null) throw new ConflictException({
      code: 'TREASURY_ADJUSTMENT_PARENT_NOT_SETTLED',
      message: '原工资代发尚未提交银行，不能创建关联补发子批次',
    });
    const latest = await this.batches.findOne({
      tenantId: this.tenantId(),
      payrollRunId: source.payrollRunId,
    }).sort({ batchSequence: -1 }).session(session).lean().exec();
    if (latest === null || latest.batchSequence >= Number.MAX_SAFE_INTEGER) {
      throw new ConflictException({
        code: 'TREASURY_ADJUSTMENT_SEQUENCE_INVALID',
        message: '工资补发子批次序号不可用',
      });
    }
    const now = new Date();
    if (!isExecutionWindow(requestedExecutionDate, now)) throw new BadRequestException({
      code: 'TREASURY_ADJUSTMENT_EXECUTION_DATE_OUT_OF_RANGE',
      message: '补发执行日期必须为今天起九十天内',
    });
    const parentHeader = parentSnapshotSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(),
      resourceType: 'batch_snapshot',
      resourceId: parent.id,
      version: 1,
    }, protectedValue(parent)));
    if (
      parentHeader.messageId !== parent.id ||
      parentHeader.paymentInformationId !== parent.id ||
      parentHeader.payrollResultHash !== parent.payrollResultHash
    ) throw new ConflictException({
      code: 'TREASURY_ADJUSTMENT_PARENT_INTEGRITY_FAILED',
      message: '原代发批次密文与控制摘要不一致',
    });
    const [debtorRecord, creditorRecord] = await Promise.all([
      this.accounts.findOne({
        tenantId: this.tenantId(),
        id: parentHeader.debtorBankAccountId,
        ownerType: 'organization',
        ownerId: this.tenantId(),
        status: 'active',
      }).session(session).lean().exec(),
      this.accounts.findOne({
        tenantId: this.tenantId(),
        ownerType: 'employee',
        ownerId: source.employeeId,
        status: 'active',
      }).session(session).lean().exec(),
    ]);
    if (debtorRecord === null || creditorRecord === null) throw new ConflictException({
      code: 'TREASURY_ADJUSTMENT_ACCOUNT_INCOMPLETE',
      message: '补发所需组织付款账户或员工活动收款账户不完整',
    });
    const debtor = accountSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(),
      resourceType: 'bank_account',
      resourceId: debtorRecord.id,
      version: debtorRecord.version,
    }, protectedValue(debtorRecord)));
    const creditor = accountSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(),
      resourceType: 'bank_account',
      resourceId: creditorRecord.id,
      version: creditorRecord.version,
    }, protectedValue(creditorRecord)));
    if (
      debtor.accountName !== parentHeader.debtorName ||
      debtor.account !== parentHeader.debtorAccount ||
      debtor.clearingCode !== parentHeader.debtorAgentClearingCode
    ) throw new ConflictException({
      code: 'TREASURY_ADJUSTMENT_DEBTOR_SNAPSHOT_CHANGED',
      message: '原代发付款账户快照与当前活动版本不一致',
    });
    const batchId = createEventId(now);
    const instructionId = createEventId(now);
    const payableResultHash = payrollDigest([{
      employeeId: source.employeeId,
      resultHash: source.correctedResultHash,
    }]);
    const protectedBatch = this.crypto.protect({
      tenantId: this.tenantId(),
      resourceType: 'batch_snapshot',
      resourceId: batchId,
      version: 1,
    }, {
      messageId: batchId,
      paymentInformationId: batchId,
      creationDateTime: now.toISOString(),
      requestedExecutionDate,
      debtorBankAccountId: debtorRecord.id,
      debtorName: debtor.accountName,
      debtorAccount: debtor.account,
      debtorAgentClearingCode: debtor.clearingCode,
      payrollResultHash: parent.payrollResultHash,
      payableResultHash,
      adjustmentId: source.adjustmentId,
      adjustmentHash: source.adjustmentHash,
    });
    await this.batches.create([{
      id: batchId,
      tenantId: this.tenantId(),
      payrollPeriodId: source.periodId,
      payrollRunId: source.payrollRunId,
      payrollResultHash: parent.payrollResultHash,
      payableResultHash,
      batchSequence: latest.batchSequence + 1,
      parentBatchId: parent.id,
      recoverySourceBatchId: null,
      adjustmentSourceId: source.adjustmentId,
      adjustmentSourceHash: source.adjustmentHash,
      purpose: 'supplement',
      format: 'ISO20022_PAIN_001_001_03',
      fileHash: null,
      lineCount: 1,
      totalMinor: source.payableMinor,
      preparedBy,
      payrollLockedBy: source.lockedBy,
      exportApprovedBy: null,
      strongAuthEvidenceId: null,
      strongAuthReferenceType: null,
      recoveryApprovedBy: null,
      recoveryStrongAuthEvidenceId: null,
      recoveryReturnId: null,
      objectEvidenceId: null,
      objectRef: null,
      bankSubmissionId: null,
      bankSubmissionEvidenceId: null,
      returnHash: null,
      successfulCount: null,
      failedCount: null,
      successfulMinor: null,
      failedMinor: null,
      freezeReason: null,
      status: 'materializing',
      version: 1,
      migrationEvidenceRef: null,
      migrationEvidenceChecksum: null,
      ...protectedRecord(protectedBatch),
    }], { session });
    const protectedInstruction = this.crypto.protect({
      tenantId: this.tenantId(),
      resourceType: 'payment_instruction',
      resourceId: instructionId,
      version: 1,
    }, {
      instructionId,
      employeeId: source.employeeId,
      bankAccountId: creditorRecord.id,
      payrollCalculationLineId: source.originalCalculationLineId,
      payrollResultHash: source.correctedResultHash,
      creditorName: creditor.accountName,
      creditorAccount: creditor.account,
      creditorAgentClearingCode: creditor.clearingCode,
      amountMinor: source.payableMinor,
      purposeCode: 'PAYROLL_ADJUSTMENT',
    });
    await this.instructions.create([{
      id: instructionId,
      tenantId: this.tenantId(),
      batchId,
      payrollCalculationLineId: source.originalCalculationLineId,
      employeeId: source.employeeId,
      bankAccountId: creditorRecord.id,
      status: 'materializing',
      bankLineReference: null,
      ...protectedRecord(protectedInstruction),
    }], { session });
    await this.outbox.append({
      type: 'treasury.disbursement.adjustment_supplement_requested',
      tenantId: this.tenantId(),
      aggregateId: batchId,
      version: 1,
      occurredAt: now.toISOString(),
      data: {
        adjustmentId: source.adjustmentId,
        parentBatchId: parent.id,
        payrollPeriodId: source.periodId,
        payrollRunId: source.payrollRunId,
        lineCount: 1,
        totalMinor: source.payableMinor,
        status: 'materializing',
      },
    }, session);
    return Object.freeze({
      id: batchId,
      payrollPeriodId: source.periodId,
      payrollRunId: source.payrollRunId,
      status: 'materializing',
      version: 1,
      lineCount: 1,
      totalMinor: source.payableMinor,
      fileHash: null,
      objectEvidenceId: null,
      bankSubmissionId: null,
      bankSubmissionEvidenceId: null,
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof z.ZodError) throw new ConflictException({
        code: 'TREASURY_ADJUSTMENT_PROTECTED_DATA_INVALID',
        message: '补发所需资金密文结构非法',
      });
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { readonly code?: unknown }).code === 11000
      ) throw new ConflictException({
        code: 'TREASURY_ADJUSTMENT_ALREADY_EXISTS',
        message: '工资调整已存在补发子批次',
      });
      throw error;
    }
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }
}

function existingSupplementSummary(
  batch: TreasuryDisbursementBatchRecord,
  source: LockedPayrollSupplementSource,
): TreasuryDisbursementSummary {
  if (
    batch.purpose !== 'supplement' ||
    batch.adjustmentSourceId !== source.adjustmentId ||
    batch.adjustmentSourceHash !== source.adjustmentHash ||
    batch.totalMinor !== source.payableMinor ||
    batch.lineCount !== 1
  ) throw new ConflictException({
    code: 'TREASURY_ADJUSTMENT_EXISTING_BINDING_MISMATCH',
    message: '既有补发子批次与工资调整来源不一致',
  });
  if (!['materializing', 'prepared', 'exported', 'submitting', 'submitted'].includes(batch.status)) {
    throw new ConflictException({
      code: 'TREASURY_ADJUSTMENT_ALREADY_ADVANCED',
      message: '工资补发子批次已进入回盘或对账阶段',
    });
  }
  return Object.freeze({
    id: batch.id,
    payrollPeriodId: batch.payrollPeriodId,
    payrollRunId: batch.payrollRunId,
    status: batch.status as TreasuryDisbursementSummary['status'],
    version: batch.version,
    lineCount: batch.lineCount,
    totalMinor: batch.totalMinor,
    fileHash: batch.fileHash,
    objectEvidenceId: batch.objectEvidenceId,
    bankSubmissionId: batch.bankSubmissionId,
    bankSubmissionEvidenceId: batch.bankSubmissionEvidenceId,
  });
}

function isExecutionWindow(value: string, now: Date): boolean {
  if (!DATE.test(value)) return false;
  const requested = new Date(`${value}T00:00:00.000Z`);
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const maximum = new Date(today);
  maximum.setUTCDate(maximum.getUTCDate() + 90);
  return requested.getTime() >= today.getTime() && requested.getTime() <= maximum.getTime();
}

function protectedValue(record: {
  readonly dataKeyId: string;
  readonly dataIv: string;
  readonly dataCiphertext: string;
  readonly dataAuthTag: string;
}) {
  return {
    keyId: record.dataKeyId,
    iv: record.dataIv,
    ciphertext: record.dataCiphertext,
    authTag: record.dataAuthTag,
  };
}

function deriveKey(root: string, stage: string): string {
  return `treasury-adjustment:${createHash('sha256')
    .update(JSON.stringify([root, stage]), 'utf8')
    .digest('base64url')}`;
}

function protectedRecord(value: {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}) {
  return {
    dataKeyId: value.keyId,
    dataIv: value.iv,
    dataCiphertext: value.ciphertext,
    dataAuthTag: value.authTag,
  };
}
