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
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
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
} from '../persistence/payroll.schemas.js';
import {
  payrollPeriodFromRecord,
  payrollPeriodSummary,
  toMutablePayrollPeriodRecord,
  type PayrollPeriodSummary,
} from './payroll-run.service.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

@Injectable()
export class PayrollApprovalService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly approvals: ApprovalApplicationService,
    private readonly strongAuth: WebAuthnService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
  ) {}

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
  ): Promise<void> {
    const result = await this.periods.updateOne(
      { tenantId: this.tenantId(), id: current.id, version: current.version, status: current.status },
      { $set: toMutablePayrollPeriodRecord(next) }, { session, runValidators: true },
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
      throw error;
    }
  }

  private tenantId(): string { return this.context.getTenantRequired().tenantId; }
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256').update(JSON.stringify([root, stage]), 'utf8').digest('base64url');
  return `payroll:${digest}`;
}
