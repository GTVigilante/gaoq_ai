import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  PayrollReconciliationService,
  type PayrollReconciliationMigrationControl,
  type PayrollReconciliationSummary,
} from '../../payroll/application/payroll-reconciliation.service.js';
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import { TreasuryOutboxWriter } from '../persistence/treasury-outbox.writer.js';
import {
  TreasuryBankReturnRecord,
  type TreasuryBankReturnDocument,
  TreasuryDisbursementBatchRecord,
  type TreasuryDisbursementBatchDocument,
} from '../persistence/treasury.schemas.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface ImportFourWayReconciliationFromMigrationInput {
  readonly targetId: string | null;
  readonly batchId: string;
  readonly bankReturnId: string;
  readonly taxFilingId: string;
  readonly reconciledByEmployeeId: string;
  readonly expectedBatchVersion: number;
  readonly expectedPeriodVersion: number;
  readonly reconciledAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

@Injectable()
export class TreasuryReconciliationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly payroll: PayrollReconciliationService,
    private readonly outbox: TreasuryOutboxWriter,
    @InjectModel(TreasuryDisbursementBatchRecord.name)
    private readonly batches: Model<TreasuryDisbursementBatchDocument>,
    @InjectModel(TreasuryBankReturnRecord.name)
    private readonly returns: Model<TreasuryBankReturnDocument>,
    @Inject(AccessProfileRepository)
    private readonly profiles?: AccessProfileRepository,
  ) {}

  async importBalancedFromMigration(
    key: string,
    input: ImportFourWayReconciliationFromMigrationInput,
  ): Promise<PayrollReconciliationSummary> {
    this.assertMigrationWriter();
    assertReconciliationMigrationInput(input);
    return this.idempotency.execute(
      'treasury.reconciliation.import_from_migration', key, input, async (session) => {
        const profiles = this.profiles;
        if (profiles === undefined) throw new Error('四方对账迁移身份依赖未装配');
        const [batch, bankReturn, reconciledBy] = await Promise.all([
          this.requireBatch(input.batchId, session),
          this.returns.findOne({
            tenantId: this.tenantId(), id: input.bankReturnId, batchId: input.batchId,
          }).session(session).lean().exec(),
          profiles.findActorIdByEmployee(
            this.tenantId(), input.reconciledByEmployeeId, session,
          ),
        ]);
        const replay = input.targetId !== null;
        if (bankReturn === null || reconciledBy === null ||
          batch.migrationEvidenceRef === null || bankReturn.migrationEvidenceRef === null ||
          batch.purpose !== 'regular' || batch.batchSequence !== 1 ||
          batch.parentBatchId !== null || batch.recoverySourceBatchId !== null ||
          bankReturn.outcome !== 'accepted' || !bankReturn.signatureVerified ||
          !bankReturn.malwareClean || bankReturn.failedCount !== 0 ||
          bankReturn.unknownCount !== 0 || bankReturn.duplicateCount !== 0 ||
          bankReturn.lineAmountMismatchCount !== 0 ||
          bankReturn.evidenceReferenceType !== 'migration_return_evidence' ||
          reconciledBy === batch.preparedBy || reconciledBy === batch.payrollLockedBy ||
          reconciledBy === batch.exportApprovedBy ||
          (replay
            ? batch.status !== 'reconciled' || batch.version !== input.expectedBatchVersion + 1
            : batch.status !== 'reconciling' || batch.version !== input.expectedBatchVersion)) {
          throw new ConflictException({
            code: 'PAYROLL_RECONCILIATION_MIGRATION_REFERENCE_INVALID',
            message: '四方对账迁移批次、回盘、身份或职责分离控制非法',
          });
        }
        const reconciledAt = strictMigrationInstant(input.reconciledAt);
        if (bankReturn.receivedAt.getTime() > reconciledAt.getTime()) {
          throw new ConflictException({
            code: 'PAYROLL_RECONCILIATION_MIGRATION_TIME_INVALID',
            message: '四方对账完成时间早于银行回盘',
          });
        }
        const settlement = await this.settlementEvidence(batch, bankReturn, session);
        const migration: PayrollReconciliationMigrationControl = {
          targetId: input.targetId, expectedPeriodVersion: input.expectedPeriodVersion,
          expectedTaxFilingId: input.taxFilingId, reconciledAt: input.reconciledAt,
          migrationEvidenceRef: input.migrationEvidenceRef,
          evidenceChecksum: input.evidenceChecksum,
        };
        const reconciled = await this.payroll.reconcile({
          batchId: batch.id, payrollPeriodId: batch.payrollPeriodId,
          payrollRunId: batch.payrollRunId, payrollResultHash: batch.payrollResultHash,
          status: 'reconciling', version: input.expectedBatchVersion,
          lineCount: batch.lineCount, totalMinor: batch.totalMinor,
          settledLineCount: settlement.lineCount, settledMinor: settlement.totalMinor,
          settlementChainHash: settlement.chainHash, preparedBy: batch.preparedBy,
          exportEvidenceId: required(batch.objectEvidenceId),
          objectEvidenceId: required(batch.objectEvidenceId),
          bankSubmissionId: required(batch.bankSubmissionId),
          bankSubmissionEvidenceId: required(batch.bankSubmissionEvidenceId),
        }, {
          returnId: bankReturn.id, batchId: bankReturn.batchId,
          returnHash: bankReturn.returnHash, outcome: 'accepted',
          successfulCount: bankReturn.successfulCount,
          successfulMinor: bankReturn.successfulMinor,
          failedCount: bankReturn.failedCount, failedMinor: bankReturn.failedMinor,
          objectEvidenceId: bankReturn.objectEvidenceId,
          signatureEvidenceId: bankReturn.signatureEvidenceId,
          malwareScanEvidenceId: bankReturn.malwareScanEvidenceId,
        }, reconciledBy, session, migration);
        if (!reconciled.result.balanced || reconciled.summary.status !== 'balanced') {
          throw new ConflictException({
            code: 'PAYROLL_RECONCILIATION_MIGRATION_NOT_BALANCED',
            message: '历史四方对账重算不守恒',
          });
        }
        if (replay) return reconciled.summary;
        const updated = await this.batches.updateOne({
          tenantId: this.tenantId(), id: batch.id,
          status: 'reconciling', version: input.expectedBatchVersion,
        }, { $set: {
          status: 'reconciled', version: input.expectedBatchVersion + 1,
          freezeReason: null, updatedAt: reconciledAt,
        } }, { session, runValidators: true, timestamps: false });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_RECONCILIATION_MIGRATION_BATCH_CONFLICT',
          message: '四方对账迁移批次发生并发冲突',
        });
        await this.outbox.append({
          type: 'treasury.reconciliation.migrated', tenantId: this.tenantId(),
          aggregateId: batch.id, version: input.expectedBatchVersion + 1,
          occurredAt: input.reconciledAt, data: {
            payrollPeriodId: batch.payrollPeriodId, payrollRunId: batch.payrollRunId,
            reconciliationId: reconciled.summary.id,
            evidenceHash: reconciled.summary.evidenceHash, differenceCount: 0,
            status: 'reconciled',
          },
        }, session);
        return reconciled.summary;
      },
    );
  }

  async reconcile(
    key: string,
    batchId: string,
    expectedVersion: number,
  ): Promise<PayrollReconciliationSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:payroll:reconciliation:execute')) {
      throw new ForbiddenException({ code: 'AUTH_SCOPE_DENIED', message: '缺少四方对账执行权限' });
    }
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'PAYROLL_RECONCILIATION_SERVICE_REQUIRED',
        message: '只允许受信任对账服务执行四方对账',
      });
    }
    if (!ULID.test(batchId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new BadRequestException({
        code: 'PAYROLL_RECONCILIATION_INPUT_INVALID', message: '四方对账引用非法',
      });
    }
    return this.idempotency.execute(
      'treasury.reconciliation.execute', key, { batchId, expectedVersion },
      async (session) => {
        const batch = await this.requireBatch(batchId, session);
        if (
          (batch.status === 'reconciled' || batch.status === 'frozen') &&
          batch.version === expectedVersion + 1
        ) {
          const replay = await this.payroll.getForBatch(batch.id, session);
          if (replay !== null) return replay;
        }
        if (
          batch.status !== 'reconciling' || batch.version !== expectedVersion ||
          batch.objectEvidenceId === null || batch.bankSubmissionId === null ||
          batch.bankSubmissionEvidenceId === null || batch.returnHash === null ||
          batch.successfulCount === null || batch.successfulMinor === null ||
          batch.failedCount === null || batch.failedMinor === null
        ) throw new ConflictException({
          code: 'PAYROLL_RECONCILIATION_BATCH_NOT_READY',
          message: '代发批次未取得完整成功终态回盘或版本已变化',
        });
        const bankReturn = await this.returns.findOne({
          tenantId: this.tenantId(), batchId: batch.id, outcome: 'accepted',
        }).session(session).lean().exec();
        if (
          bankReturn === null || bankReturn.returnHash !== batch.returnHash ||
          bankReturn.bankSubmissionId !== batch.bankSubmissionId ||
          !bankReturn.signatureVerified || !bankReturn.malwareClean ||
          bankReturn.unknownCount !== 0 || bankReturn.duplicateCount !== 0 ||
          bankReturn.lineAmountMismatchCount !== 0
        ) throw new ConflictException({
          code: 'PAYROLL_RECONCILIATION_RETURN_NOT_TRUSTED',
          message: '银行终态回盘证据缺失、错位或不可信',
        });
        const settlement = await this.settlementEvidence(batch, bankReturn, session);
        const reconciled = await this.payroll.reconcile({
          batchId: batch.id, payrollPeriodId: batch.payrollPeriodId,
          payrollRunId: batch.payrollRunId, payrollResultHash: batch.payrollResultHash,
          status: 'reconciling', version: batch.version,
          lineCount: batch.lineCount, totalMinor: batch.totalMinor,
          settledLineCount: settlement.lineCount, settledMinor: settlement.totalMinor,
          settlementChainHash: settlement.chainHash,
          preparedBy: batch.preparedBy, exportEvidenceId: batch.objectEvidenceId,
          objectEvidenceId: batch.objectEvidenceId,
          bankSubmissionId: batch.bankSubmissionId,
          bankSubmissionEvidenceId: batch.bankSubmissionEvidenceId,
        }, {
          returnId: bankReturn.id, batchId: bankReturn.batchId,
          returnHash: bankReturn.returnHash, outcome: 'accepted',
          successfulCount: bankReturn.successfulCount,
          successfulMinor: bankReturn.successfulMinor,
          failedCount: bankReturn.failedCount, failedMinor: bankReturn.failedMinor,
          objectEvidenceId: bankReturn.objectEvidenceId,
          signatureEvidenceId: bankReturn.signatureEvidenceId,
          malwareScanEvidenceId: bankReturn.malwareScanEvidenceId,
        }, actor.actorId, session);
        const status = reconciled.result.balanced ? 'reconciled' : 'frozen';
        const updated = await this.batches.updateOne({
          tenantId: this.tenantId(), id: batch.id,
          status: 'reconciling', version: expectedVersion,
        }, { $set: {
          status, version: expectedVersion + 1,
          freezeReason: reconciled.result.balanced ? null : 'FOUR_WAY_MISMATCH',
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_RECONCILIATION_BATCH_WRITE_CONFLICT',
          message: '代发批次四方对账状态并发冲突',
        });
        await this.outbox.append({
          type: 'treasury.reconciliation.completed', tenantId: this.tenantId(),
          aggregateId: batch.id, version: expectedVersion + 1,
          occurredAt: new Date().toISOString(), data: {
            payrollPeriodId: batch.payrollPeriodId, payrollRunId: batch.payrollRunId,
            reconciliationId: reconciled.summary.id,
            evidenceHash: reconciled.summary.evidenceHash,
            differenceCount: reconciled.summary.differences.length, status,
          },
        }, session);
        return reconciled.summary;
      },
    );
  }

  private async settlementEvidence(
    terminal: TreasuryDisbursementBatchRecord,
    terminalReturn: TreasuryBankReturnRecord,
    session: ClientSession,
  ): Promise<{ readonly lineCount: number; readonly totalMinor: number; readonly chainHash: string }> {
    const entries: Record<string, string | number>[] = [];
    const seen = new Set<string>();
    let child = terminal;
    let currentReturn = terminalReturn;
    for (let depth = 0; depth < 32; depth += 1) {
      if (seen.has(child.id)) throw new ConflictException({
        code: 'PAYROLL_RECONCILIATION_CHAIN_CYCLE', message: '代发恢复结算链存在循环',
      });
      seen.add(child.id);
      if (
        child.successfulCount === null || child.successfulMinor === null ||
        child.failedCount === null || child.failedMinor === null || child.returnHash === null ||
        child.objectEvidenceId === null || child.bankSubmissionId === null ||
        child.bankSubmissionEvidenceId === null ||
        currentReturn.returnHash !== child.returnHash || !currentReturn.signatureVerified ||
        currentReturn.batchId !== child.id ||
        currentReturn.bankSubmissionId !== child.bankSubmissionId ||
        !currentReturn.malwareClean || currentReturn.unknownCount !== 0 ||
        currentReturn.duplicateCount !== 0 || currentReturn.lineAmountMismatchCount !== 0
        || !returnControlsMatch(child, currentReturn)
      ) throw new ConflictException({
        code: 'PAYROLL_RECONCILIATION_CHAIN_EVIDENCE_INVALID',
        message: '代发恢复结算链证据不完整或不可信',
      });
      entries.push({
        batchId: child.id, purpose: child.purpose, returnId: currentReturn.id,
        returnHash: currentReturn.returnHash, lineCount: child.lineCount,
        totalMinor: child.totalMinor, successfulCount: currentReturn.successfulCount,
        successfulMinor: currentReturn.successfulMinor,
        failedCount: currentReturn.failedCount, failedMinor: currentReturn.failedMinor,
        objectEvidenceId: child.objectEvidenceId,
        bankSubmissionId: child.bankSubmissionId,
        bankSubmissionEvidenceId: child.bankSubmissionEvidenceId,
        bankReturnObjectEvidenceId: currentReturn.objectEvidenceId,
        signatureEvidenceId: currentReturn.signatureEvidenceId,
        malwareScanEvidenceId: currentReturn.malwareScanEvidenceId,
      });
      const sourceId = child.recoverySourceBatchId ?? null;
      if (sourceId === null) {
        if (child.purpose !== 'regular') throw new ConflictException({
          code: 'PAYROLL_RECONCILIATION_CHAIN_ROOT_INVALID',
          message: '代发恢复结算链根批次不是常规工资批次',
        });
        const lineCount = safeAggregate(entries.map((entry) => Number(entry['successfulCount'])));
        const totalMinor = safeAggregate(entries.map((entry) => Number(entry['successfulMinor'])));
        return Object.freeze({
          lineCount, totalMinor,
          chainHash: createHash('sha256')
            .update(JSON.stringify([...entries].reverse()), 'utf8').digest('base64url'),
        });
      }
      const parent = await this.requireBatch(sourceId, session);
      if (
        parent.status !== 'frozen' || parent.freezeReason !== 'PARTIAL_SUCCESS' ||
        parent.payrollPeriodId !== terminal.payrollPeriodId ||
        parent.payrollRunId !== terminal.payrollRunId ||
        parent.payrollResultHash !== terminal.payrollResultHash ||
        parent.failedCount !== child.lineCount || parent.failedMinor !== child.totalMinor
      ) throw new ConflictException({
        code: 'PAYROLL_RECONCILIATION_CHAIN_BINDING_INVALID',
        message: '恢复子批次与父批次失败集合未守恒',
      });
      const parentReturn = await this.returns.findOne({
        tenantId: this.tenantId(), batchId: parent.id, outcome: 'frozen',
      }).session(session).lean().exec();
      if (parentReturn === null) throw new ConflictException({
        code: 'PAYROLL_RECONCILIATION_CHAIN_RETURN_MISSING',
        message: '恢复链父批次终态回盘不存在',
      });
      child = parent;
      currentReturn = parentReturn;
    }
    throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_CHAIN_TOO_DEEP', message: '代发恢复结算链超过安全深度',
    });
  }

  private async requireBatch(
    id: string,
    session: ClientSession,
  ): Promise<TreasuryDisbursementBatchRecord> {
    const batch = await this.batches.findOne({
      tenantId: this.tenantId(), id,
    }).session(session).lean().exec();
    if (batch === null) throw new NotFoundException({
      code: 'TREASURY_BATCH_NOT_FOUND', message: '代发批次不存在',
    });
    return batch;
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

function safeAggregate(values: readonly number[]): number {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ConflictException({
      code: 'PAYROLL_RECONCILIATION_CHAIN_TOTAL_INVALID', message: '代发恢复结算链控制量非法',
    });
  }
  const result = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (result < 1n || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConflictException({
    code: 'PAYROLL_RECONCILIATION_CHAIN_TOTAL_INVALID', message: '代发恢复结算链控制量非法',
  });
  return Number(result);
}

function returnControlsMatch(
  batch: TreasuryDisbursementBatchRecord,
  bankReturn: TreasuryBankReturnRecord,
): boolean {
  const controls = [
    batch.lineCount, batch.totalMinor, bankReturn.successfulCount, bankReturn.failedCount,
    bankReturn.successfulMinor, bankReturn.failedMinor,
  ];
  if (controls.some((value) => !Number.isSafeInteger(value) || value < 0)) return false;
  return bankReturn.successfulCount + bankReturn.failedCount === batch.lineCount &&
    BigInt(bankReturn.successfulMinor) + BigInt(bankReturn.failedMinor) === BigInt(batch.totalMinor);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const MIGRATION_EVIDENCE_REF =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertReconciliationMigrationInput(
  input: ImportFourWayReconciliationFromMigrationInput,
): void {
  if (Object.keys(input).sort().join(',') !==
      'bankReturnId,batchId,evidenceChecksum,expectedBatchVersion,expectedPeriodVersion,migrationEvidenceRef,reconciledAt,reconciledByEmployeeId,targetId,taxFilingId' ||
    (input.targetId !== null && !ULID.test(input.targetId)) || !ULID.test(input.batchId) ||
    !ULID.test(input.bankReturnId) || !ULID.test(input.taxFilingId) ||
    !ID.test(input.reconciledByEmployeeId) || input.expectedBatchVersion !== 5 ||
    input.expectedPeriodVersion !== 6 || !MIGRATION_EVIDENCE_REF.test(input.migrationEvidenceRef) ||
    !HASH.test(input.evidenceChecksum)) {
    throw new BadRequestException({
      code: 'PAYROLL_RECONCILIATION_MIGRATION_INPUT_INVALID',
      message: '四方对账迁移控制信息非法',
    });
  }
  strictMigrationInstant(input.reconciledAt);
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

function required<T>(value: T | null): T {
  if (value === null) throw new ConflictException({
    code: 'PAYROLL_RECONCILIATION_MIGRATION_EVIDENCE_MISSING',
    message: '四方对账迁移所需资金证据缺失',
  });
  return value;
}
