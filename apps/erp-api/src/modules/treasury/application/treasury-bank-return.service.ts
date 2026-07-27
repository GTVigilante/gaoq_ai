import { createHash } from 'node:crypto';

import { createEventId } from '@gaoq/shared-utils';
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
import { PayrollAdjustmentService } from '../../payroll/application/payroll-adjustment.service.js';
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
  amountMinor: z.number().int().safe().positive(),
  purposeCode: z.enum(['PAYROLL', 'PAYROLL_ADJUSTMENT']),
}).strict();

export interface TreasuryBankReturnSummary extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
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

export interface ImportTreasuryBankReturnFromMigrationInput {
  readonly targetId: string | null;
  readonly batchId: string;
  readonly expectedBatchVersion: number;
  readonly expectedBankSubmissionId: string;
  readonly lines: readonly {
    readonly employeeId: string;
    readonly expectedAmountMinor: number;
    readonly bankLineReference: string;
  }[];
  readonly expectedLineCount: number;
  readonly expectedTotalMinor: number;
  readonly signatureVerified: true;
  readonly malwareClean: true;
  readonly receivedAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

/** 受保护回盘清单逐行核对服务；原始文件、账号和员工金额不出 Inbox/Treasury 密文边界。 */
@Injectable()
export class TreasuryBankReturnService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly payrollAdjustments: PayrollAdjustmentService,
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

  /** 迁移专用：以既有支付指令重建全量成功回盘，不调用外部 Inbox。 */
  async importCleanFromMigration(
    key: string,
    input: ImportTreasuryBankReturnFromMigrationInput,
  ): Promise<TreasuryBankReturnSummary> {
    this.assertMigrationWriter();
    assertBankReturnMigrationInput(input);
    return this.run(() => this.idempotency.execute(
      'treasury.bank_return.import_from_migration', key, input, async (session) => {
        const current = await this.requireBatch(input.batchId, session);
        const records = await this.instructions.find({
          tenantId: this.tenantId(), batchId: current.id,
        }).sort({ employeeId: 1 }).session(session).lean().exec();
        const controls = this.migrationReturnControls(input, records);
        const receivedAt = strictMigrationInstant(input.receivedAt);
        if (input.targetId !== null) {
          return this.verifyMigrationReplay(input, current, controls, receivedAt, session);
        }
        if (current.status !== 'submitted' || current.version !== input.expectedBatchVersion ||
          current.version !== 4 || current.returnHash !== null ||
          current.bankSubmissionId !== input.expectedBankSubmissionId ||
          current.migrationEvidenceRef === null ||
          current.strongAuthReferenceType !== 'migration_export_approval_evidence' ||
          current.purpose !== 'regular' || current.batchSequence !== 1 ||
          current.parentBatchId !== null || current.recoverySourceBatchId !== null ||
          controls.lineCount !== current.lineCount || controls.totalMinor !== current.totalMinor ||
          current.updatedAt.getTime() > receivedAt.getTime() ||
          records.some((record) => record.status !== 'submitted')) {
          throw new ConflictException({
            code: 'TREASURY_BANK_RETURN_MIGRATION_BATCH_INVALID',
            message: '银行回盘迁移只接受已迁移且尚未回盘的已提交常规批次',
          });
        }
        const returnId = createEventId(receivedAt);
        const manifestLines = controls.lines.map((line) => ({
          instructionId: line.record.id, outcome: 'succeeded' as const,
          amountMinor: line.amountMinor, bankLineReference: line.bankLineReference,
        }));
        const returnHash = migrationReturnHash({
          returnId, batchId: current.id, bankSubmissionId: input.expectedBankSubmissionId,
          receivedAt: input.receivedAt, lines: manifestLines,
        });
        const next = applyBankReturn(batchFromRecord(current), {
          tenantId: this.tenantId(), expectedVersion: input.expectedBatchVersion,
          returnHash, signatureVerified: true, fileProtectionPassed: true,
          successfulCount: controls.lineCount, failedCount: 0,
          unknownCount: 0, duplicateCount: 0, lineAmountMismatchCount: 0,
          successfulMinor: controls.totalMinor, failedMinor: 0,
        }, receivedAt);
        if (next.status !== 'reconciling') {
          throw new Error('TREASURY_BANK_RETURN_MIGRATION_DOMAIN_STATE_INVALID');
        }
        const protectedManifest = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'bank_return',
          resourceId: returnId, version: 1,
        }, migrationProtectedManifest(
          returnId, this.tenantId(), current.id, input.expectedBankSubmissionId,
          returnHash, manifestLines,
        ));
        const record = {
          id: returnId, tenantId: this.tenantId(), batchId: current.id,
          bankSubmissionId: input.expectedBankSubmissionId, sequence: 1, returnHash,
          objectEvidenceId: migrationEvidenceId('return-object', input.migrationEvidenceRef),
          objectRef: input.migrationEvidenceRef,
          signatureEvidenceId: migrationEvidenceId('return-signature', input.migrationEvidenceRef),
          signatureVerified: true,
          malwareScanEvidenceId: migrationEvidenceId('return-scan', input.migrationEvidenceRef),
          malwareClean: true, evidenceReferenceType: 'migration_return_evidence' as const,
          successfulCount: controls.lineCount, failedCount: 0, unknownCount: 0,
          duplicateCount: 0, lineAmountMismatchCount: 0,
          successfulMinor: controls.totalMinor, failedMinor: 0,
          outcome: 'accepted' as const, receivedAt,
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
          ...protectedRecord(protectedManifest), createdAt: receivedAt, updatedAt: receivedAt,
        };
        await this.returns.create([record], { session });
        const batchUpdate = await this.batches.updateOne({
          tenantId: this.tenantId(), id: current.id,
          status: 'submitted', version: input.expectedBatchVersion,
        }, { $set: {
          status: 'reconciling', version: next.version, returnHash,
          successfulCount: controls.lineCount, failedCount: 0,
          successfulMinor: controls.totalMinor, failedMinor: 0,
          freezeReason: null, updatedAt: receivedAt,
        } }, { session, runValidators: true, timestamps: false });
        if (batchUpdate.modifiedCount !== 1) throw new ConflictException({
          code: 'TREASURY_BANK_RETURN_MIGRATION_WRITE_CONFLICT',
          message: '银行回盘迁移批次发生并发冲突',
        });
        for (const line of controls.lines) {
          const updated = await this.instructions.updateOne({
            tenantId: this.tenantId(), batchId: current.id,
            id: line.record.id, status: 'submitted',
          }, { $set: {
            status: 'succeeded', bankLineReference: line.bankLineReference,
            updatedAt: receivedAt,
          } }, { session, runValidators: true, timestamps: false });
          if (updated.modifiedCount !== 1) throw new ConflictException({
            code: 'TREASURY_BANK_RETURN_MIGRATION_LINE_CONFLICT',
            message: '银行回盘迁移支付行发生并发冲突',
          });
        }
        await this.outbox.append({
          type: 'treasury.bank_return.migrated', tenantId: this.tenantId(),
          aggregateId: current.id, version: next.version, occurredAt: input.receivedAt,
          data: {
            returnHash, outcome: 'reconciling', successfulCount: controls.lineCount,
            successfulMinor: controls.totalMinor,
          },
        }, session);
        return Object.freeze({
          id: returnId, version: 1, batchId: current.id, status: 'reconciling' as const,
          batchVersion: next.version, returnHash,
          successfulCount: controls.lineCount, failedCount: 0, unknownCount: 0,
          duplicateCount: 0, lineAmountMismatchCount: 0,
          successfulMinor: controls.totalMinor, failedMinor: 0, freezeReason: null,
        });
      },
    ));
  }

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
      evidenceReferenceType: 'online_inbox',
      successfulCount: succeeded.length, failedCount: failed.length,
      unknownCount, duplicateCount, lineAmountMismatchCount, successfulMinor, failedMinor,
      outcome: next.status === 'reconciling' ? 'accepted' : 'frozen',
      receivedAt, migrationEvidenceRef: null, migrationEvidenceChecksum: null,
      ...protectedRecord(protectedManifest),
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
      if (current.purpose === 'supplement') {
        if (
          current.adjustmentSourceId === null ||
          current.adjustmentSourceHash === null ||
          succeeded.length !== 1 ||
          failed.length !== 0 ||
          successfulMinor !== current.totalMinor
        ) throw new ConflictException({
          code: 'TREASURY_ADJUSTMENT_RETURN_BINDING_INVALID',
          message: '补发子批次终态回盘与工资调整来源不一致',
        });
        await this.payrollAdjustments.recordSupplementBankReturn({
          adjustmentId: current.adjustmentSourceId,
          adjustmentHash: current.adjustmentSourceHash,
          batchId: current.id,
          returnId: manifest.returnId,
          successfulMinor,
        }, session);
      } else if (current.purpose === 'recovery') {
        const supplement = await this.findAdjustmentSupplementRoot(current, session);
        if (supplement !== null) {
          if (
            supplement.adjustmentSourceId === null ||
            supplement.adjustmentSourceHash === null ||
            current.lineCount !== 1 ||
            succeeded.length !== 1 ||
            failed.length !== 0 ||
            successfulMinor !== current.totalMinor ||
            successfulMinor !== supplement.totalMinor
          ) throw new ConflictException({
            code: 'TREASURY_ADJUSTMENT_RECOVERY_RETURN_BINDING_INVALID',
            message: '补发恢复子批次终态回盘与工资调整来源不一致',
          });
          await this.payrollAdjustments.recordSupplementBankReturn({
            adjustmentId: supplement.adjustmentSourceId,
            adjustmentHash: supplement.adjustmentSourceHash,
            batchId: current.id,
            returnId: manifest.returnId,
            successfulMinor,
          }, session);
        }
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
      id: manifest.returnId, version: manifest.sequence,
      batchId: current.id, status: next.status,
      batchVersion: next.version, returnHash: manifest.returnHash,
      successfulCount: succeeded.length, failedCount: failed.length,
      unknownCount, duplicateCount, lineAmountMismatchCount,
      successfulMinor, failedMinor, freezeReason: next.freezeReason,
    });
  }

  /** 沿恢复链向上解析唯一 supplement 根；普通工资恢复返回 null。 */
  private async findAdjustmentSupplementRoot(
    batch: TreasuryDisbursementBatchRecord,
    session: ClientSession,
  ): Promise<TreasuryDisbursementBatchRecord | null> {
    let sourceId = batch.recoverySourceBatchId;
    const seen = new Set([batch.id]);
    for (let depth = 0; depth < 16 && sourceId !== null; depth += 1) {
      if (seen.has(sourceId)) throw new ConflictException({
        code: 'TREASURY_RECOVERY_CHAIN_CYCLE_DETECTED',
        message: '恢复批次来源链存在循环引用',
      });
      seen.add(sourceId);
      const source = await this.batches.findOne({
        tenantId: this.tenantId(),
        id: sourceId,
      }).session(session).lean().exec();
      if (source === null) throw new ConflictException({
        code: 'TREASURY_RECOVERY_CHAIN_SOURCE_NOT_FOUND',
        message: '恢复批次来源链不完整',
      });
      if (source.purpose === 'supplement') return source;
      if (source.purpose === 'regular') return null;
      sourceId = source.recoverySourceBatchId;
    }
    if (sourceId !== null) throw new ConflictException({
      code: 'TREASURY_RECOVERY_CHAIN_DEPTH_EXCEEDED',
      message: '恢复批次来源链超过允许深度',
    });
    return null;
  }

  private migrationReturnControls(
    input: ImportTreasuryBankReturnFromMigrationInput,
    records: readonly TreasuryPaymentInstructionRecord[],
  ): MigrationReturnControls {
    if (records.length !== input.expectedLineCount ||
      new Set(records.map((record) => record.employeeId)).size !== records.length) {
      throw bankReturnMigrationImmutable();
    }
    const declared = new Map(input.lines.map((line) => [line.employeeId, line]));
    const lines = records.map((record) => {
      const expected = declared.get(record.employeeId);
      const data = instructionSchema.parse(this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'payment_instruction',
        resourceId: record.id, version: 1,
      }, protectedValue(record)));
      if (expected === undefined || data.instructionId !== record.id ||
        data.employeeId !== record.employeeId || data.bankAccountId !== record.bankAccountId ||
        data.payrollCalculationLineId !== record.payrollCalculationLineId ||
        data.amountMinor !== expected.expectedAmountMinor) {
        throw bankReturnMigrationImmutable();
      }
      return Object.freeze({
        record, amountMinor: data.amountMinor,
        bankLineReference: expected.bankLineReference,
      });
    });
    const total = lines.reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
    if (lines.length !== declared.size || total !== BigInt(input.expectedTotalMinor) ||
      total > BigInt(Number.MAX_SAFE_INTEGER)) throw bankReturnMigrationImmutable();
    return Object.freeze({ lines: Object.freeze(lines), lineCount: lines.length,
      totalMinor: Number(total) });
  }

  private async verifyMigrationReplay(
    input: ImportTreasuryBankReturnFromMigrationInput,
    batch: TreasuryDisbursementBatchRecord,
    controls: MigrationReturnControls,
    receivedAt: Date,
    session: ClientSession,
  ): Promise<TreasuryBankReturnSummary> {
    const record = await this.returns.findOne({
      tenantId: this.tenantId(), id: input.targetId, batchId: batch.id,
    }).session(session).lean().exec();
    if (record === null || batch.bankSubmissionId === null) {
      throw bankReturnMigrationImmutable();
    }
    const lines = controls.lines.map((line) => ({
      instructionId: line.record.id, outcome: 'succeeded' as const,
      amountMinor: line.amountMinor, bankLineReference: line.bankLineReference,
    }));
    const expectedHash = migrationReturnHash({
      returnId: record.id, batchId: batch.id,
      bankSubmissionId: input.expectedBankSubmissionId,
      receivedAt: input.receivedAt, lines,
    });
    const expectedManifest = migrationProtectedManifest(
      record.id, this.tenantId(), batch.id, input.expectedBankSubmissionId,
      expectedHash, lines,
    );
    const protectedManifest = this.crypto.unprotect({
      tenantId: this.tenantId(), resourceType: 'bank_return',
      resourceId: record.id, version: 1,
    }, protectedValue(record));
    if (JSON.stringify(protectedManifest) !== JSON.stringify(expectedManifest) ||
      batch.status !== 'reconciling' || batch.version !== input.expectedBatchVersion + 1 ||
      batch.bankSubmissionId !== input.expectedBankSubmissionId ||
      batch.migrationEvidenceRef === null ||
      batch.strongAuthReferenceType !== 'migration_export_approval_evidence' ||
      batch.purpose !== 'regular' || batch.batchSequence !== 1 ||
      batch.parentBatchId !== null || batch.recoverySourceBatchId !== null ||
      batch.lineCount !== controls.lineCount || batch.totalMinor !== controls.totalMinor ||
      batch.returnHash !== expectedHash || batch.successfulCount !== controls.lineCount ||
      batch.failedCount !== 0 || batch.successfulMinor !== controls.totalMinor ||
      batch.failedMinor !== 0 || batch.freezeReason !== null ||
      batch.updatedAt.toISOString() !== input.receivedAt ||
      record.bankSubmissionId !== input.expectedBankSubmissionId || record.sequence !== 1 ||
      record.returnHash !== expectedHash || record.objectRef !== input.migrationEvidenceRef ||
      record.objectEvidenceId !== migrationEvidenceId('return-object', input.migrationEvidenceRef) ||
      record.signatureEvidenceId !==
        migrationEvidenceId('return-signature', input.migrationEvidenceRef) ||
      record.malwareScanEvidenceId !==
        migrationEvidenceId('return-scan', input.migrationEvidenceRef) ||
      !record.signatureVerified || !record.malwareClean ||
      record.evidenceReferenceType !== 'migration_return_evidence' ||
      record.successfulCount !== controls.lineCount || record.failedCount !== 0 ||
      record.unknownCount !== 0 || record.duplicateCount !== 0 ||
      record.lineAmountMismatchCount !== 0 || record.successfulMinor !== controls.totalMinor ||
      record.failedMinor !== 0 || record.outcome !== 'accepted' ||
      record.receivedAt.toISOString() !== input.receivedAt ||
      record.migrationEvidenceRef !== input.migrationEvidenceRef ||
      record.migrationEvidenceChecksum !== input.evidenceChecksum ||
      record.createdAt.toISOString() !== receivedAt.toISOString() ||
      record.updatedAt.toISOString() !== receivedAt.toISOString() ||
      controls.lines.some((line) => line.record.status !== 'succeeded' ||
        line.record.bankLineReference !== line.bankLineReference ||
        line.record.updatedAt.toISOString() !== input.receivedAt)) {
      throw bankReturnMigrationImmutable();
    }
    return returnSummary(record, batch);
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

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:treasury:migration:write')) {
      throw new ForbiddenException({
        code: 'TREASURY_BANK_RETURN_MIGRATION_WRITER_DENIED',
        message: '银行回盘迁移必须由受信任服务身份执行',
      });
    }
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
    id: record.id, version: record.sequence, batchId: record.batchId,
    status: batch.status === 'reconciling' ? 'reconciling' : 'frozen',
    batchVersion: batch.version, returnHash: record.returnHash,
    successfulCount: record.successfulCount, failedCount: record.failedCount,
    unknownCount: record.unknownCount, duplicateCount: record.duplicateCount,
    lineAmountMismatchCount: record.lineAmountMismatchCount,
    successfulMinor: record.successfulMinor, failedMinor: record.failedMinor,
    freezeReason: batch.freezeReason,
  });
}

interface MigrationReturnControls {
  readonly lines: readonly {
    readonly record: TreasuryPaymentInstructionRecord;
    readonly amountMinor: number;
    readonly bankLineReference: string;
  }[];
  readonly lineCount: number;
  readonly totalMinor: number;
}

const MIGRATION_EVIDENCE_REF =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertBankReturnMigrationInput(
  input: ImportTreasuryBankReturnFromMigrationInput,
): void {
  if (Object.keys(input).sort().join(',') !==
      'batchId,evidenceChecksum,expectedBankSubmissionId,expectedBatchVersion,expectedLineCount,expectedTotalMinor,lines,malwareClean,migrationEvidenceRef,receivedAt,signatureVerified,targetId' ||
    (input.targetId !== null && !ID.test(input.targetId)) || !ID.test(input.batchId) ||
    !Number.isSafeInteger(input.expectedBatchVersion) || input.expectedBatchVersion !== 4 ||
    !ID.test(input.expectedBankSubmissionId) ||
    input.lines.length < 1 || input.lines.length > 5_000 ||
    !Number.isSafeInteger(input.expectedLineCount) ||
    input.expectedLineCount !== input.lines.length ||
    !Number.isSafeInteger(input.expectedTotalMinor) || input.expectedTotalMinor < 1 ||
    input.signatureVerified !== true || input.malwareClean !== true ||
    !MIGRATION_EVIDENCE_REF.test(input.migrationEvidenceRef) ||
    !HASH.test(input.evidenceChecksum)) throw bankReturnMigrationInputInvalid();
  strictMigrationInstant(input.receivedAt);
  for (const line of input.lines) {
    if (Object.keys(line).sort().join(',') !==
        'bankLineReference,employeeId,expectedAmountMinor' ||
      !ID.test(line.employeeId) || !ID.test(line.bankLineReference) ||
      !Number.isSafeInteger(line.expectedAmountMinor) || line.expectedAmountMinor < 1) {
      throw bankReturnMigrationInputInvalid();
    }
  }
  if (new Set(input.lines.map((line) => line.employeeId)).size !== input.lines.length ||
    new Set(input.lines.map((line) => line.bankLineReference)).size !== input.lines.length) {
    throw bankReturnMigrationInputInvalid();
  }
}

function strictMigrationInstant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value ||
    parsed.getTime() > Date.now() + 5 * 60_000) throw bankReturnMigrationInputInvalid();
  return parsed;
}

function migrationReturnHash(input: {
  readonly returnId: string;
  readonly batchId: string;
  readonly bankSubmissionId: string;
  readonly receivedAt: string;
  readonly lines: readonly TreasuryBankReturnManifest['lines'][number][];
}): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('base64url');
}

function migrationProtectedManifest(
  returnId: string,
  tenantId: string,
  batchId: string,
  bankSubmissionId: string,
  returnHash: string,
  lines: readonly TreasuryBankReturnManifest['lines'][number][],
) {
  return Object.freeze({
    returnId, tenantId, batchId, bankSubmissionId, sequence: 1, returnHash, lines,
  });
}

function migrationEvidenceId(kind: string, reference: string): string {
  return `migration-${kind}:${createHash('sha256').update(reference, 'utf8').digest('base64url')}`;
}

function bankReturnMigrationInputInvalid(): BadRequestException {
  return new BadRequestException({
    code: 'TREASURY_BANK_RETURN_MIGRATION_INPUT_INVALID',
    message: '银行回盘迁移控制信息非法',
  });
}

function bankReturnMigrationImmutable(): ConflictException {
  return new ConflictException({
    code: 'TREASURY_BANK_RETURN_MIGRATION_IMMUTABLE',
    message: '既有银行回盘、批次、支付指令或迁移证据不一致，禁止覆盖',
  });
}
