import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  applyBankReturn,
  type DisbursementBatch,
  DisbursementBatchError,
} from '../domain/index.js';
import {
  TreasuryBankReturnInbox,
  type TreasuryBankReturnManifest,
} from '../integration/treasury-bank-return.ports.js';
import { TreasuryDataCryptoService } from '../persistence/treasury-data-crypto.service.js';
import { TreasuryOutboxWriter } from '../persistence/treasury-outbox.writer.js';
import {
  TreasuryBankReturnRecord,
  type TreasuryBankReturnDocument,
  TreasuryDisbursementBatchRecord,
  type TreasuryDisbursementBatchDocument,
  TreasuryPaymentInstructionRecord,
  type TreasuryPaymentInstructionDocument,
} from '../persistence/treasury.schemas.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const instructionSchema = z.object({
  instructionId: z.string().regex(ID), employeeId: z.string().regex(ID),
  bankAccountId: z.string().regex(ID), payrollCalculationLineId: z.string().regex(ID),
  payrollResultHash: z.string().regex(HASH), creditorName: z.string(),
  creditorAccount: z.string(), creditorAgentClearingCode: z.string(),
  amountMinor: z.number().int().safe().positive(), purposeCode: z.literal('PAYROLL'),
}).strict();

export interface TreasuryBankReturnSummary extends Record<string, unknown> {
  readonly id: string;
  readonly batchId: string;
  readonly status: 'reconciling' | 'frozen';
  readonly batchVersion: number;
  readonly returnHash: string;
  readonly successfulCount: number;
  readonly failedCount: number;
  readonly unknownCount: number;
  readonly duplicateCount: number;
  readonly lineAmountMismatchCount: number;
  readonly successfulMinor: number;
  readonly failedMinor: number;
  readonly freezeReason: string | null;
}

/** 受保护回盘清单逐行核对服务；原始文件、账号和员工金额不出 Inbox/Treasury 密文边界。 */
@Injectable()
export class TreasuryBankReturnService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly inbox: TreasuryBankReturnInbox,
    private readonly crypto: TreasuryDataCryptoService,
    private readonly outbox: TreasuryOutboxWriter,
    @InjectModel(TreasuryDisbursementBatchRecord.name)
    private readonly batches: Model<TreasuryDisbursementBatchDocument>,
    @InjectModel(TreasuryPaymentInstructionRecord.name)
    private readonly instructions: Model<TreasuryPaymentInstructionDocument>,
    @InjectModel(TreasuryBankReturnRecord.name)
    private readonly returns: Model<TreasuryBankReturnDocument>,
  ) {}

  async ingest(
    key: string,
    batchId: string,
    expectedVersion: number,
  ): Promise<TreasuryBankReturnSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:treasury:return:ingest')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少银行回盘接收权限',
    });
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'TREASURY_BANK_RETURN_SERVICE_REQUIRED', message: '只允许受信任回盘服务执行',
      });
    }
    if (!ID.test(batchId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new BadRequestException({ code: 'TREASURY_BANK_RETURN_INPUT_INVALID', message: '回盘引用非法' });
    }
    const current = await this.requireBatch(batchId);
    if (current.status !== 'submitted') {
      const replay = await this.returns.findOne({
        tenantId: this.tenantId(), batchId,
      }).sort({ sequence: -1 }).lean().exec();
      if (
        replay !== null && current.version === expectedVersion + 1 &&
        (current.status === 'reconciling' || current.status === 'frozen')
      ) {
        return returnSummary(replay, current);
      }
      throw new ConflictException({
        code: 'TREASURY_BANK_RETURN_STATE_INVALID', message: '代发批次不处于待回盘状态',
      });
    }
    if (current.version !== expectedVersion || current.bankSubmissionId === null) {
      throw new ConflictException({
        code: 'TREASURY_BANK_RETURN_STATE_INVALID', message: '代发批次版本或提交证据已变化',
      });
    }
    const manifest = await this.inbox.claim({
      tenantId: this.tenantId(), batchId, bankSubmissionId: current.bankSubmissionId,
    });
    if (manifest.sequence !== 1) throw new ConflictException({
      code: 'TREASURY_BANK_RETURN_SEQUENCE_INVALID',
      message: '当前终态回盘契约只接受首序号，乱序回盘已拒绝',
    });
    return this.run(() => this.idempotency.execute(
      'treasury.bank_return.ingest', key, {
        batchId, expectedVersion, returnId: manifest.returnId, returnHash: manifest.returnHash,
      }, async (session) => this.apply(current, manifest, expectedVersion, session),
    ));
  }

  private async apply(
    initial: TreasuryDisbursementBatchRecord,
    manifest: TreasuryBankReturnManifest,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<TreasuryBankReturnSummary> {
    const current = await this.requireBatch(initial.id, session);
    if (
      current.status !== 'submitted' || current.version !== expectedVersion ||
      current.bankSubmissionId !== manifest.bankSubmissionId
    ) throw new ConflictException({
      code: 'TREASURY_BANK_RETURN_BINDING_CHANGED', message: '回盘处理期间批次绑定已变化',
    });
    const records = await this.instructions.find({
      tenantId: this.tenantId(), batchId: current.id, status: 'submitted',
    }).lean().exec();
    if (records.length !== current.lineCount) throw new ConflictException({
      code: 'TREASURY_BANK_RETURN_INSTRUCTION_INCOMPLETE', message: '待回盘支付指令不完整',
    });
    const expected = new Map(records.map((record) => {
      const data = instructionSchema.parse(this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'payment_instruction',
        resourceId: record.id, version: 1,
      }, protectedValue(record)));
      if (data.instructionId !== record.id) throw new ConflictException({
        code: 'TREASURY_RETURN_INSTRUCTION_BINDING_MISMATCH', message: '支付指令密文绑定不一致',
      });
      return [record.id, { record, amountMinor: data.amountMinor }] as const;
    }));
    const seen = new Set<string>();
    let duplicateCount = 0;
    let unknownCount = 0;
    let lineAmountMismatchCount = 0;
    const valid: TreasuryBankReturnManifest['lines'][number][] = [];
    for (const line of manifest.lines) {
      if (seen.has(line.instructionId)) { duplicateCount += 1; continue; }
      seen.add(line.instructionId);
      const item = expected.get(line.instructionId);
      if (item === undefined) { unknownCount += 1; continue; }
      if (item.amountMinor !== line.amountMinor) { lineAmountMismatchCount += 1; continue; }
      valid.push(line);
    }
    const succeeded = valid.filter((line) => line.outcome === 'succeeded');
    const failed = valid.filter((line) => line.outcome === 'failed');
    const successfulMinor = sumMinor(succeeded.map((line) => line.amountMinor));
    const failedMinor = sumMinor(failed.map((line) => line.amountMinor));
    const receivedAt = new Date(manifest.receivedAt);
    if (!Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 5 * 60_000) {
      throw new ConflictException({
        code: 'TREASURY_BANK_RETURN_TIME_INVALID', message: '银行回盘接收时间非法',
      });
    }
    const next = applyBankReturn(batchFromRecord(current), {
      tenantId: this.tenantId(), expectedVersion, returnHash: manifest.returnHash,
      signatureVerified: manifest.signatureVerified, fileProtectionPassed: manifest.malwareClean,
      successfulCount: succeeded.length, failedCount: failed.length,
      unknownCount, duplicateCount, lineAmountMismatchCount, successfulMinor, failedMinor,
    }, receivedAt);
    if (next.status !== 'reconciling' && next.status !== 'frozen') {
      throw new Error('TREASURY_BANK_RETURN_DOMAIN_STATE_INVALID');
    }
    const protectedManifest = this.crypto.protect({
      tenantId: this.tenantId(), resourceType: 'bank_return',
      resourceId: manifest.returnId, version: manifest.sequence,
    }, {
      returnId: manifest.returnId, tenantId: manifest.tenantId, batchId: manifest.batchId,
      bankSubmissionId: manifest.bankSubmissionId, sequence: manifest.sequence,
      returnHash: manifest.returnHash, lines: manifest.lines,
    });
    await this.returns.create([{
      id: manifest.returnId, tenantId: this.tenantId(), batchId: current.id,
      bankSubmissionId: manifest.bankSubmissionId, sequence: manifest.sequence,
      returnHash: manifest.returnHash, objectEvidenceId: manifest.objectEvidenceId,
      objectRef: manifest.objectRef, signatureEvidenceId: manifest.signatureEvidenceId,
      signatureVerified: manifest.signatureVerified,
      malwareScanEvidenceId: manifest.malwareScanEvidenceId, malwareClean: manifest.malwareClean,
      successfulCount: succeeded.length, failedCount: failed.length,
      unknownCount, duplicateCount, lineAmountMismatchCount, successfulMinor, failedMinor,
      outcome: next.status === 'reconciling' ? 'accepted' : 'frozen',
      receivedAt, ...protectedRecord(protectedManifest),
    }], { session });
    const batchUpdate = await this.batches.updateOne({
      tenantId: this.tenantId(), id: current.id, status: 'submitted', version: expectedVersion,
    }, { $set: {
      status: next.status, version: next.version, returnHash: next.returnHash,
      successfulCount: next.successfulCount, failedCount: next.failedCount,
      successfulMinor: next.successfulMinor, failedMinor: next.failedMinor,
      freezeReason: next.freezeReason,
    } }, { session, runValidators: true });
    if (batchUpdate.modifiedCount !== 1) throw new ConflictException({
      code: 'TREASURY_BANK_RETURN_WRITE_CONFLICT', message: '回盘批次发生并发冲突',
    });
    if (next.status === 'reconciling') {
      for (const line of valid) {
        const updated = await this.instructions.updateOne({
          tenantId: this.tenantId(), batchId: current.id,
          id: line.instructionId, status: 'submitted',
        }, { $set: {
          status: line.outcome, bankLineReference: line.bankLineReference,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'TREASURY_RETURN_LINE_WRITE_CONFLICT', message: '回盘支付行发生并发冲突',
        });
      }
    } else {
      const frozen = await this.instructions.updateMany({
        tenantId: this.tenantId(), batchId: current.id, status: 'submitted',
      }, { $set: { status: 'frozen' } }, { session, runValidators: true });
      if (frozen.modifiedCount !== current.lineCount) throw new ConflictException({
        code: 'TREASURY_RETURN_FREEZE_INCOMPLETE', message: '异常回盘未完整冻结支付指令',
      });
    }
    await this.outbox.append({
      type: 'treasury.bank_return.applied', tenantId: this.tenantId(),
      aggregateId: current.id, version: next.version, occurredAt: next.updatedAt, data: {
        returnHash: manifest.returnHash, outcome: next.status,
        freezeReason: next.freezeReason ?? 'none', successfulCount: succeeded.length,
        failedCount: failed.length, unknownCount, duplicateCount, lineAmountMismatchCount,
        successfulMinor, failedMinor, objectEvidenceId: manifest.objectEvidenceId,
        signatureEvidenceId: manifest.signatureEvidenceId,
        malwareScanEvidenceId: manifest.malwareScanEvidenceId,
      },
    }, session);
    return Object.freeze({
      id: manifest.returnId, batchId: current.id, status: next.status,
      batchVersion: next.version, returnHash: manifest.returnHash,
      successfulCount: succeeded.length, failedCount: failed.length,
      unknownCount, duplicateCount, lineAmountMismatchCount,
      successfulMinor, failedMinor, freezeReason: next.freezeReason,
    });
  }

  private async requireBatch(id: string, session?: ClientSession) {
    const query = this.batches.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const batch = await query.lean().exec();
    if (batch === null) throw new NotFoundException({
      code: 'TREASURY_BATCH_NOT_FOUND', message: '代发批次不存在',
    });
    return batch;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof DisbursementBatchError) {
        throw new ConflictException({ code: error.code, message: error.message });
      }
      if (error instanceof z.ZodError) throw new ConflictException({
        code: 'TREASURY_RETURN_PROTECTED_DATA_INVALID', message: '回盘核对所需密文数据非法',
      });
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000) {
        throw new ConflictException({ code: 'TREASURY_BANK_RETURN_REPLAYED', message: '银行回盘已处理' });
      }
      throw error;
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
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

function batchFromRecord(record: TreasuryDisbursementBatchRecord): DisbursementBatch {
  if (record.fileHash === null || record.status !== 'submitted') {
    throw new Error('TREASURY_RETURN_BATCH_INVALID');
  }
  return Object.freeze({
    id: record.id, tenantId: record.tenantId,
    payrollPeriodId: record.payrollPeriodId, payrollRunId: record.payrollRunId,
    format: record.format, fileHash: record.fileHash, lineCount: record.lineCount,
    totalMinor: record.totalMinor, preparedBy: record.preparedBy,
    payrollLockedBy: record.payrollLockedBy, exportApprovedBy: record.exportApprovedBy,
    strongAuthEvidenceId: record.strongAuthEvidenceId,
    objectEvidenceId: record.objectEvidenceId, bankSubmissionId: record.bankSubmissionId,
    bankSubmissionEvidenceId: record.bankSubmissionEvidenceId, returnHash: record.returnHash,
    successfulCount: record.successfulCount, failedCount: record.failedCount,
    successfulMinor: record.successfulMinor, failedMinor: record.failedMinor,
    freezeReason: record.freezeReason, status: record.status, version: record.version,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  });
}

function sumMinor(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConflictException({
    code: 'TREASURY_RETURN_AMOUNT_OVERFLOW', message: '回盘金额汇总溢出',
  });
  return Number(total);
}

function returnSummary(
  record: TreasuryBankReturnRecord,
  batch: TreasuryDisbursementBatchRecord,
): TreasuryBankReturnSummary {
  return Object.freeze({
    id: record.id, batchId: record.batchId,
    status: batch.status === 'reconciling' ? 'reconciling' : 'frozen',
    batchVersion: batch.version, returnHash: record.returnHash,
    successfulCount: record.successfulCount, failedCount: record.failedCount,
    unknownCount: record.unknownCount, duplicateCount: record.duplicateCount,
    lineAmountMismatchCount: record.lineAmountMismatchCount,
    successfulMinor: record.successfulMinor, failedMinor: record.failedMinor,
    freezeReason: batch.freezeReason,
  });
}
