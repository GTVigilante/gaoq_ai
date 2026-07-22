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
import { ConfigService } from '@nestjs/config';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { AppEnvironment } from '../../../config/environment.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { WebAuthnService } from '../../identity/strong-auth/webauthn.service.js';
import {
  PayrollRunService,
  type LockedPayrollDisbursementSource,
} from '../../payroll/application/payroll-run.service.js';
import { payrollDigest } from '../../payroll/domain/index.js';
import {
  approveDisbursementExport,
  type DisbursementBatch,
  DisbursementBatchError,
  generatePain001,
  Pain001Error,
  recordBankSubmission,
} from '../domain/index.js';
import { TreasuryBankSubmissionGateway } from '../integration/treasury-bank-submission.ports.js';
import { TreasuryImmutableArchive } from '../integration/treasury-evidence.ports.js';
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
import type {
  ApproveTreasuryExportDto,
  PrepareTreasuryDisbursementDto,
  SubmitTreasuryDisbursementDto,
} from './treasury.dto.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bankAccountDataSchema = z.object({
  accountName: z.string().min(1).max(140),
  account: z.string().regex(/^[0-9]{8,32}$/),
  clearingCode: z.string().regex(/^[0-9A-Z]{8,12}$/),
  currency: z.literal('CNY'),
}).strict();
type BankAccountData = z.infer<typeof bankAccountDataSchema>;
const batchSnapshotSchema = z.object({
  messageId: z.string().regex(ID_PATTERN),
  paymentInformationId: z.string().regex(ID_PATTERN),
  creationDateTime: z.iso.datetime({ offset: true }),
  requestedExecutionDate: z.string().regex(DATE_PATTERN),
  debtorBankAccountId: z.string().regex(ID_PATTERN),
  debtorName: z.string().min(1).max(140),
  debtorAccount: z.string().regex(/^[0-9]{8,32}$/),
  debtorAgentClearingCode: z.string().regex(/^[0-9A-Z]{8,12}$/),
  payrollResultHash: z.string().regex(HASH_PATTERN),
  payableResultHash: z.string().regex(HASH_PATTERN),
}).strict();
const instructionDataSchema = z.object({
  instructionId: z.string().regex(ID_PATTERN),
  employeeId: z.string().regex(ID_PATTERN),
  bankAccountId: z.string().regex(ID_PATTERN),
  payrollCalculationLineId: z.string().regex(ID_PATTERN),
  payrollResultHash: z.string().regex(HASH_PATTERN),
  creditorName: z.string().min(1).max(140),
  creditorAccount: z.string().regex(/^[0-9]{8,32}$/),
  creditorAgentClearingCode: z.string().regex(/^[0-9A-Z]{8,12}$/),
  amountMinor: z.number().int().safe().positive(),
  purposeCode: z.literal('PAYROLL'),
}).strict();

export interface TreasuryDisbursementSummary extends Record<string, unknown> {
  readonly id: string;
  readonly payrollPeriodId: string;
  readonly payrollRunId: string;
  readonly status: 'materializing' | 'prepared' | 'exported' | 'submitting' | 'submitted';
  readonly version: number;
  readonly lineCount: number;
  readonly totalMinor: number;
  readonly fileHash: string | null;
  readonly objectEvidenceId: string | null;
  readonly bankSubmissionId: string | null;
  readonly bankSubmissionEvidenceId: string | null;
}

export interface ImportTreasuryDisbursementLineFromMigration {
  readonly employeeId: string;
  readonly bankAccountId: string;
  readonly expectedNetPayMinor: number;
}

export interface ImportTreasuryDisbursementFromMigrationInput {
  readonly targetId: string | null;
  readonly payrollPeriodId: string;
  readonly payrollRunId: string;
  readonly expectedPayrollVersion: number;
  readonly debtorBankAccountId: string;
  readonly preparedByEmployeeId: string;
  readonly exportApprovedByEmployeeId: string;
  readonly approvalHistoryId: string;
  readonly approvalEvidenceChecksum: string;
  readonly requestedExecutionDate: string;
  readonly lines: readonly ImportTreasuryDisbursementLineFromMigration[];
  readonly expectedLineCount: number;
  readonly expectedTotalMinor: number;
  readonly bankSubmissionId: string;
  readonly bankSubmissionEvidenceId: string;
  readonly preparedAt: string;
  readonly submittedAt: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

/** 锁定工资到受控代发文件的两阶段编排；不返回文件、账号或员工级金额。 */
@Injectable()
export class TreasuryDisbursementService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly payroll: PayrollRunService,
    private readonly strongAuth: WebAuthnService,
    private readonly crypto: TreasuryDataCryptoService,
    private readonly archive: TreasuryImmutableArchive,
    private readonly bankGateway: TreasuryBankSubmissionGateway,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly outbox: TreasuryOutboxWriter,
    @InjectModel(TreasuryBankAccountRecord.name)
    private readonly accounts: Model<TreasuryBankAccountDocument>,
    @InjectModel(TreasuryPaymentInstructionRecord.name)
    private readonly instructions: Model<TreasuryPaymentInstructionDocument>,
    @InjectModel(TreasuryDisbursementBatchRecord.name)
    private readonly batches: Model<TreasuryDisbursementBatchDocument>,
    @Inject(AccessProfileRepository)
    private readonly profiles?: AccessProfileRepository,
    @Inject(ApprovalApplicationService)
    private readonly approvals?: ApprovalApplicationService,
  ) {}

  /** 迁移专用：重建确定性代发文件并恢复银行提交回执，不调用 WORM 或银行网关。 */
  async importSubmittedFromMigration(
    key: string,
    input: ImportTreasuryDisbursementFromMigrationInput,
  ): Promise<TreasuryDisbursementSummary> {
    this.assertMigrationWriter();
    assertDisbursementMigrationInput(input);
    const profiles = this.profiles;
    const approvals = this.approvals;
    if (profiles === undefined || approvals === undefined) {
      throw new Error('代发迁移身份或审批依赖未装配');
    }
    const source = await this.payroll.getLockedDisbursementSourceForMigration(
      input.payrollPeriodId, input.expectedPayrollVersion,
    );
    return this.run(() => this.idempotency.execute(
      'treasury.disbursement.import_from_migration', key, input, async (session) => {
        const [preparedBy, exportApprovedBy, approval, debtor, creditorRecords] =
          await Promise.all([
            profiles.findActorIdByEmployee(
              this.tenantId(), input.preparedByEmployeeId, session,
            ),
            profiles.findActorIdByEmployee(
              this.tenantId(), input.exportApprovedByEmployeeId, session,
            ),
            approvals.verifyTreasuryMigrationReference(
              input.approvalHistoryId, 'treasury_disbursement_export_approval', session,
            ),
            this.accounts.findOne({
              tenantId: this.tenantId(), id: input.debtorBankAccountId,
              ownerType: 'organization', ownerId: this.tenantId(),
            }).session(session).lean().exec(),
            this.accounts.find({
              tenantId: this.tenantId(), id: { $in: input.lines.map((line) => line.bankAccountId) },
              ownerType: 'employee',
            }).session(session).lean().exec(),
          ]);
        if (preparedBy === null || exportApprovedBy === null || debtor === null) {
          throw new NotFoundException({
            code: 'TREASURY_DISBURSEMENT_MIGRATION_REFERENCE_NOT_FOUND',
            message: '代发迁移制备人、批准人或付款账户不存在',
          });
        }
        const preparedAt = strictMigrationInstant(input.preparedAt);
        const submittedAt = strictMigrationInstant(input.submittedAt);
        const approvedAt = strictMigrationInstant(approval.completedAt);
        if (approval.evidenceChecksum !== input.approvalEvidenceChecksum ||
          source.payrollRunId !== input.payrollRunId ||
          preparedBy === source.payrollLockedBy || exportApprovedBy === preparedBy ||
          exportApprovedBy === source.payrollLockedBy ||
          preparedAt.getTime() < Date.parse(source.lockedAt) ||
          approvedAt.getTime() < preparedAt.getTime() ||
          submittedAt.getTime() < approvedAt.getTime()) {
          throw new ConflictException({
            code: 'TREASURY_DISBURSEMENT_MIGRATION_CONTROL_INVALID',
            message: '代发迁移工资绑定、审批证据、职责分离或时间线非法',
          });
        }
        const creditors = this.migrationCreditorAccounts(
          input, creditorRecords, preparedAt,
        );
        this.assertMigrationAccountAvailable(debtor, preparedAt);
        const controls = migrationPayableControls(source, input, creditors);
        if (input.targetId !== null) return this.verifyMigrationReplay(
          input, source, controls, debtor, creditors, preparedBy,
          exportApprovedBy, preparedAt, submittedAt, session,
        );
        const batchId = createEventId(preparedAt);
        const header = migrationBatchHeader(batchId, input, source, debtor, this.accountData(debtor));
        const protectedBatch = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'batch_snapshot',
          resourceId: batchId, version: 1,
        }, header);
        const instructionRecords = controls.lines.map((line) => {
          const account = creditors.get(line.employeeId);
          if (account === undefined) throw new Error('TREASURY_MIGRATION_ACCOUNT_MISSING');
          const id = createEventId(preparedAt);
          const data = migrationInstructionData(id, line, account.record.id, account.data);
          return {
            record: {
              id, tenantId: this.tenantId(), batchId,
              payrollCalculationLineId: line.calculationLineId,
              employeeId: line.employeeId, bankAccountId: account.record.id,
              status: 'submitted' as const, bankLineReference: null,
              ...protectedRecord(this.crypto.protect({
                tenantId: this.tenantId(), resourceType: 'payment_instruction',
                resourceId: id, version: 1,
              }, data)),
              createdAt: preparedAt, updatedAt: submittedAt,
            },
            fileLine: {
              instructionId: id, creditorName: data.creditorName,
              creditorAccount: data.creditorAccount,
              creditorAgentClearingCode: data.creditorAgentClearingCode,
              amountMinor: data.amountMinor, purposeCode: data.purposeCode,
            },
          };
        });
        const document = generatePain001({
          messageId: header.messageId, paymentInformationId: header.paymentInformationId,
          creationDateTime: header.creationDateTime,
          requestedExecutionDate: header.requestedExecutionDate,
          debtorName: header.debtorName, debtorAccount: header.debtorAccount,
          debtorAgentClearingCode: header.debtorAgentClearingCode,
          currency: 'CNY', lines: instructionRecords.map((item) => item.fileLine),
        });
        if (document.lineCount !== controls.lineCount ||
          document.controlSumMinor !== controls.totalMinor) {
          throw new ConflictException({
            code: 'TREASURY_DISBURSEMENT_MIGRATION_FILE_CONTROL_MISMATCH',
            message: '目标重建代发文件控制量不一致',
          });
        }
        const evidenceId = migrationEvidenceId('batch', input.migrationEvidenceRef);
        const batch = {
          id: batchId, tenantId: this.tenantId(), payrollPeriodId: source.periodId,
          payrollRunId: source.payrollRunId, payrollResultHash: source.resultHash,
          payableResultHash: controls.payableResultHash, batchSequence: 1,
          parentBatchId: null, recoverySourceBatchId: null, purpose: 'regular' as const,
          format: 'ISO20022_PAIN_001_001_03' as const, fileHash: document.contentHash,
          lineCount: controls.lineCount, totalMinor: controls.totalMinor,
          preparedBy, payrollLockedBy: source.payrollLockedBy, exportApprovedBy,
          strongAuthEvidenceId: approval.id,
          strongAuthReferenceType: 'migration_export_approval_evidence' as const,
          recoveryApprovedBy: null, recoveryStrongAuthEvidenceId: null, recoveryReturnId: null,
          objectEvidenceId: evidenceId, objectRef: input.migrationEvidenceRef,
          bankSubmissionId: input.bankSubmissionId,
          bankSubmissionEvidenceId: input.bankSubmissionEvidenceId,
          returnHash: null, successfulCount: null, failedCount: null,
          successfulMinor: null, failedMinor: null, freezeReason: null,
          status: 'submitted' as const, version: 4,
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
          ...protectedRecord(protectedBatch), createdAt: preparedAt, updatedAt: submittedAt,
        };
        await this.batches.create([batch], { session });
        await this.instructions.create(instructionRecords.map((item) => item.record), { session });
        await this.outbox.append({
          type: 'treasury.disbursement.migrated', tenantId: this.tenantId(),
          aggregateId: batchId, version: 4, occurredAt: input.submittedAt,
          data: migrationBatchEventData(batch),
        }, session);
        return summaryFromRecord(batch, 'submitted');
      },
    ));
  }

  async submit(
    key: string,
    batchId: string,
    input: SubmitTreasuryDisbursementDto,
  ): Promise<TreasuryDisbursementSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:treasury:disbursement:submit')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少代发银行提交权限',
    });
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'TREASURY_BANK_SUBMISSION_SERVICE_REQUIRED', message: '只允许受信任银行提交服务执行',
      });
    }
    if (!ID_PATTERN.test(batchId)) throw new BadRequestException({
      code: 'TREASURY_BATCH_ID_INVALID', message: '代发批次标识非法',
    });
    if (this.config.get('TREASURY_BANK_SUBMISSION_MODE', { infer: true }) === 'production') {
      throw new ConflictException({
        code: 'TREASURY_PRODUCTION_CUTOVER_NOT_AUTHORIZED',
        message: 'Phase 6 总体 Go/No-Go 与生产切换授权尚未落地，真实银行提交失败关闭',
      });
    }
    const staged = await this.run(() => this.idempotency.execute(
      'treasury.disbursement.stage_submission', key,
      { batchId, expectedVersion: input.expectedVersion }, async (session) => {
        const exported = await this.requireBatch(batchId, session);
        if (
          exported.status === 'submitted' && exported.version === input.expectedVersion + 1 &&
          exported.bankSubmissionId !== null && exported.bankSubmissionEvidenceId !== null
        ) return summaryFromRecord(exported, 'submitted');
        if (
          exported.status === 'submitting' && exported.version === input.expectedVersion &&
          exported.fileHash !== null && exported.objectRef !== null
        ) return summaryFromRecord(exported, 'submitting');
        if (
          exported.status !== 'exported' || exported.version !== input.expectedVersion ||
          exported.fileHash === null || exported.objectRef === null ||
          exported.objectEvidenceId === null || exported.strongAuthEvidenceId === null ||
          exported.exportApprovedBy === null
        ) throw new ConflictException({
          code: 'TREASURY_BANK_SUBMISSION_STATE_INVALID',
          message: '代发批次未完成有效导出批准或版本已变化',
        });
        const updated = await this.batches.updateOne({
          tenantId: this.tenantId(), id: exported.id,
          status: 'exported', version: input.expectedVersion,
        }, { $set: { status: 'submitting' } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'TREASURY_BANK_SUBMISSION_STAGE_CONFLICT', message: '代发提交暂存发生并发冲突',
        });
        await this.outbox.append({
          type: 'treasury.disbursement.submission_requested', tenantId: this.tenantId(),
          aggregateId: exported.id, version: exported.version,
          occurredAt: new Date().toISOString(), data: {
            payrollPeriodId: exported.payrollPeriodId, payrollRunId: exported.payrollRunId,
            lineCount: exported.lineCount, totalMinor: exported.totalMinor,
            fileHash: exported.fileHash, status: 'submitting',
          },
        }, session);
        return summaryFromRecord(exported, 'submitting');
      },
    ));
    const exported = await this.requireBatch(staged.id);
    if (
      exported.status === 'submitted' && exported.bankSubmissionId !== null &&
      exported.bankSubmissionEvidenceId !== null
    ) return summaryFromRecord(exported, 'submitted');
    if (
      exported.status !== 'submitting' || exported.version !== input.expectedVersion ||
      exported.fileHash === null || exported.objectRef === null
    ) throw new ConflictException({
      code: 'TREASURY_BANK_SUBMISSION_STAGE_INVALID', message: '代发提交暂存状态非法',
    });
    const receipt = await this.bankGateway.submit({
      tenantId: this.tenantId(), batchId: exported.id, objectRef: exported.objectRef,
      fileHash: exported.fileHash, lineCount: exported.lineCount, totalMinor: exported.totalMinor,
    });
    return this.run(() => this.idempotency.execute(
      'treasury.disbursement.finalize_submission', deriveKey(key, 'finalize-submission'), {
        batchId, expectedVersion: input.expectedVersion,
        submissionId: receipt.submissionId, evidenceId: receipt.evidenceId,
      }, async (session) => {
        const current = await this.requireBatch(batchId, session);
        const next = recordBankSubmission(batchFromRecord(current, true), {
          tenantId: this.tenantId(), expectedVersion: input.expectedVersion,
          bankSubmissionId: receipt.submissionId,
          bankSubmissionEvidenceId: receipt.evidenceId, trustedConnector: receipt.accepted,
        }, new Date());
        const updated = await this.batches.updateOne({
          tenantId: this.tenantId(), id: current.id,
          status: current.status, version: current.version,
        }, { $set: {
          status: next.status, version: next.version,
          bankSubmissionId: next.bankSubmissionId,
          bankSubmissionEvidenceId: next.bankSubmissionEvidenceId,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'TREASURY_BANK_SUBMISSION_WRITE_CONFLICT', message: '代发提交发生并发冲突',
        });
        const instructionUpdate = await this.instructions.updateMany({
          tenantId: this.tenantId(), batchId: current.id, status: 'prepared',
        }, { $set: { status: 'submitted' } }, { session, runValidators: true });
        if (instructionUpdate.modifiedCount !== current.lineCount) throw new ConflictException({
          code: 'TREASURY_SUBMISSION_INSTRUCTION_WRITE_CONFLICT', message: '支付指令提交状态更新不完整',
        });
        await this.outbox.append({
          type: 'treasury.disbursement.submitted', tenantId: this.tenantId(),
          aggregateId: next.id, version: next.version, occurredAt: next.updatedAt, data: {
            payrollPeriodId: next.payrollPeriodId, payrollRunId: next.payrollRunId,
            lineCount: next.lineCount, totalMinor: next.totalMinor, fileHash: next.fileHash,
            bankSubmissionId: receipt.submissionId,
            bankSubmissionEvidenceId: receipt.evidenceId, status: 'submitted',
          },
        }, session);
        return summaryFromDomain(next);
      },
    ));
  }

  async approveExport(
    key: string,
    batchId: string,
    input: ApproveTreasuryExportDto,
    token: VerifiedAccessToken,
  ): Promise<TreasuryDisbursementSummary> {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:treasury:disbursement:approve')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少代发导出批准权限',
    });
    if (
      actor.actorType !== 'user' || token.actorType !== 'user' ||
      token.tenantId !== this.tenantId() || token.actorId !== actor.actorId
    ) throw new ForbiddenException({
      code: 'TREASURY_EXPORT_APPROVER_IDENTITY_INVALID', message: '代发导出批准身份上下文非法',
    });
    if (!ID_PATTERN.test(batchId)) throw new BadRequestException({
      code: 'TREASURY_BATCH_ID_INVALID', message: '代发批次标识非法',
    });
    const evidence = await this.strongAuth.requireVerifiedEvidence({
      evidenceId: input.strongAuthEvidenceId, tenantId: token.tenantId,
      actorId: token.actorId, sessionId: token.sessionId, operationId: batchId,
    });
    return this.run(() => this.idempotency.execute(
      'treasury.disbursement.approve_export', key,
      { batchId, expectedVersion: input.expectedVersion, evidenceId: evidence.evidenceId },
      async (session) => {
        const current = await this.requireBatch(batchId, session);
        if (
          current.status === 'materializing' ||
          current.fileHash === null || current.objectEvidenceId === null || current.objectRef === null
        ) throw new ConflictException({
          code: 'TREASURY_EXPORT_EVIDENCE_INCOMPLETE', message: '代发文件不可变证据不完整',
        });
        const now = new Date();
        const next = approveDisbursementExport(batchFromRecord(current), {
          tenantId: this.tenantId(), expectedVersion: input.expectedVersion,
          approvedBy: actor.actorId, strongAuthEvidenceId: evidence.evidenceId,
          objectEvidenceId: current.objectEvidenceId,
        }, now);
        const updated = await this.batches.updateOne({
          tenantId: this.tenantId(), id: current.id,
          status: current.status, version: current.version,
        }, { $set: {
          status: next.status, version: next.version,
          exportApprovedBy: next.exportApprovedBy,
          strongAuthEvidenceId: next.strongAuthEvidenceId,
          strongAuthReferenceType: 'webauthn_evidence',
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'TREASURY_EXPORT_APPROVAL_WRITE_CONFLICT', message: '代发导出批准发生并发冲突',
        });
        await this.outbox.append({
          type: 'treasury.disbursement.export_approved', tenantId: this.tenantId(),
          aggregateId: next.id, version: next.version, occurredAt: next.updatedAt, data: {
            payrollPeriodId: next.payrollPeriodId, payrollRunId: next.payrollRunId,
            lineCount: next.lineCount, totalMinor: next.totalMinor,
            fileHash: next.fileHash, objectEvidenceId: current.objectEvidenceId,
            status: 'exported', strongAuthMethod: evidence.method,
          },
        }, session);
        return summaryFromDomain(next);
      },
    ));
  }

  async prepare(
    key: string,
    input: PrepareTreasuryDisbursementDto,
  ): Promise<TreasuryDisbursementSummary> {
    this.assertHumanPreparer();
    if (!isCalendarDate(input.requestedExecutionDate)) throw new BadRequestException({
      code: 'TREASURY_EXECUTION_DATE_INVALID', message: '代发执行日期非法',
    });
    const source = await this.payroll.getLockedDisbursementSource(
      input.payrollPeriodId, input.expectedPayrollVersion,
    );
    const actor = this.context.getActorRequired();
    if (actor.actorId === source.payrollLockedBy) throw new ForbiddenException({
      code: 'TREASURY_DUAL_CONTROL_REQUIRED', message: '代发制备人不得是工资锁定人',
    });
    const staged = await this.run(() => this.idempotency.execute(
      'treasury.disbursement.prepare', key, {
        ...input, payrollRunId: source.payrollRunId, payrollResultHash: source.resultHash,
      }, async (session) => this.stage(source, input, actor.actorId, session),
    ));
    return this.materializeStaged(deriveKey(key, 'materialize'), staged.id);
  }

  private async stage(
    source: LockedPayrollDisbursementSource,
    input: PrepareTreasuryDisbursementDto,
    preparedBy: string,
    session: ClientSession,
  ): Promise<TreasuryDisbursementSummary> {
    const payable = source.lines.filter((line) => line.netPayMinor > 0);
    if (payable.length < 1 || payable.length > 5_000) throw new ConflictException({
      code: 'TREASURY_PAYABLE_LINES_INVALID', message: '锁定工资没有可代发员工或超出单批上限',
    });
    const employeeIds = payable.map((line) => line.employeeId);
    const [debtorRecord, creditorRecords] = await Promise.all([
      this.accounts.findOne({
        tenantId: this.tenantId(), id: input.debtorBankAccountId,
        ownerType: 'organization', ownerId: this.tenantId(), status: 'active',
      }).session(session).lean().exec(),
      this.accounts.find({
        tenantId: this.tenantId(), ownerType: 'employee',
        ownerId: { $in: employeeIds }, status: 'active',
      }).session(session).lean().exec(),
    ]);
    if (debtorRecord === null) throw new NotFoundException({
      code: 'TREASURY_DEBTOR_ACCOUNT_NOT_FOUND', message: '组织付款账户不存在或非活动版本',
    });
    if (
      creditorRecords.length !== employeeIds.length ||
      new Set(creditorRecords.map((record) => record.ownerId)).size !== employeeIds.length
    ) throw new ConflictException({
      code: 'TREASURY_EMPLOYEE_ACCOUNT_INCOMPLETE', message: '可代发员工的活动银行账户不完整',
    });
    const debtor = this.accountData(debtorRecord);
    const creditors = new Map(creditorRecords.map((record) => [
      record.ownerId, { record, data: this.accountData(record) },
    ]));
    const total = payable.reduce((sum, line) => sum + BigInt(line.netPayMinor), 0n);
    if (total !== BigInt(source.totalNetMinor) || total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConflictException({
        code: 'TREASURY_PAYROLL_TOTAL_MISMATCH', message: '锁定工资实发总额与代发行不一致',
      });
    }
    const now = new Date();
    if (!isExecutionWindow(input.requestedExecutionDate, now)) throw new BadRequestException({
      code: 'TREASURY_EXECUTION_DATE_OUT_OF_RANGE', message: '代发执行日期必须在未来九十天内',
    });
    const batchId = createEventId(now);
    const payableResultHash = payrollDigest(payable.map((line) => ({
      employeeId: line.employeeId, resultHash: line.resultHash,
    })));
    const snapshot = Object.freeze({
      messageId: batchId, paymentInformationId: batchId,
      creationDateTime: now.toISOString(), requestedExecutionDate: input.requestedExecutionDate,
      debtorBankAccountId: debtorRecord.id, debtorName: debtor.accountName,
      debtorAccount: debtor.account, debtorAgentClearingCode: debtor.clearingCode,
      payrollResultHash: source.resultHash, payableResultHash,
    });
    const protectedSnapshot = this.crypto.protect({
      tenantId: this.tenantId(), resourceType: 'batch_snapshot',
      resourceId: batchId, version: 1,
    }, snapshot);
    await this.batches.create([{
      id: batchId, tenantId: this.tenantId(), payrollPeriodId: source.periodId,
      payrollRunId: source.payrollRunId, payrollResultHash: source.resultHash,
      payableResultHash,
      batchSequence: 1, parentBatchId: null, recoverySourceBatchId: null,
      purpose: 'regular', format: 'ISO20022_PAIN_001_001_03', fileHash: null,
      lineCount: payable.length, totalMinor: Number(total), preparedBy,
      payrollLockedBy: source.payrollLockedBy, exportApprovedBy: null,
      strongAuthEvidenceId: null, strongAuthReferenceType: null,
      objectEvidenceId: null, objectRef: null,
      bankSubmissionId: null, bankSubmissionEvidenceId: null, returnHash: null,
      successfulCount: null, failedCount: null, successfulMinor: null, failedMinor: null,
      freezeReason: null, status: 'materializing', version: 1,
      migrationEvidenceRef: null, migrationEvidenceChecksum: null,
      ...protectedRecord(protectedSnapshot),
    }], { session });
    const records = payable.map((line) => {
      const account = creditors.get(line.employeeId);
      if (account === undefined) throw new ConflictException({
        code: 'TREASURY_EMPLOYEE_ACCOUNT_INCOMPLETE', message: '可代发员工的活动银行账户不完整',
      });
      const id = createEventId(now);
      const data = Object.freeze({
        instructionId: id, employeeId: line.employeeId, bankAccountId: account.record.id,
        payrollCalculationLineId: line.calculationLineId,
        payrollResultHash: line.resultHash, creditorName: account.data.accountName,
        creditorAccount: account.data.account,
        creditorAgentClearingCode: account.data.clearingCode,
        amountMinor: line.netPayMinor, purposeCode: 'PAYROLL' as const,
      });
      const protectedData = this.crypto.protect({
        tenantId: this.tenantId(), resourceType: 'payment_instruction',
        resourceId: id, version: 1,
      }, data);
      return {
        id, tenantId: this.tenantId(), batchId,
        payrollCalculationLineId: line.calculationLineId, employeeId: line.employeeId,
        bankAccountId: account.record.id, status: 'materializing' as const, bankLineReference: null,
        ...protectedRecord(protectedData),
      };
    });
    await this.instructions.create(records, { session });
    await this.outbox.append({
      type: 'treasury.disbursement.materialization_requested', tenantId: this.tenantId(),
      aggregateId: batchId, version: 1, occurredAt: now.toISOString(), data: {
        payrollPeriodId: source.periodId, payrollRunId: source.payrollRunId,
        lineCount: payable.length, totalMinor: Number(total), status: 'materializing',
      },
    }, session);
    return Object.freeze({
      id: batchId, payrollPeriodId: source.periodId, payrollRunId: source.payrollRunId,
      status: 'materializing', version: 1, lineCount: payable.length,
      totalMinor: Number(total), fileHash: null, objectEvidenceId: null,
      bankSubmissionId: null, bankSubmissionEvidenceId: null,
    });
  }

  /** 仅供已在 Treasury 事务中建立可信密文快照的编排服务继续 WORM 物化。 */
  async materializeStaged(key: string, batchId: string): Promise<TreasuryDisbursementSummary> {
    const batch = await this.batches.findOne({ tenantId: this.tenantId(), id: batchId }).lean().exec();
    if (batch === null) throw new NotFoundException({
      code: 'TREASURY_BATCH_NOT_FOUND', message: '代发批次不存在',
    });
    if (
      batch.status === 'prepared' && batch.fileHash !== null &&
      batch.objectEvidenceId !== null && batch.objectRef !== null
    ) return summary(batch);
    if (
      batch.status !== 'materializing' || batch.version !== 1 || batch.fileHash !== null ||
      batch.objectEvidenceId !== null || batch.objectRef !== null
    ) {
      throw new ConflictException({
        code: 'TREASURY_MATERIALIZATION_STATE_INVALID', message: '代发批次不处于可物化状态',
      });
    }
    const header = batchSnapshotSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(), resourceType: 'batch_snapshot',
      resourceId: batch.id, version: 1,
    }, protectedValue(batch)));
    const records = await this.instructions.find({
      tenantId: this.tenantId(), batchId: batch.id, status: 'materializing',
    }).sort({ id: 1 }).lean().exec();
    if (records.length !== batch.lineCount) throw new ConflictException({
      code: 'TREASURY_INSTRUCTION_SNAPSHOT_INCOMPLETE', message: '代发支付指令快照不完整',
    });
    const resultReferences: Array<{ readonly employeeId: string; readonly resultHash: string }> = [];
    const lines = records.map((record) => {
      const data = instructionDataSchema.parse(this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'payment_instruction',
        resourceId: record.id, version: 1,
      }, protectedValue(record)));
      if (
        data.instructionId !== record.id || data.employeeId !== record.employeeId ||
        data.bankAccountId !== record.bankAccountId ||
        data.payrollCalculationLineId !== record.payrollCalculationLineId
      ) throw new ConflictException({
        code: 'TREASURY_INSTRUCTION_BINDING_MISMATCH', message: '支付指令密文绑定不一致',
      });
      resultReferences.push(Object.freeze({
        employeeId: data.employeeId, resultHash: data.payrollResultHash,
      }));
      return Object.freeze({
        instructionId: data.instructionId, creditorName: data.creditorName,
        creditorAccount: data.creditorAccount,
        creditorAgentClearingCode: data.creditorAgentClearingCode,
        amountMinor: data.amountMinor, purposeCode: data.purposeCode,
      });
    });
    if (
      header.messageId !== batch.id || header.paymentInformationId !== batch.id ||
      header.payrollResultHash !== batch.payrollResultHash ||
      header.payableResultHash !== batch.payableResultHash ||
      payrollDigest(resultReferences.sort((left, right) =>
        left.employeeId.localeCompare(right.employeeId))) !== batch.payableResultHash
    ) throw new ConflictException({
      code: 'TREASURY_PAYROLL_RESULT_BINDING_MISMATCH', message: '支付指令与锁定工资摘要不一致',
    });
    const total = lines.reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
    if (total !== BigInt(batch.totalMinor)) throw new ConflictException({
      code: 'TREASURY_INSTRUCTION_TOTAL_MISMATCH', message: '支付指令总额与批次不一致',
    });
    const document = generatePain001({
      messageId: header.messageId, paymentInformationId: header.paymentInformationId,
      creationDateTime: header.creationDateTime,
      requestedExecutionDate: header.requestedExecutionDate,
      debtorName: header.debtorName, debtorAccount: header.debtorAccount,
      debtorAgentClearingCode: header.debtorAgentClearingCode,
      currency: 'CNY', lines,
    });
    if (document.lineCount !== batch.lineCount || document.controlSumMinor !== batch.totalMinor) {
      throw new ConflictException({
        code: 'TREASURY_FILE_CONTROL_TOTAL_MISMATCH', message: '代发文件控制总额不一致',
      });
    }
    const bytes = Buffer.from(document.content, 'utf8');
    let receipt: Awaited<ReturnType<TreasuryImmutableArchive['put']>>;
    try {
      receipt = await this.archive.put({
        tenantId: this.tenantId(), batchId: batch.id,
        objectKey: `treasury/${batch.id}/${document.contentHash}.pain001.xml`,
        contentType: 'application/xml', classification: 'L4',
        retentionPolicy: 'payroll_disbursement', sha256: document.contentHash, bytes,
      });
    } finally {
      bytes.fill(0);
    }
    return this.run(() => this.idempotency.execute(
      'treasury.disbursement.materialize', key, {
        batchId: batch.id, fileHash: document.contentHash,
        objectEvidenceId: receipt.receiptId, objectRef: receipt.objectRef,
      }, async (session) => {
        const updated = await this.batches.updateOne({
          tenantId: this.tenantId(), id: batch.id, status: 'materializing', version: 1,
        }, { $set: {
          fileHash: document.contentHash, objectEvidenceId: receipt.receiptId,
          bankSubmissionId: null, bankSubmissionEvidenceId: null,
          objectRef: receipt.objectRef, status: 'prepared', version: 2,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'TREASURY_MATERIALIZATION_WRITE_CONFLICT', message: '代发批次物化并发冲突',
        });
        const instructionUpdate = await this.instructions.updateMany({
          tenantId: this.tenantId(), batchId: batch.id, status: 'materializing',
        }, { $set: { status: 'prepared' } }, { session, runValidators: true });
        if (instructionUpdate.modifiedCount !== batch.lineCount) throw new ConflictException({
          code: 'TREASURY_INSTRUCTION_WRITE_CONFLICT', message: '支付指令状态更新不完整',
        });
        const occurredAt = new Date().toISOString();
        await this.outbox.append({
          type: 'treasury.disbursement.prepared', tenantId: this.tenantId(),
          aggregateId: batch.id, version: 2, occurredAt, data: {
            payrollPeriodId: batch.payrollPeriodId, payrollRunId: batch.payrollRunId,
            lineCount: batch.lineCount, totalMinor: batch.totalMinor,
            fileHash: document.contentHash, objectEvidenceId: receipt.receiptId,
            status: 'prepared',
          },
        }, session);
        return Object.freeze({
          id: batch.id, payrollPeriodId: batch.payrollPeriodId,
          payrollRunId: batch.payrollRunId, status: 'prepared', version: 2,
          lineCount: batch.lineCount, totalMinor: batch.totalMinor,
          fileHash: document.contentHash, objectEvidenceId: receipt.receiptId,
          bankSubmissionId: null, bankSubmissionEvidenceId: null,
        });
      },
    ));
  }

  private accountData(record: TreasuryBankAccountRecord) {
    return bankAccountDataSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(), resourceType: 'bank_account',
      resourceId: record.id, version: record.version,
    }, protectedValue(record)));
  }

  private migrationCreditorAccounts(
    input: ImportTreasuryDisbursementFromMigrationInput,
    records: readonly TreasuryBankAccountRecord[],
    preparedAt: Date,
  ): ReadonlyMap<string, { readonly record: TreasuryBankAccountRecord;
    readonly data: BankAccountData }> {
    if (records.length !== input.lines.length ||
      new Set(records.map((record) => record.id)).size !== input.lines.length) {
      throw new ConflictException({
        code: 'TREASURY_DISBURSEMENT_MIGRATION_ACCOUNT_INCOMPLETE',
        message: '代发迁移员工账户映射不完整',
      });
    }
    const byId = new Map(records.map((record) => [record.id, record]));
    const result = new Map<string, {
      readonly record: TreasuryBankAccountRecord; readonly data: BankAccountData;
    }>();
    for (const line of input.lines) {
      const record = byId.get(line.bankAccountId);
      if (record === undefined || record.ownerId !== line.employeeId) {
        throw new ConflictException({
          code: 'TREASURY_DISBURSEMENT_MIGRATION_ACCOUNT_BINDING_INVALID',
          message: '代发迁移员工与银行账户绑定不一致',
        });
      }
      this.assertMigrationAccountAvailable(record, preparedAt);
      result.set(line.employeeId, { record, data: this.accountData(record) });
    }
    return result;
  }

  private assertMigrationAccountAvailable(
    record: TreasuryBankAccountRecord,
    preparedAt: Date,
  ): void {
    if (record.createdAt.getTime() > preparedAt.getTime() ||
      (record.revokedAt !== null && record.revokedAt.getTime() <= preparedAt.getTime())) {
      throw new ConflictException({
        code: 'TREASURY_DISBURSEMENT_MIGRATION_ACCOUNT_TIME_INVALID',
        message: '代发制备时银行账户尚未生效或已经撤销',
      });
    }
  }

  private async verifyMigrationReplay(
    input: ImportTreasuryDisbursementFromMigrationInput,
    source: LockedPayrollDisbursementSource,
    controls: MigrationPayableControls,
    debtor: TreasuryBankAccountRecord,
    creditors: ReadonlyMap<string, { readonly record: TreasuryBankAccountRecord;
      readonly data: BankAccountData }>,
    preparedBy: string,
    exportApprovedBy: string,
    preparedAt: Date,
    submittedAt: Date,
    session: ClientSession,
  ): Promise<TreasuryDisbursementSummary> {
    const batch = await this.batches.findOne({
      tenantId: this.tenantId(), id: input.targetId,
    }).session(session).lean().exec();
    if (batch === null) throw disbursementMigrationImmutable();
    const header = batchSnapshotSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(), resourceType: 'batch_snapshot',
      resourceId: batch.id, version: 1,
    }, protectedValue(batch)));
    const expectedHeader = migrationBatchHeader(
      batch.id, input, source, debtor, this.accountData(debtor),
    );
    const records = await this.instructions.find({
      tenantId: this.tenantId(), batchId: batch.id,
    }).sort({ id: 1 }).session(session).lean().exec();
    if (records.length !== controls.lineCount) throw disbursementMigrationImmutable();
    const controlByEmployee = new Map(
      controls.lines.map((line) => [line.employeeId, line]),
    );
    const fileLines = records.map((record) => {
      const control = controlByEmployee.get(record.employeeId);
      const account = creditors.get(record.employeeId);
      const data = instructionDataSchema.parse(this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'payment_instruction',
        resourceId: record.id, version: 1,
      }, protectedValue(record)));
      if (control === undefined || account === undefined) {
        throw disbursementMigrationImmutable();
      }
      const expected = migrationInstructionData(
        record.id, control, account.record.id, account.data,
      );
      if (JSON.stringify(data) !== JSON.stringify(expected) ||
        record.payrollCalculationLineId !== control.calculationLineId ||
        record.bankAccountId !== account.record.id || record.status !== 'submitted' ||
        record.bankLineReference !== null || record.createdAt.toISOString() !== input.preparedAt ||
        record.updatedAt.toISOString() !== input.submittedAt) {
        throw disbursementMigrationImmutable();
      }
      return {
        instructionId: record.id, creditorName: data.creditorName,
        creditorAccount: data.creditorAccount,
        creditorAgentClearingCode: data.creditorAgentClearingCode,
        amountMinor: data.amountMinor, purposeCode: data.purposeCode,
      };
    });
    const document = generatePain001({
      messageId: header.messageId, paymentInformationId: header.paymentInformationId,
      creationDateTime: header.creationDateTime,
      requestedExecutionDate: header.requestedExecutionDate,
      debtorName: header.debtorName, debtorAccount: header.debtorAccount,
      debtorAgentClearingCode: header.debtorAgentClearingCode,
      currency: 'CNY', lines: fileLines,
    });
    if (JSON.stringify(header) !== JSON.stringify(expectedHeader) ||
      batch.payrollPeriodId !== source.periodId || batch.payrollRunId !== source.payrollRunId ||
      batch.payrollResultHash !== source.resultHash ||
      batch.payableResultHash !== controls.payableResultHash || batch.batchSequence !== 1 ||
      batch.parentBatchId !== null || batch.recoverySourceBatchId !== null ||
      batch.purpose !== 'regular' || batch.format !== 'ISO20022_PAIN_001_001_03' ||
      batch.fileHash !== document.contentHash || batch.lineCount !== controls.lineCount ||
      batch.totalMinor !== controls.totalMinor || batch.preparedBy !== preparedBy ||
      batch.payrollLockedBy !== source.payrollLockedBy ||
      batch.exportApprovedBy !== exportApprovedBy ||
      batch.strongAuthEvidenceId !== input.approvalHistoryId ||
      batch.strongAuthReferenceType !== 'migration_export_approval_evidence' ||
      batch.objectEvidenceId !== migrationEvidenceId('batch', input.migrationEvidenceRef) ||
      batch.objectRef !== input.migrationEvidenceRef ||
      batch.bankSubmissionId !== input.bankSubmissionId ||
      batch.bankSubmissionEvidenceId !== input.bankSubmissionEvidenceId ||
      batch.returnHash !== null || batch.status !== 'submitted' || batch.version !== 4 ||
      batch.migrationEvidenceRef !== input.migrationEvidenceRef ||
      batch.migrationEvidenceChecksum !== input.evidenceChecksum ||
      batch.createdAt.toISOString() !== preparedAt.toISOString() ||
      batch.updatedAt.toISOString() !== submittedAt.toISOString()) {
      throw disbursementMigrationImmutable();
    }
    return summaryFromRecord(batch, 'submitted');
  }

  private async requireBatch(
    id: string,
    session?: ClientSession,
  ): Promise<TreasuryDisbursementBatchRecord> {
    const query = this.batches.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const batch = await query.lean().exec();
    if (batch === null) throw new NotFoundException({
      code: 'TREASURY_BATCH_NOT_FOUND', message: '代发批次不存在',
    });
    return batch;
  }

  private assertHumanPreparer(): void {
    const actor = this.context.getActorRequired();
    if (!actor.scopes.includes('erp:treasury:disbursement:prepare')) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少代发制备权限',
    });
    if (actor.actorType !== 'user') throw new ForbiddenException({
      code: 'TREASURY_PREPARER_HUMAN_REQUIRED', message: '代发制备只能由已验证人员执行',
    });
  }

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:treasury:migration:write')) {
      throw new ForbiddenException({
        code: 'TREASURY_DISBURSEMENT_MIGRATION_WRITER_DENIED',
        message: '代发迁移必须由受信任服务身份执行',
      });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof Pain001Error) throw new ConflictException({
        code: error.code, message: error.message,
      });
      if (error instanceof DisbursementBatchError) {
        if (error.code.includes('CONTROL') || error.code.includes('TENANT')) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        throw new ConflictException({ code: error.code, message: error.message });
      }
      if (error instanceof z.ZodError) throw new ConflictException({
        code: 'TREASURY_PROTECTED_DATA_INVALID', message: '资金密文数据结构或完整性非法',
      });
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'TREASURY_DISBURSEMENT_UNIQUE_CONFLICT', message: '工资运行已存在代发批次',
      });
      throw error;
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function protectedRecord(value: {
  readonly keyId: string; readonly iv: string; readonly ciphertext: string; readonly authTag: string;
}) {
  return {
    dataKeyId: value.keyId, dataIv: value.iv,
    dataCiphertext: value.ciphertext, dataAuthTag: value.authTag,
  };
}

interface MigrationPayableControls {
  readonly lines: readonly {
    readonly calculationLineId: string;
    readonly employeeId: string;
    readonly netPayMinor: number;
    readonly resultHash: string;
  }[];
  readonly lineCount: number;
  readonly totalMinor: number;
  readonly payableResultHash: string;
}

function assertDisbursementMigrationInput(
  input: ImportTreasuryDisbursementFromMigrationInput,
): void {
  if (Object.keys(input).sort().join(',') !==
      'approvalEvidenceChecksum,approvalHistoryId,bankSubmissionEvidenceId,bankSubmissionId,debtorBankAccountId,evidenceChecksum,expectedLineCount,expectedPayrollVersion,expectedTotalMinor,exportApprovedByEmployeeId,lines,migrationEvidenceRef,payrollPeriodId,payrollRunId,preparedAt,preparedByEmployeeId,requestedExecutionDate,submittedAt,targetId' ||
    (input.targetId !== null && !ID_PATTERN.test(input.targetId)) ||
    !ID_PATTERN.test(input.payrollPeriodId) || !ID_PATTERN.test(input.payrollRunId) ||
    !ID_PATTERN.test(input.debtorBankAccountId) ||
    !ID_PATTERN.test(input.preparedByEmployeeId) ||
    !ID_PATTERN.test(input.exportApprovedByEmployeeId) ||
    !ID_PATTERN.test(input.approvalHistoryId) ||
    !HASH_PATTERN.test(input.approvalEvidenceChecksum) ||
    !ID_PATTERN.test(input.bankSubmissionId) ||
    !ID_PATTERN.test(input.bankSubmissionEvidenceId) ||
    !MIGRATION_EVIDENCE_REF_PATTERN.test(input.migrationEvidenceRef) ||
    !HASH_PATTERN.test(input.evidenceChecksum) ||
    !Number.isSafeInteger(input.expectedPayrollVersion) || input.expectedPayrollVersion < 6 ||
    !Number.isSafeInteger(input.expectedLineCount) || input.expectedLineCount < 1 ||
    input.expectedLineCount > 5_000 || !Number.isSafeInteger(input.expectedTotalMinor) ||
    input.expectedTotalMinor < 1 || input.lines.length !== input.expectedLineCount ||
    !isCalendarDate(input.requestedExecutionDate)) throw disbursementMigrationInputInvalid();
  const preparedAt = strictMigrationInstant(input.preparedAt);
  const submittedAt = strictMigrationInstant(input.submittedAt);
  if (submittedAt.getTime() < preparedAt.getTime() ||
    !isExecutionWindow(input.requestedExecutionDate, preparedAt)) {
    throw disbursementMigrationInputInvalid();
  }
  for (const line of input.lines) {
    if (Object.keys(line).sort().join(',') !==
        'bankAccountId,employeeId,expectedNetPayMinor' ||
      !ID_PATTERN.test(line.employeeId) || !ID_PATTERN.test(line.bankAccountId) ||
      !Number.isSafeInteger(line.expectedNetPayMinor) || line.expectedNetPayMinor < 1) {
      throw disbursementMigrationInputInvalid();
    }
  }
  if (new Set(input.lines.map((line) => line.employeeId)).size !== input.lines.length ||
    new Set(input.lines.map((line) => line.bankAccountId)).size !== input.lines.length) {
    throw disbursementMigrationInputInvalid();
  }
}

function migrationPayableControls(
  source: LockedPayrollDisbursementSource,
  input: ImportTreasuryDisbursementFromMigrationInput,
  creditors: ReadonlyMap<string, unknown>,
): MigrationPayableControls {
  const lines = source.lines.filter((line) => line.netPayMinor > 0);
  const declared = new Map(input.lines.map((line) => [line.employeeId, line]));
  for (const line of lines) {
    const expected = declared.get(line.employeeId);
    if (expected === undefined || expected.expectedNetPayMinor !== line.netPayMinor ||
      !creditors.has(line.employeeId)) {
      throw new ConflictException({
        code: 'TREASURY_DISBURSEMENT_MIGRATION_LINE_MISMATCH',
        message: '代发迁移员工、账户或实发金额与锁定工资不一致',
      });
    }
  }
  const total = lines.reduce((sum, line) => sum + BigInt(line.netPayMinor), 0n);
  if (lines.length !== input.expectedLineCount || lines.length !== declared.size ||
    total !== BigInt(input.expectedTotalMinor) || total !== BigInt(source.totalNetMinor) ||
    total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConflictException({
      code: 'TREASURY_DISBURSEMENT_MIGRATION_TOTAL_MISMATCH',
      message: '代发迁移行数或总额与锁定工资不一致',
    });
  }
  return Object.freeze({
    lines: Object.freeze(lines), lineCount: lines.length, totalMinor: Number(total),
    payableResultHash: payrollDigest(lines.map((line) => ({
      employeeId: line.employeeId, resultHash: line.resultHash,
    })).sort((left, right) => left.employeeId.localeCompare(right.employeeId))),
  });
}

function migrationBatchHeader(
  batchId: string,
  input: ImportTreasuryDisbursementFromMigrationInput,
  source: LockedPayrollDisbursementSource,
  debtor: TreasuryBankAccountRecord,
  debtorData: BankAccountData,
) {
  return Object.freeze({
    messageId: batchId, paymentInformationId: batchId,
    creationDateTime: input.preparedAt,
    requestedExecutionDate: input.requestedExecutionDate,
    debtorBankAccountId: debtor.id, debtorName: debtorData.accountName,
    debtorAccount: debtorData.account,
    debtorAgentClearingCode: debtorData.clearingCode,
    payrollResultHash: source.resultHash,
    payableResultHash: payrollDigest(source.lines.filter((line) => line.netPayMinor > 0)
      .map((line) => ({ employeeId: line.employeeId, resultHash: line.resultHash }))
      .sort((left, right) => left.employeeId.localeCompare(right.employeeId))),
  });
}

function migrationInstructionData(
  instructionId: string,
  line: MigrationPayableControls['lines'][number],
  bankAccountId: string,
  account: BankAccountData,
) {
  return Object.freeze({
    instructionId, employeeId: line.employeeId, bankAccountId,
    payrollCalculationLineId: line.calculationLineId,
    payrollResultHash: line.resultHash, creditorName: account.accountName,
    creditorAccount: account.account,
    creditorAgentClearingCode: account.clearingCode,
    amountMinor: line.netPayMinor, purposeCode: 'PAYROLL' as const,
  });
}

function migrationBatchEventData(batch: {
  readonly payrollPeriodId: string;
  readonly payrollRunId: string;
  readonly lineCount: number;
  readonly totalMinor: number;
  readonly fileHash: string;
}) {
  return {
    payrollPeriodId: batch.payrollPeriodId, payrollRunId: batch.payrollRunId,
    lineCount: batch.lineCount, totalMinor: batch.totalMinor,
    fileHash: batch.fileHash, status: 'submitted',
  } as const;
}

function strictMigrationInstant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value ||
    parsed.getTime() > Date.now() + 5 * 60_000) throw disbursementMigrationInputInvalid();
  return parsed;
}

function migrationEvidenceId(kind: string, reference: string): string {
  return `migration-${kind}:${createHash('sha256').update(reference, 'utf8').digest('base64url')}`;
}

function disbursementMigrationInputInvalid(): BadRequestException {
  return new BadRequestException({
    code: 'TREASURY_DISBURSEMENT_MIGRATION_INPUT_INVALID',
    message: '代发迁移控制信息非法',
  });
}

function disbursementMigrationImmutable(): ConflictException {
  return new ConflictException({
    code: 'TREASURY_DISBURSEMENT_MIGRATION_IMMUTABLE',
    message: '既有代发批次、支付指令或迁移证据不一致，禁止覆盖',
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

function summary(batch: TreasuryDisbursementBatchRecord): TreasuryDisbursementSummary {
  if (batch.status !== 'prepared') throw new Error('TREASURY_BATCH_SUMMARY_STATE_INVALID');
  return Object.freeze({
    id: batch.id, payrollPeriodId: batch.payrollPeriodId, payrollRunId: batch.payrollRunId,
    status: 'prepared', version: batch.version, lineCount: batch.lineCount,
    totalMinor: batch.totalMinor, fileHash: batch.fileHash,
    objectEvidenceId: batch.objectEvidenceId,
    bankSubmissionId: batch.bankSubmissionId,
    bankSubmissionEvidenceId: batch.bankSubmissionEvidenceId,
  });
}

function summaryFromDomain(batch: DisbursementBatch): TreasuryDisbursementSummary {
  return Object.freeze({
    id: batch.id, payrollPeriodId: batch.payrollPeriodId, payrollRunId: batch.payrollRunId,
    status: batch.status === 'submitted' ? 'submitted'
      : batch.status === 'exported' ? 'exported' : 'prepared', version: batch.version,
    lineCount: batch.lineCount, totalMinor: batch.totalMinor,
    fileHash: batch.fileHash, objectEvidenceId: batch.objectEvidenceId,
    bankSubmissionId: batch.bankSubmissionId,
    bankSubmissionEvidenceId: batch.bankSubmissionEvidenceId,
  });
}

function batchFromRecord(
  record: TreasuryDisbursementBatchRecord,
  allowSubmitting = false,
): DisbursementBatch {
  if (
    record.fileHash === null || record.status === 'materializing' ||
    (record.status === 'submitting' && !allowSubmitting)
  ) {
    throw new Error('TREASURY_BATCH_FILE_HASH_REQUIRED');
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
    freezeReason: record.freezeReason,
    status: record.status === 'submitting' ? 'exported' : record.status,
    version: record.version, createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function summaryFromRecord(
  batch: TreasuryDisbursementBatchRecord,
  status: 'submitting' | 'submitted',
): TreasuryDisbursementSummary {
  return Object.freeze({
    id: batch.id, payrollPeriodId: batch.payrollPeriodId, payrollRunId: batch.payrollRunId,
    status, version: batch.version, lineCount: batch.lineCount, totalMinor: batch.totalMinor,
    fileHash: batch.fileHash, objectEvidenceId: batch.objectEvidenceId,
    bankSubmissionId: batch.bankSubmissionId,
    bankSubmissionEvidenceId: batch.bankSubmissionEvidenceId,
  });
}

function deriveKey(root: string, stage: string): string {
  const hash = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `treasury:${hash}`;
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isExecutionWindow(value: string, now: Date): boolean {
  const requested = Date.parse(`${value}T00:00:00.000Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const max = today + 90 * 24 * 60 * 60 * 1_000;
  return requested >= today && requested <= max;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11_000;
}
