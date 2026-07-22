import { createHash } from 'node:crypto';

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

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { WebAuthnService } from '../../identity/strong-auth/webauthn.service.js';
import {
  applyPayrollApproval,
  lockPayrollPeriod,
  submitPayrollApproval,
  PayrollPeriodError,
  type PayrollPeriod,
} from '../domain/index.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
  PayrollPeriodApprovalEvidenceRecord,
  type PayrollPeriodApprovalEvidenceDocument,
  PayrollPeriodLockEvidenceRecord,
  type PayrollPeriodLockEvidenceDocument,
} from '../persistence/payroll.schemas.js';
import {
  payrollPeriodFromRecord,
  payrollPeriodSummary,
  toMutablePayrollPeriodRecord,
  type PayrollPeriodSummary,
} from './payroll-run.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIGRATION_EVIDENCE_REF_PATTERN =
  /^erp:\/\/data-migrations\/runs\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/attachments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ImportPayrollPeriodApprovalFromMigrationInput {
  readonly targetId: string | null;
  readonly periodId: string;
  readonly expectedPeriodVersion: number;
  readonly approvalHistoryId: string;
  readonly approvalEvidenceChecksum: string;
  readonly approvedByEmployeeId: string;
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface ImportPayrollPeriodLockFromMigrationInput {
  readonly targetId: string | null;
  readonly periodId: string;
  readonly expectedPeriodVersion: number;
  readonly approvalControlEvidenceId: string;
  readonly lockedByEmployeeId: string;
  readonly lockedAt: string;
  readonly strongAuthMethod: 'webauthn_uv';
  readonly migrationEvidenceRef: string;
  readonly evidenceChecksum: string;
}

export interface PayrollPeriodControlMigrationSummary extends Record<string, unknown> {
  readonly id: string;
  readonly version: 1;
  readonly periodId: string;
  readonly periodVersion: number;
  readonly status: 'approved' | 'locked';
}

@Injectable()
export class PayrollApprovalService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly profiles: AccessProfileRepository,
    private readonly approvals: ApprovalApplicationService,
    private readonly strongAuth: WebAuthnService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
    @InjectModel(PayrollPeriodApprovalEvidenceRecord.name)
    private readonly approvalEvidence: Model<PayrollPeriodApprovalEvidenceDocument>,
    @InjectModel(PayrollPeriodLockEvidenceRecord.name)
    private readonly lockEvidence: Model<PayrollPeriodLockEvidenceDocument>,
  ) {}

  /** 迁移专用：用已批准历史恢复审批状态，不创建在线审批实例或通知。 */
  async importApprovalFromMigration(
    key: string,
    input: ImportPayrollPeriodApprovalFromMigrationInput,
  ): Promise<PayrollPeriodControlMigrationSummary> {
    this.assertMigrationWriter();
    assertApprovalMigrationInput(input);
    return this.run(() => this.idempotency.execute(
      'payroll.period_approval.import_from_migration', key, input, async (session) => {
        const [approvedBy, approval] = await Promise.all([
          this.profiles.findActorIdByEmployee(
            this.tenantId(), input.approvedByEmployeeId, session,
          ),
          this.approvals.verifyPayrollMigrationReference(
            input.approvalHistoryId, 'payroll_period_approval', session,
          ),
        ]);
        if (approvedBy === null) throw new NotFoundException({
          code: 'PAYROLL_MIGRATION_APPROVER_IDENTITY_NOT_FOUND',
          message: '迁移工资审批员工未绑定可信身份',
        });
        if (approval.evidenceChecksum !== input.approvalEvidenceChecksum) {
          throw new ConflictException({
            code: 'PAYROLL_MIGRATION_APPROVAL_EVIDENCE_MISMATCH',
            message: '迁移工资审批历史证据摘要不一致',
          });
        }
        const approvedAt = strictMigrationInstant(approval.completedAt);
        const current = await this.requirePeriod(input.periodId, session);
        if (input.targetId !== null) return this.verifyApprovalReplay(
          current, input, approvedBy, approvedAt, session,
        );
        if (current.status !== 'review' || current.version !== input.expectedPeriodVersion ||
          current.activeRunId === null || approvedAt.getTime() < current.updatedAt.getTime()) {
          throw new ConflictException({
            code: 'PAYROLL_MIGRATION_APPROVAL_STATE_INVALID',
            message: '迁移工资审批的周期状态、版本、运行或时间线非法',
          });
        }
        const evidenceId = createEventId(approvedAt);
        const pending = submitPayrollApproval(payrollPeriodFromRecord(current), {
          tenantId: this.tenantId(), expectedVersion: input.expectedPeriodVersion,
          approvalReferenceType: 'legacy_history', approvalInstanceId: approval.id,
        }, approvedAt);
        const approved = applyPayrollApproval(pending, {
          tenantId: this.tenantId(), expectedVersion: pending.version,
          approvalReferenceType: 'legacy_history', approvalInstanceId: approval.id,
          outcome: 'approved', decidedBy: approvedBy,
          approvalEvidenceId: approval.id, trustedApproval: true,
        }, approvedAt);
        await this.approvalEvidence.create([{
          id: evidenceId, tenantId: this.tenantId(), periodId: current.id,
          approvalHistoryId: approval.id,
          approvalEvidenceChecksum: input.approvalEvidenceChecksum,
          approvedBy, approvedAt, periodVersion: approved.version,
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
          createdAt: approvedAt, updatedAt: approvedAt,
        }], { session });
        await this.replace(current, approved, session, true);
        await this.outbox.append({
          type: 'payroll.period_approval.migrated', tenantId: approved.tenantId,
          aggregateId: approved.id, version: approved.version, occurredAt: approved.updatedAt,
          data: { period: approved.period, status: approved.status },
        }, session);
        return controlSummary(evidenceId, approved.version, 'approved', approved.id);
      },
    ));
  }

  /** 迁移专用：用独立 WORM 强认证证明恢复锁定，不伪造 WebAuthn 仪式。 */
  async importLockFromMigration(
    key: string,
    input: ImportPayrollPeriodLockFromMigrationInput,
  ): Promise<PayrollPeriodControlMigrationSummary> {
    this.assertMigrationWriter();
    assertLockMigrationInput(input);
    return this.run(() => this.idempotency.execute(
      'payroll.period_lock.import_from_migration', key, input, async (session) => {
        const lockedBy = await this.profiles.findActorIdByEmployee(
          this.tenantId(), input.lockedByEmployeeId, session,
        );
        if (lockedBy === null) throw new NotFoundException({
          code: 'PAYROLL_MIGRATION_LOCKER_IDENTITY_NOT_FOUND',
          message: '迁移工资锁定员工未绑定可信身份',
        });
        const approvalControl = await this.approvalEvidence.findOne({
          tenantId: this.tenantId(), id: input.approvalControlEvidenceId,
          periodId: input.periodId,
        }).session(session).lean().exec();
        if (approvalControl === null) throw new NotFoundException({
          code: 'PAYROLL_MIGRATION_APPROVAL_CONTROL_NOT_FOUND',
          message: '迁移工资锁定缺少前置审批控制证据',
        });
        const lockedAt = strictMigrationInstant(input.lockedAt);
        const current = await this.requirePeriod(input.periodId, session);
        if (input.targetId !== null) return this.verifyLockReplay(
          current, input, lockedBy, lockedAt, approvalControl, session,
        );
        if (current.status !== 'approved' || current.version !== input.expectedPeriodVersion ||
          current.approvalReferenceType !== 'legacy_history' ||
          current.approvalInstanceId !== approvalControl.approvalHistoryId ||
          current.approvedBy !== approvalControl.approvedBy ||
          lockedAt.getTime() < approvalControl.approvedAt.getTime() ||
          lockedAt.getTime() < current.updatedAt.getTime()) throw new ConflictException({
          code: 'PAYROLL_MIGRATION_LOCK_STATE_INVALID',
          message: '迁移工资锁定的审批、周期版本或时间线非法',
        });
        const evidenceId = createEventId(lockedAt);
        const locked = lockPayrollPeriod(payrollPeriodFromRecord(current), {
          tenantId: this.tenantId(), expectedVersion: input.expectedPeriodVersion,
          lockedBy, strongAuthEvidenceId: evidenceId,
          strongAuthReferenceType: 'migration_lock_evidence',
        }, lockedAt);
        await this.lockEvidence.create([{
          id: evidenceId, tenantId: this.tenantId(), periodId: current.id,
          approvalControlEvidenceId: approvalControl.id, lockedBy, lockedAt,
          periodVersion: locked.version,
          strongAuthMethod: input.strongAuthMethod, operationId: current.id,
          migrationEvidenceRef: input.migrationEvidenceRef,
          migrationEvidenceChecksum: input.evidenceChecksum,
          createdAt: lockedAt, updatedAt: lockedAt,
        }], { session });
        await this.replace(current, locked, session, true);
        await this.outbox.append({
          type: 'payroll.period_lock.migrated', tenantId: locked.tenantId,
          aggregateId: locked.id, version: locked.version, occurredAt: locked.updatedAt,
          data: { period: locked.period, status: locked.status, strongAuthMethod: 'webauthn_uv' },
        }, session);
        return controlSummary(evidenceId, locked.version, 'locked', locked.id);
      },
    ));
  }

  async requestApproval(
    key: string,
    periodId: string,
    expectedVersion: number,
  ): Promise<PayrollPeriodSummary> {
    this.assertScope('erp:payroll:approval:request');
    this.assertScope('erp:approval:instance:submit');
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'user') throw new ForbiddenException({
      code: 'PAYROLL_APPROVAL_HUMAN_REQUIRED', message: '工资送审只能由已验证人员执行',
    });
    const current = await this.requirePeriod(periodId);
    const domain = payrollPeriodFromRecord(current);
    if (domain.version !== expectedVersion || domain.status !== 'review' || domain.activeRun === null) {
      throw new ConflictException({
        code: 'PAYROLL_APPROVAL_REQUEST_STATE_CHANGED', message: '工资周期版本或复核状态已变化',
      });
    }
    if (domain.preparedBy !== actor.actorId) throw new ForbiddenException({
      code: 'PAYROLL_APPROVAL_PREPARER_REQUIRED', message: '只有工资制单人可以发起审批',
    });
    const created = await this.approvals.createInstance(deriveKey(key, 'create'), {
      templateCode: 'payroll_period_approval', title: `工资审批：${domain.period}`,
      formData: {
        period_id: domain.id, run_id: domain.activeRun.id,
        input_snapshot_hash: domain.activeRun.inputSnapshotHash,
        result_hash: domain.activeRun.resultHash,
      },
    });
    const submitted = await this.approvals.submitInstance(
      created.instance.id, created.instance.version, deriveKey(key, 'submit'),
    );
    if (submitted.instance.status !== 'running' && submitted.instance.status !== 'approved') {
      throw new ConflictException({
        code: 'PAYROLL_APPROVAL_SUBMIT_INVALID', message: '工资审批未进入可处理状态',
      });
    }
    return this.run(() => this.idempotency.execute(
      'payroll.approval.request', deriveKey(key, 'bind'),
      { periodId, expectedVersion, approvalInstanceId: submitted.instance.id },
      async (session) => {
        const fresh = await this.requirePeriod(periodId, session);
        const next = submitPayrollApproval(payrollPeriodFromRecord(fresh), {
          tenantId: this.tenantId(), expectedVersion,
          approvalReferenceType: 'approval_instance',
          approvalInstanceId: submitted.instance.id,
        }, new Date());
        await this.replace(fresh, next, session);
        await this.outbox.append({
          type: 'payroll.approval.requested', tenantId: next.tenantId,
          aggregateId: next.id, version: next.version, occurredAt: next.updatedAt,
          data: { period: next.period, approvalInstanceId: submitted.instance.id },
        }, session);
        return payrollPeriodSummary(next);
      },
    ));
  }

  async applyApproval(
    key: string,
    periodId: string,
    expectedVersion: number,
    approvalInstanceId: string,
  ): Promise<PayrollPeriodSummary> {
    this.assertScope('erp:payroll:approval:sync');
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'PAYROLL_APPROVAL_SERVICE_REQUIRED', message: '只允许受信任审批同步服务执行',
      });
    }
    const decision = await this.approvals.getPayrollPeriodDecision(approvalInstanceId);
    return this.run(() => this.idempotency.execute(
      'payroll.approval.apply', key,
      { periodId, expectedVersion, approvalInstanceId, decision: decision.formDataHash },
      async (session) => {
        const current = await this.requirePeriod(periodId, session);
        const domain = payrollPeriodFromRecord(current);
        if (
          domain.activeRun === null || decision.periodId !== domain.id ||
          decision.runId !== domain.activeRun.id ||
          decision.inputSnapshotHash !== domain.activeRun.inputSnapshotHash ||
          decision.resultHash !== domain.activeRun.resultHash
        ) throw new ConflictException({
          code: 'PAYROLL_APPROVAL_BINDING_MISMATCH', message: '审批与工资周期运行摘要不匹配',
        });
        const next = applyPayrollApproval(domain, {
          tenantId: this.tenantId(), expectedVersion,
          approvalReferenceType: 'approval_instance',
          approvalInstanceId: decision.id, outcome: decision.outcome,
          decidedBy: decision.decidedBy, approvalEvidenceId: decision.id,
          trustedApproval: true,
        }, new Date(decision.completedAt));
        await this.replace(current, next, session);
        await this.outbox.append({
          type: 'payroll.approval.applied', tenantId: next.tenantId,
          aggregateId: next.id, version: next.version, occurredAt: next.updatedAt,
          data: {
            period: next.period, approvalInstanceId: decision.id,
            outcome: decision.outcome, status: next.status,
          },
        }, session);
        return payrollPeriodSummary(next);
      },
    ));
  }

  async lockPeriod(
    key: string,
    periodId: string,
    expectedVersion: number,
    evidenceId: string,
    token: VerifiedAccessToken,
  ): Promise<PayrollPeriodSummary> {
    this.assertScope('erp:payroll:period:lock');
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'user' || token.actorType !== 'user' ||
      token.tenantId !== this.tenantId() || token.actorId !== actor.actorId
    ) throw new ForbiddenException({
      code: 'PAYROLL_LOCK_IDENTITY_INVALID', message: '工资锁定身份上下文非法',
    });
    if (!ULID_PATTERN.test(periodId) || !ULID_PATTERN.test(evidenceId)) {
      throw new ForbiddenException({ code: 'PAYROLL_LOCK_EVIDENCE_INVALID', message: '锁定证据非法' });
    }
    const evidence = await this.strongAuth.requireVerifiedEvidence({
      evidenceId, tenantId: token.tenantId, actorId: token.actorId,
      sessionId: token.sessionId, operationId: periodId,
    });
    return this.run(() => this.idempotency.execute(
      'payroll.period.lock', key, { periodId, expectedVersion, evidenceId },
      async (session) => {
        const current = await this.requirePeriod(periodId, session);
        const next = lockPayrollPeriod(payrollPeriodFromRecord(current), {
          tenantId: this.tenantId(), expectedVersion, lockedBy: actor.actorId,
          strongAuthEvidenceId: evidence.evidenceId,
          strongAuthReferenceType: 'webauthn_evidence',
        }, new Date());
        await this.replace(current, next, session);
        await this.outbox.append({
          type: 'payroll.period.locked', tenantId: next.tenantId,
          aggregateId: next.id, version: next.version, occurredAt: next.updatedAt,
          data: { period: next.period, status: next.status, strongAuthMethod: evidence.method },
        }, session);
        return payrollPeriodSummary(next);
      },
    ));
  }

  private async verifyApprovalReplay(
    period: PayrollPeriodRecord,
    input: ImportPayrollPeriodApprovalFromMigrationInput,
    approvedBy: string,
    approvedAt: Date,
    session: ClientSession,
  ): Promise<PayrollPeriodControlMigrationSummary> {
    const evidence = await this.approvalEvidence.findOne({
      tenantId: this.tenantId(), id: input.targetId,
    }).session(session).lean().exec();
    if (evidence === null || evidence.periodId !== input.periodId ||
      evidence.approvalHistoryId !== input.approvalHistoryId ||
      evidence.approvalEvidenceChecksum !== input.approvalEvidenceChecksum ||
      evidence.approvedBy !== approvedBy ||
      evidence.approvedAt.toISOString() !== approvedAt.toISOString() ||
      evidence.periodVersion !== input.expectedPeriodVersion + 2 ||
      evidence.migrationEvidenceRef !== input.migrationEvidenceRef ||
      evidence.migrationEvidenceChecksum !== input.evidenceChecksum ||
      evidence.createdAt.toISOString() !== approvedAt.toISOString() ||
      evidence.updatedAt.toISOString() !== approvedAt.toISOString() ||
      !['approved', 'locked', 'disbursing', 'reconciling', 'reconciled'].includes(period.status) ||
      period.version < evidence.periodVersion || period.approvalReferenceType !== 'legacy_history' ||
      period.approvalInstanceId !== evidence.approvalHistoryId ||
      period.approvalEvidenceId !== evidence.approvalHistoryId ||
      period.approvedBy !== evidence.approvedBy) throw controlImmutable();
    return controlSummary(evidence.id, evidence.periodVersion, 'approved', evidence.periodId);
  }

  private async verifyLockReplay(
    period: PayrollPeriodRecord,
    input: ImportPayrollPeriodLockFromMigrationInput,
    lockedBy: string,
    lockedAt: Date,
    approvalControl: PayrollPeriodApprovalEvidenceRecord,
    session: ClientSession,
  ): Promise<PayrollPeriodControlMigrationSummary> {
    const evidence = await this.lockEvidence.findOne({
      tenantId: this.tenantId(), id: input.targetId,
    }).session(session).lean().exec();
    if (evidence === null || evidence.periodId !== input.periodId ||
      evidence.approvalControlEvidenceId !== input.approvalControlEvidenceId ||
      evidence.lockedBy !== lockedBy || evidence.lockedAt.toISOString() !== input.lockedAt ||
      evidence.strongAuthMethod !== input.strongAuthMethod ||
      evidence.operationId !== input.periodId ||
      evidence.periodVersion !== input.expectedPeriodVersion + 1 ||
      evidence.migrationEvidenceRef !== input.migrationEvidenceRef ||
      evidence.migrationEvidenceChecksum !== input.evidenceChecksum ||
      evidence.createdAt.toISOString() !== lockedAt.toISOString() ||
      evidence.updatedAt.toISOString() !== lockedAt.toISOString() ||
      evidence.lockedAt.getTime() < approvalControl.approvedAt.getTime() ||
      !['locked', 'disbursing', 'reconciling', 'reconciled'].includes(period.status) ||
      period.version < evidence.periodVersion || period.lockedBy !== evidence.lockedBy ||
      period.strongAuthReferenceType !== 'migration_lock_evidence' ||
      period.strongAuthEvidenceId !== evidence.id) throw controlImmutable();
    return controlSummary(evidence.id, evidence.periodVersion, 'locked', evidence.periodId);
  }

  private async requirePeriod(id: string, session?: ClientSession): Promise<PayrollPeriodRecord> {
    const query = this.periods.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const period = await query.lean().exec();
    if (period === null) throw new NotFoundException({
      code: 'PAYROLL_PERIOD_NOT_FOUND', message: '工资周期不存在',
    });
    return period;
  }

  private async replace(
    current: PayrollPeriodRecord,
    next: PayrollPeriod,
    session: ClientSession,
    preserveHistoricalTimestamp = false,
  ): Promise<void> {
    const result = await this.periods.updateOne(
      { tenantId: this.tenantId(), id: current.id, version: current.version, status: current.status },
      { $set: {
        ...toMutablePayrollPeriodRecord(next),
        ...(preserveHistoricalTimestamp ? { updatedAt: new Date(next.updatedAt) } : {}),
      } },
      {
        session, runValidators: true,
        ...(preserveHistoricalTimestamp ? { timestamps: false } : {}),
      },
    );
    if (result.modifiedCount !== 1) throw new ConflictException({
      code: 'PAYROLL_PERIOD_WRITE_CONFLICT', message: '工资周期发生并发写入冲突',
    });
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少工资审批权限',
    });
  }

  private assertMigrationWriter(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:payroll:migration:write')) {
      throw new ForbiddenException({
        code: 'PAYROLL_MIGRATION_WRITER_DENIED',
        message: '工资控制迁移必须由受信任服务身份执行',
      });
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof PayrollPeriodError) {
        if (error.code.includes('TENANT') || error.code.includes('CONTROL')) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        if (
          error.code.includes('VERSION') || error.code.includes('TRANSITION') ||
          error.code.includes('REQUIRED') || error.code.includes('UNTRUSTED')
        ) throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'PAYROLL_MIGRATION_CONTROL_UNIQUE_CONFLICT',
        message: '工资批准或锁定迁移控制已被其他来源占用',
      });
      throw error;
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `payroll:${digest}`;
}

function assertApprovalMigrationInput(
  input: ImportPayrollPeriodApprovalFromMigrationInput,
): void {
  if (Object.keys(input).sort().join(',') !==
      'approvalEvidenceChecksum,approvalHistoryId,approvedByEmployeeId,evidenceChecksum,expectedPeriodVersion,migrationEvidenceRef,periodId,targetId' ||
    (input.targetId !== null && !ULID_PATTERN.test(input.targetId)) ||
    !ULID_PATTERN.test(input.periodId) || !ULID_PATTERN.test(input.approvalHistoryId) ||
    !ID_PATTERN.test(input.approvedByEmployeeId) ||
    !Number.isSafeInteger(input.expectedPeriodVersion) || input.expectedPeriodVersion < 3 ||
    !HASH_PATTERN.test(input.approvalEvidenceChecksum) ||
    !MIGRATION_EVIDENCE_REF_PATTERN.test(input.migrationEvidenceRef) ||
    !HASH_PATTERN.test(input.evidenceChecksum)) throw new BadRequestException({
    code: 'PAYROLL_MIGRATION_APPROVAL_INPUT_INVALID',
    message: '迁移工资审批控制信息非法',
  });
}

function assertLockMigrationInput(input: ImportPayrollPeriodLockFromMigrationInput): void {
  strictMigrationInstant(input.lockedAt);
  if (Object.keys(input).sort().join(',') !==
      'approvalControlEvidenceId,evidenceChecksum,expectedPeriodVersion,lockedAt,lockedByEmployeeId,migrationEvidenceRef,periodId,strongAuthMethod,targetId' ||
    (input.targetId !== null && !ULID_PATTERN.test(input.targetId)) ||
    !ULID_PATTERN.test(input.periodId) || !ULID_PATTERN.test(input.approvalControlEvidenceId) ||
    !ID_PATTERN.test(input.lockedByEmployeeId) || input.strongAuthMethod !== 'webauthn_uv' ||
    !Number.isSafeInteger(input.expectedPeriodVersion) || input.expectedPeriodVersion < 5 ||
    !MIGRATION_EVIDENCE_REF_PATTERN.test(input.migrationEvidenceRef) ||
    !HASH_PATTERN.test(input.evidenceChecksum)) throw new BadRequestException({
    code: 'PAYROLL_MIGRATION_LOCK_INPUT_INVALID', message: '迁移工资锁定控制信息非法',
  });
}

function strictMigrationInstant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value ||
    parsed.getTime() > Date.now() + 5 * 60 * 1_000) throw new BadRequestException({
    code: 'PAYROLL_MIGRATION_TIME_INVALID', message: '工资控制迁移时间必须为历史 UTC 毫秒时间',
  });
  return parsed;
}

function controlSummary(
  id: string,
  periodVersion: number,
  status: 'approved' | 'locked',
  periodId: string,
): PayrollPeriodControlMigrationSummary {
  return Object.freeze({ id, version: 1, periodId, periodVersion, status });
}

function controlImmutable(): ConflictException {
  return new ConflictException({
    code: 'PAYROLL_MIGRATION_CONTROL_IMMUTABLE',
    message: '既有工资控制证据或周期引用不一致，禁止覆盖',
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { readonly code?: unknown }).code === 11_000;
}
