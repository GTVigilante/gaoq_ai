import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  PayrollReconciliationService,
  type PayrollReconciliationSummary,
} from '../../payroll/application/payroll-reconciliation.service.js';
import { TreasuryOutboxWriter } from '../persistence/treasury-outbox.writer.js';
import {
  TreasuryBankReturnRecord,
  type TreasuryBankReturnDocument,
  TreasuryDisbursementBatchRecord,
  type TreasuryDisbursementBatchDocument,
} from '../persistence/treasury.schemas.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

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
  ) {}

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
