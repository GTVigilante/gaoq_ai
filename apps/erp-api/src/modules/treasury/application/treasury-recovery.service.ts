import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { WebAuthnService } from '../../identity/strong-auth/webauthn.service.js';
import { payrollDigest } from '../../payroll/domain/index.js';
import { LegacyPayrollBoundaryService } from '../../payroll/legacy-payroll-boundary.service.js';
import { TreasuryDataCryptoService } from '../persistence/treasury-data-crypto.service.js';
import { TreasuryOutboxWriter } from '../persistence/treasury-outbox.writer.js';
import {
  TreasuryBankAccountRecord,
  type TreasuryBankAccountDocument,
  TreasuryBankReturnRecord,
  type TreasuryBankReturnDocument,
  TreasuryDisbursementBatchRecord,
  type TreasuryDisbursementBatchDocument,
  TreasuryPaymentInstructionRecord,
  type TreasuryPaymentInstructionDocument,
} from '../persistence/treasury.schemas.js';
import type { CreateTreasuryRecoveryDto } from './treasury.dto.js';
import {
  TreasuryDisbursementService,
  type TreasuryDisbursementSummary,
} from './treasury-disbursement.service.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const returnManifestSchema = z.object({
  returnId: z.string().regex(ULID_PATTERN), tenantId: z.string().regex(ID),
  batchId: z.string().regex(ULID_PATTERN),
  bankSubmissionId: z.string().regex(ID), sequence: z.literal(1), returnHash: z.string().regex(HASH),
  lines: z.array(z.object({
    instructionId: z.string().regex(ID), outcome: z.enum(['succeeded', 'failed']),
    amountMinor: z.number().int().safe().positive(), bankLineReference: z.string().regex(ID),
  }).strict()).min(1).max(5_000),
}).strict();
const instructionSchema = z.object({
  instructionId: z.string().regex(ID), employeeId: z.string().regex(ID),
  bankAccountId: z.string().regex(ID), payrollCalculationLineId: z.string().regex(ID),
  payrollResultHash: z.string().regex(HASH), creditorName: z.string(),
  creditorAccount: z.string(), creditorAgentClearingCode: z.string(),
  amountMinor: z.number().int().safe().positive(), purposeCode: z.literal('PAYROLL'),
}).strict();
const accountSchema = z.object({
  accountName: z.string().min(1).max(140), account: z.string().regex(/^[0-9]{8,32}$/),
  clearingCode: z.string().regex(/^[0-9A-Z]{8,12}$/), currency: z.literal('CNY'),
}).strict();
const batchSnapshotSchema = z.object({
  messageId: z.string().regex(ID), paymentInformationId: z.string().regex(ID),
  creationDateTime: z.iso.datetime({ offset: true }), requestedExecutionDate: z.string().regex(DATE),
  debtorBankAccountId: z.string().regex(ID), debtorName: z.string().min(1).max(140),
  debtorAccount: z.string().regex(/^[0-9]{8,32}$/),
  debtorAgentClearingCode: z.string().regex(/^[0-9A-Z]{8,12}$/),
  payrollResultHash: z.string().regex(HASH), payableResultHash: z.string().regex(HASH),
}).strict();

/** 对干净的部分失败回盘创建强认证关联子批次；父批次与原支付指令永不改写。 */
@Injectable()
export class TreasuryRecoveryService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly boundary: LegacyPayrollBoundaryService,
    private readonly strongAuth: WebAuthnService,
    private readonly crypto: TreasuryDataCryptoService,
    private readonly outbox: TreasuryOutboxWriter,
    private readonly disbursements: TreasuryDisbursementService,
    @InjectModel(TreasuryBankAccountRecord.name)
    private readonly accounts: Model<TreasuryBankAccountDocument>,
    @InjectModel(TreasuryPaymentInstructionRecord.name)
    private readonly instructions: Model<TreasuryPaymentInstructionDocument>,
    @InjectModel(TreasuryDisbursementBatchRecord.name)
    private readonly batches: Model<TreasuryDisbursementBatchDocument>,
    @InjectModel(TreasuryBankReturnRecord.name)
    private readonly returns: Model<TreasuryBankReturnDocument>,
  ) {}

  async create(
    key: string,
    parentBatchId: string,
    input: CreateTreasuryRecoveryDto,
    token: VerifiedAccessToken,
  ): Promise<TreasuryDisbursementSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:treasury:recovery:create')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少失败代发恢复权限',
    });
    if (
      actor.actorType !== 'user' || token.actorType !== 'user' ||
      token.tenantId !== this.tenantId() || token.actorId !== actor.actorId
    ) throw new ForbiddenException({
      code: 'TREASURY_RECOVERY_APPROVER_IDENTITY_INVALID', message: '失败代发恢复身份上下文非法',
    });
    this.boundary.assertLegacy();
    if (!ID.test(parentBatchId)) throw new BadRequestException({
      code: 'TREASURY_BATCH_ID_INVALID', message: '父代发批次标识非法',
    });
    const evidence = await this.strongAuth.requireVerifiedEvidence({
      evidenceId: input.strongAuthEvidenceId, tenantId: token.tenantId,
      actorId: token.actorId, sessionId: token.sessionId, operationId: parentBatchId,
    });
    const staged = await this.run(() => this.idempotency.execute(
      'treasury.disbursement.recovery.stage', key, {
        parentBatchId, expectedVersion: input.expectedVersion, evidenceId: evidence.evidenceId,
      }, async (session) => this.stage(
        parentBatchId, input.expectedVersion, actor.actorId,
        evidence.evidenceId, evidence.method, session,
      ),
    ));
    return this.disbursements.materializeStaged(deriveKey(key, 'materialize-recovery'), staged.id);
  }

  private async stage(
    parentBatchId: string,
    expectedVersion: number,
    approvedBy: string,
    evidenceId: string,
    strongAuthMethod: 'webauthn_uv',
    session: ClientSession,
  ): Promise<TreasuryDisbursementSummary> {
    const existing = await this.batches.findOne({
      tenantId: this.tenantId(), recoverySourceBatchId: parentBatchId,
    }).session(session).lean().exec();
    if (existing !== null) return stageSummary(existing, approvedBy, evidenceId);
    const parent = await this.batches.findOne({
      tenantId: this.tenantId(), id: parentBatchId,
    }).session(session).lean().exec();
    if (parent === null) throw new NotFoundException({
      code: 'TREASURY_BATCH_NOT_FOUND', message: '父代发批次不存在',
    });
    if (
      parent.status !== 'frozen' || parent.version !== expectedVersion ||
      parent.freezeReason !== 'PARTIAL_SUCCESS' || parent.failedCount === null ||
      parent.failedCount < 1 || parent.failedMinor === null || parent.failedMinor < 1 ||
      parent.successfulCount === null || parent.successfulMinor === null ||
      parent.returnHash === null || parent.bankSubmissionId === null
    ) throw new ConflictException({
      code: 'TREASURY_RECOVERY_PARENT_INVALID', message: '只有干净部分失败的冻结批次可创建恢复子批次',
    });
    if ([parent.preparedBy, parent.payrollLockedBy, parent.exportApprovedBy].includes(approvedBy)) {
      throw new ForbiddenException({
        code: 'TREASURY_RECOVERY_INDEPENDENCE_REQUIRED', message: '恢复批准人必须独立于原控制链',
      });
    }
    const returned = await this.returns.findOne({
      tenantId: this.tenantId(), batchId: parent.id, outcome: 'frozen',
    }).sort({ sequence: -1 }).session(session).lean().exec();
    if (
      returned === null || returned.returnHash !== parent.returnHash ||
      returned.bankSubmissionId !== parent.bankSubmissionId || !returned.signatureVerified ||
      !returned.malwareClean || returned.unknownCount !== 0 || returned.duplicateCount !== 0 ||
      returned.lineAmountMismatchCount !== 0 || returned.failedCount !== parent.failedCount ||
      returned.failedMinor !== parent.failedMinor
    ) throw new ConflictException({
      code: 'TREASURY_RECOVERY_RETURN_INVALID', message: '父批次回盘不满足安全恢复条件',
    });
    const manifest = returnManifestSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(), resourceType: 'bank_return',
      resourceId: returned.id, version: returned.sequence,
    }, protectedValue(returned)));
    if (
      manifest.returnId !== returned.id || manifest.tenantId !== this.tenantId() ||
      manifest.batchId !== parent.id || manifest.bankSubmissionId !== parent.bankSubmissionId ||
      manifest.returnHash !== parent.returnHash
    ) throw new ConflictException({
      code: 'TREASURY_RECOVERY_RETURN_BINDING_MISMATCH', message: '回盘密文与父批次绑定不一致',
    });
    const originalRecords = await this.instructions.find({
      tenantId: this.tenantId(), batchId: parent.id, status: 'frozen',
    }).session(session).lean().exec();
    if (originalRecords.length !== parent.lineCount) throw new ConflictException({
      code: 'TREASURY_RECOVERY_INSTRUCTION_INCOMPLETE', message: '父批次冻结指令不完整',
    });
    const original = new Map(originalRecords.map((record) => {
      const data = instructionSchema.parse(this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'payment_instruction',
        resourceId: record.id, version: 1,
      }, protectedValue(record)));
      if (
        data.instructionId !== record.id || data.employeeId !== record.employeeId ||
        data.bankAccountId !== record.bankAccountId ||
        data.payrollCalculationLineId !== record.payrollCalculationLineId
      ) throw new ConflictException({
        code: 'TREASURY_RECOVERY_INSTRUCTION_BINDING_MISMATCH',
        message: '父批次支付指令密文绑定不一致',
      });
      return [record.id, data] as const;
    }));
    const seen = new Set<string>();
    for (const line of manifest.lines) {
      const data = original.get(line.instructionId);
      if (seen.has(line.instructionId) || data === undefined || data.amountMinor !== line.amountMinor) {
        throw new ConflictException({
          code: 'TREASURY_RECOVERY_MANIFEST_MISMATCH', message: '恢复清单无法与父批次逐行核对',
        });
      }
      seen.add(line.instructionId);
    }
    if (seen.size !== original.size) throw new ConflictException({
      code: 'TREASURY_RECOVERY_MANIFEST_INCOMPLETE', message: '恢复清单未覆盖父批次全部指令',
    });
    const failed = manifest.lines.filter((line) => line.outcome === 'failed').map((line) => {
      const data = original.get(line.instructionId);
      if (data === undefined) throw new Error('TREASURY_RECOVERY_INSTRUCTION_MISSING');
      return data;
    });
    const failedMinor = safeSum(failed.map((line) => line.amountMinor));
    const succeeded = manifest.lines.filter((line) => line.outcome === 'succeeded');
    const successfulMinor = safeSum(succeeded.map((line) => line.amountMinor), true);
    if (
      failed.length !== parent.failedCount || failedMinor !== parent.failedMinor ||
      succeeded.length !== parent.successfulCount || successfulMinor !== parent.successfulMinor ||
      succeeded.length !== returned.successfulCount || successfulMinor !== returned.successfulMinor
    ) {
      throw new ConflictException({
        code: 'TREASURY_RECOVERY_TOTAL_MISMATCH', message: '恢复失败行汇总与父批次不一致',
      });
    }
    const employeeIds = failed.map((line) => line.employeeId);
    const accountRecords = await this.accounts.find({
      tenantId: this.tenantId(), ownerType: 'employee', ownerId: { $in: employeeIds }, status: 'active',
    }).session(session).lean().exec();
    if (
      accountRecords.length !== employeeIds.length ||
      new Set(accountRecords.map((record) => record.ownerId)).size !== employeeIds.length
    ) throw new ConflictException({
      code: 'TREASURY_RECOVERY_ACCOUNT_INCOMPLETE', message: '失败员工当前活动收款账户不完整',
    });
    const accounts = new Map(accountRecords.map((record) => [record.ownerId, {
      record, data: accountSchema.parse(this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'bank_account',
        resourceId: record.id, version: record.version,
      }, protectedValue(record))),
    }]));
    const parentHeader = batchSnapshotSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(), resourceType: 'batch_snapshot', resourceId: parent.id, version: 1,
    }, protectedValue(parent)));
    if (
      parentHeader.messageId !== parent.id || parentHeader.paymentInformationId !== parent.id ||
      parentHeader.payrollResultHash !== parent.payrollResultHash ||
      parentHeader.payableResultHash !== parent.payableResultHash
    ) throw new ConflictException({
      code: 'TREASURY_RECOVERY_BATCH_BINDING_MISMATCH', message: '父批次密文快照绑定不一致',
    });
    const latest = await this.batches.findOne({
      tenantId: this.tenantId(), payrollRunId: parent.payrollRunId,
    }).sort({ batchSequence: -1 }).session(session).lean().exec();
    if (latest === null || latest.batchSequence >= Number.MAX_SAFE_INTEGER) throw new ConflictException({
      code: 'TREASURY_RECOVERY_SEQUENCE_INVALID', message: '恢复子批次序号不可用',
    });
    const now = new Date();
    const batchId = createEventId(now);
    const payableResultHash = payrollDigest(failed.map((line) => ({
      employeeId: line.employeeId, resultHash: line.payrollResultHash,
    })).sort((left, right) => left.employeeId.localeCompare(right.employeeId)));
    const protectedBatch = this.crypto.protect({
      tenantId: this.tenantId(), resourceType: 'batch_snapshot', resourceId: batchId, version: 1,
    }, {
      messageId: batchId, paymentInformationId: batchId, creationDateTime: now.toISOString(),
      requestedExecutionDate: now.toISOString().slice(0, 10),
      debtorBankAccountId: parentHeader.debtorBankAccountId,
      debtorName: parentHeader.debtorName, debtorAccount: parentHeader.debtorAccount,
      debtorAgentClearingCode: parentHeader.debtorAgentClearingCode,
      payrollResultHash: parent.payrollResultHash, payableResultHash,
    });
    await this.batches.create([{
      id: batchId, tenantId: this.tenantId(), payrollPeriodId: parent.payrollPeriodId,
      payrollRunId: parent.payrollRunId, payrollResultHash: parent.payrollResultHash,
      payableResultHash, batchSequence: latest.batchSequence + 1, parentBatchId: parent.id,
      recoverySourceBatchId: parent.id,
      purpose: 'recovery', format: parent.format, fileHash: null,
      lineCount: failed.length, totalMinor: failedMinor, preparedBy: approvedBy,
      payrollLockedBy: parent.payrollLockedBy, exportApprovedBy: null,
      strongAuthEvidenceId: null, strongAuthReferenceType: null,
      recoveryApprovedBy: approvedBy,
      recoveryStrongAuthEvidenceId: evidenceId, recoveryReturnId: returned.id,
      objectEvidenceId: null, objectRef: null, bankSubmissionId: null,
      bankSubmissionEvidenceId: null, returnHash: null, successfulCount: null,
      failedCount: null, successfulMinor: null, failedMinor: null, freezeReason: null,
      status: 'materializing', version: 1,
      migrationEvidenceRef: null, migrationEvidenceChecksum: null,
      ...protectedRecord(protectedBatch),
    }], { session });
    const childInstructions = failed.map((source) => {
      const account = accounts.get(source.employeeId);
      if (account === undefined) throw new Error('TREASURY_RECOVERY_ACCOUNT_MISSING');
      const id = createEventId(now);
      const protectedInstruction = this.crypto.protect({
        tenantId: this.tenantId(), resourceType: 'payment_instruction', resourceId: id, version: 1,
      }, {
        instructionId: id, employeeId: source.employeeId, bankAccountId: account.record.id,
        payrollCalculationLineId: source.payrollCalculationLineId,
        payrollResultHash: source.payrollResultHash, creditorName: account.data.accountName,
        creditorAccount: account.data.account,
        creditorAgentClearingCode: account.data.clearingCode,
        amountMinor: source.amountMinor, purposeCode: 'PAYROLL',
      });
      return {
        id, tenantId: this.tenantId(), batchId, employeeId: source.employeeId,
        payrollCalculationLineId: source.payrollCalculationLineId,
        bankAccountId: account.record.id, status: 'materializing' as const, bankLineReference: null,
        ...protectedRecord(protectedInstruction),
      };
    });
    await this.instructions.create(childInstructions, { session });
    await this.outbox.append({
      type: 'treasury.disbursement.recovery_requested', tenantId: this.tenantId(),
      aggregateId: batchId, version: 1, occurredAt: now.toISOString(), data: {
        parentBatchId: parent.id, payrollPeriodId: parent.payrollPeriodId,
        payrollRunId: parent.payrollRunId, returnHash: parent.returnHash,
        failedCount: failed.length, failedMinor, status: 'materializing', strongAuthMethod,
      },
    }, session);
    return Object.freeze({
      id: batchId, payrollPeriodId: parent.payrollPeriodId, payrollRunId: parent.payrollRunId,
      status: 'materializing', version: 1, lineCount: failed.length, totalMinor: failedMinor,
      fileHash: null, objectEvidenceId: null,
      bankSubmissionId: null, bankSubmissionEvidenceId: null,
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof z.ZodError) throw new ConflictException({
        code: 'TREASURY_RECOVERY_PROTECTED_DATA_INVALID', message: '恢复所需资金密文非法',
      });
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000) {
        throw new ConflictException({
          code: 'TREASURY_RECOVERY_ALREADY_EXISTS', message: '父批次已存在恢复子批次',
        });
      }
      throw error;
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function stageSummary(
  batch: TreasuryDisbursementBatchRecord,
  approvedBy: string,
  evidenceId: string,
): TreasuryDisbursementSummary {
  if (
    (batch.status !== 'materializing' && batch.status !== 'prepared') ||
    batch.purpose !== 'recovery' || batch.parentBatchId === null ||
    batch.recoveryApprovedBy !== approvedBy || batch.recoveryStrongAuthEvidenceId !== evidenceId
  ) throw new ConflictException({
    code: 'TREASURY_RECOVERY_ALREADY_ADVANCED', message: '恢复子批次已进入后续控制链',
  });
  return Object.freeze({
    id: batch.id, payrollPeriodId: batch.payrollPeriodId, payrollRunId: batch.payrollRunId,
    status: batch.status, version: batch.version, lineCount: batch.lineCount,
    totalMinor: batch.totalMinor, fileHash: batch.fileHash,
    objectEvidenceId: batch.objectEvidenceId, bankSubmissionId: batch.bankSubmissionId,
    bankSubmissionEvidenceId: batch.bankSubmissionEvidenceId,
  });
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

function protectedRecord(value: {
  readonly keyId: string; readonly iv: string;
  readonly ciphertext: string; readonly authTag: string;
}) {
  return {
    dataKeyId: value.keyId, dataIv: value.iv,
    dataCiphertext: value.ciphertext, dataAuthTag: value.authTag,
  };
}

function safeSum(values: readonly number[], allowZero = false): number {
  const result = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (result < (allowZero ? 0n : 1n) || result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConflictException({
    code: 'TREASURY_RECOVERY_AMOUNT_INVALID', message: '恢复子批次金额非法',
  });
  }
  return Number(result);
}

function deriveKey(root: string, stage: string): string {
  const hash = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `treasury:${hash}`;
}
