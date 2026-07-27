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
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type { VerifiedAccessToken } from '../../identity/auth.types.js';
import { WebAuthnService } from '../../identity/strong-auth/webauthn.service.js';
import {
  applyPayrollAdjustmentApproval,
  createPayrollAdjustment,
  lockPayrollAdjustment,
  payrollDigest,
  PayrollAdjustmentError,
  requestPayrollAdjustmentApproval,
  type PayrollAdjustmentControl,
  type PayrollAdjustmentResult,
  type PayrollCalculationResult,
} from '../domain/index.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollAdjustmentRecord,
  type PayrollAdjustmentDocument,
  PayrollCalculationLineRecord,
  type PayrollCalculationLineDocument,
  PayrollPeriodRecord,
  type PayrollPeriodDocument,
} from '../persistence/payroll.schemas.js';
import {
  PayrollRunService,
  type PayrollRunLineInput,
} from './payroll-run.service.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const cumulativeSchema = z.object({
  taxableIncomeMinor: z.number().int().safe().nonnegative(),
  basicDeductionMinor: z.number().int().safe().nonnegative(),
  socialInsuranceMinor: z.number().int().safe().nonnegative(),
  housingFundMinor: z.number().int().safe().nonnegative(),
  specialAdditionalDeductionMinor: z.number().int().safe().nonnegative(),
  otherDeductionMinor: z.number().int().safe().nonnegative(),
  taxWithheldMinor: z.number().int().safe().nonnegative(),
}).strict();
const resultSchema = z.object({
  currency: z.literal('CNY'), inputHash: z.string().regex(HASH),
  grossPayMinor: z.number().int().safe().nonnegative(),
  taxableEarningsMinor: z.number().int().safe().nonnegative(),
  withholdingTaxMinor: z.number().int().safe(),
  netPayMinor: z.number().int().safe().nonnegative(),
  cumulativeAfter: cumulativeSchema, steps: z.array(z.unknown()),
  resultHash: z.string().regex(HASH),
}).strict();
const adjustmentSchema = z.object({
  type: z.enum(['supplement', 'reversal', 'tax_only']),
  currency: z.literal('CNY'), originalCalculationLineId: z.string().regex(ULID),
  originalInputHash: z.string().regex(HASH), originalResultHash: z.string().regex(HASH),
  correctedInputHash: z.string().regex(HASH), correctedResultHash: z.string().regex(HASH),
  reasonCode: z.string().regex(REASON),
  delta: z.object({
    grossPayMinor: z.number().int().safe(),
    taxableEarningsMinor: z.number().int().safe(),
    withholdingTaxMinor: z.number().int().safe(),
    netPayMinor: z.number().int().safe(),
    cumulativeAfter: z.object({
      taxableIncomeMinor: z.number().int().safe(),
      basicDeductionMinor: z.number().int().safe(),
      socialInsuranceMinor: z.number().int().safe(),
      housingFundMinor: z.number().int().safe(),
      specialAdditionalDeductionMinor: z.number().int().safe(),
      otherDeductionMinor: z.number().int().safe(),
      taxWithheldMinor: z.number().int().safe(),
    }).strict(),
  }).strict(),
  payableMinor: z.number().int().safe().nonnegative(),
  receivableMinor: z.number().int().safe().nonnegative(),
  adjustmentHash: z.string().regex(HASH),
}).strict();
const adjustmentBundleSchema = z.object({
  originalResult: resultSchema,
  correctedResult: resultSchema,
  adjustment: adjustmentSchema,
}).passthrough();

export interface PreparePayrollAdjustmentInput {
  readonly periodId: string;
  readonly originalCalculationLineId: string;
  readonly rulePackId: string;
  readonly rulePackVersion: number;
  readonly reasonCode: string;
  readonly correctedLine: PayrollRunLineInput;
}

export interface PayrollAdjustmentSummary extends Record<string, unknown> {
  readonly id: string;
  readonly periodId: string;
  readonly period: string;
  readonly originalCalculationLineId: string;
  readonly adjustmentNumber: number;
  readonly type: 'supplement' | 'reversal' | 'tax_only';
  readonly reasonCode: string;
  readonly status:
    | 'prepared'
    | 'pending_approval'
    | 'approved'
    | 'locked'
    | 'settled'
    | 'cancelled';
  readonly version: number;
  readonly adjustmentHash: string;
  readonly grossDeltaMinor: number;
  readonly taxDeltaMinor: number;
  readonly netDeltaMinor: number;
  readonly payableMinor: number;
  readonly receivableMinor: number;
  readonly approvalInstanceId: string | null;
  readonly cashSettlementStatus: 'not_required' | 'pending' | 'settled';
  readonly taxCorrectionStatus: 'not_required' | 'pending' | 'submitted';
}

export interface PayrollAdjustmentControlSummary extends Record<string, unknown> {
  readonly id: string;
  readonly period: string;
  readonly adjustmentNumber: number;
  readonly type: 'supplement' | 'reversal' | 'tax_only';
  readonly reasonCode: string;
  readonly status: PayrollAdjustmentSummary['status'];
  readonly cashSettlementStatus: PayrollAdjustmentSummary['cashSettlementStatus'];
  readonly taxCorrectionStatus: PayrollAdjustmentSummary['taxCorrectionStatus'];
  readonly version: number;
  readonly adjustmentHash: string;
}

/** Treasury 内部只读来源；禁止注册 REST/MCP 或序列化到事件、审计和日志。 */
export interface LockedPayrollSupplementSource {
  readonly adjustmentId: string;
  readonly adjustmentHash: string;
  readonly periodId: string;
  readonly period: string;
  readonly payrollRunId: string;
  readonly originalCalculationLineId: string;
  readonly employeeId: string;
  readonly correctedResultHash: string;
  readonly payableMinor: number;
  readonly adjustmentVersion: number;
  readonly controlActorIds: readonly string[];
  readonly lockedBy: string;
}

/** 员工应收内部只读来源；禁止注册 REST/MCP 或序列化到事件、审计和日志。 */
export interface LockedPayrollReversalSource {
  readonly adjustmentId: string;
  readonly adjustmentHash: string;
  readonly period: string;
  readonly employeeId: string;
  readonly receivableMinor: number;
  readonly adjustmentVersion: number;
  readonly controlActorIds: readonly string[];
}

/** 税务更正内部来源；包含 L4 员工税额，只能在 Payroll 服务事务内使用。 */
export interface LockedPayrollTaxCorrectionSource {
  readonly adjustmentId: string;
  readonly adjustmentHash: string;
  readonly period: string;
  readonly employeeId: string;
  readonly reasonCode: string;
  readonly originalResultHash: string;
  readonly correctedResultHash: string;
  readonly originalTaxableEarningsMinor: number;
  readonly correctedTaxableEarningsMinor: number;
  readonly originalWithholdingTaxMinor: number;
  readonly correctedWithholdingTaxMinor: number;
  readonly taxableEarningsDeltaMinor: number;
  readonly withholdingTaxDeltaMinor: number;
  readonly cumulativeTaxWithheldDeltaMinor: number;
  readonly adjustmentVersion: number;
  readonly controlActorIds: readonly string[];
}

/** 锁定工资追加式更正；只准备差额，不执行补发支付、扣款或税务重报。 */
@Injectable()
export class PayrollAdjustmentService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly approvals: ApprovalApplicationService,
    private readonly strongAuth: WebAuthnService,
    private readonly runs: PayrollRunService,
    private readonly crypto: PayrollDataCryptoService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollPeriodRecord.name)
    private readonly periods: Model<PayrollPeriodDocument>,
    @InjectModel(PayrollCalculationLineRecord.name)
    private readonly calculationLines: Model<PayrollCalculationLineDocument>,
    @InjectModel(PayrollAdjustmentRecord.name)
    private readonly adjustments: Model<PayrollAdjustmentDocument>,
  ) {}

  async prepare(
    key: string,
    input: PreparePayrollAdjustmentInput,
  ): Promise<PayrollAdjustmentSummary> {
    this.assertPrepareActor();
    assertPrepareInput(input);
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment.prepare', key, input, async (session) => {
        const period = await this.periods.findOne({
          tenantId: this.tenantId(), id: input.periodId,
        }).session(session).lean().exec();
        if (period === null) throw new NotFoundException({
          code: 'PAYROLL_ADJUSTMENT_PERIOD_NOT_FOUND', message: '工资调整原周期不存在',
        });
        if (!['locked', 'disbursing', 'reconciling', 'reconciled'].includes(period.status) ||
          period.activeRunId === null) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_PERIOD_NOT_LOCKED',
          message: '只有已锁定或后续终态工资周期可准备调整',
        });
        const originalLine = await this.calculationLines.findOne({
          tenantId: this.tenantId(), id: input.originalCalculationLineId,
          periodId: period.id, runId: period.activeRunId,
          employeeId: input.correctedLine.employeeId,
        }).session(session).lean().exec();
        if (originalLine === null) throw new NotFoundException({
          code: 'PAYROLL_ADJUSTMENT_ORIGINAL_LINE_NOT_FOUND',
          message: '活动锁定运行中不存在声明的原工资行',
        });
        const prior = await this.adjustments.findOne({
          tenantId: this.tenantId(),
          originalCalculationLineId: originalLine.id,
        }).sort({ adjustmentNumber: -1 }).session(session).lean().exec();
        if (prior !== null && prior.status !== 'cancelled') throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_ACTIVE_CHAIN_EXISTS',
          message: '原工资行已有未取消调整，必须先完成或关闭既有控制链',
        });
        const adjustmentNumber = (prior?.adjustmentNumber ?? 0) + 1;
        const original = resultSchema.parse(this.crypto.unprotect({
          tenantId: this.tenantId(), resourceType: 'calculation_line',
          resourceId: originalLine.id, version: 1,
        }, protectedValue(originalLine))) as PayrollCalculationResult;
        if (original.resultHash !== originalLine.resultHash) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_ORIGINAL_LINE_INTEGRITY_FAILED',
          message: '原工资行控制摘要与密文不一致',
        });
        const corrected = await this.runs.calculateAdjustmentCandidate(
          period, input.rulePackId, input.rulePackVersion, input.correctedLine, session,
        );
        const adjustment = createPayrollAdjustment({
          tenantId: this.tenantId(), employeeId: originalLine.employeeId,
          period: period.period, originalCalculationLineId: originalLine.id,
          reasonCode: input.reasonCode,
          originalPeriodStatus: period.status as
            | 'locked' | 'disbursing' | 'reconciling' | 'reconciled',
          original, corrected: corrected.result,
        });
        const now = new Date();
        const id = createEventId(now);
        const protectedData = this.crypto.protect({
          tenantId: this.tenantId(), resourceType: 'payroll_adjustment',
          resourceId: id, version: 1,
        }, {
          originalResult: original,
          correctedInput: corrected.input,
          correctedResult: corrected.result,
          attendanceSnapshotHash: corrected.attendanceSnapshotHash,
          adjustment,
        });
        const record = {
          id, tenantId: this.tenantId(), periodId: period.id, period: period.period,
          originalRunId: period.activeRunId,
          originalCalculationLineId: originalLine.id,
          employeeId: originalLine.employeeId, adjustmentNumber,
          type: adjustment.type, reasonCode: adjustment.reasonCode,
          originalResultHash: adjustment.originalResultHash,
          correctedInputHash: adjustment.correctedInputHash,
          correctedResultHash: adjustment.correctedResultHash,
          adjustmentHash: adjustment.adjustmentHash,
          grossDeltaMinor: adjustment.delta.grossPayMinor,
          taxDeltaMinor: adjustment.delta.withholdingTaxMinor,
          netDeltaMinor: adjustment.delta.netPayMinor,
          payableMinor: adjustment.payableMinor,
          receivableMinor: adjustment.receivableMinor,
          preparedBy: this.context.getActorRequired().actorId,
          requestedBy: null, approvalInstanceId: null,
          approvalDecidedBy: null, approvalEvidenceId: null,
          lockedBy: null, strongAuthEvidenceId: null,
          cashSettlementStatus:
            adjustment.type === 'tax_only' ? 'not_required' as const : 'pending' as const,
          taxCorrectionStatus: taxCorrectionRequired(adjustment)
            ? 'pending' as const
            : 'not_required' as const,
          cashSettlementReferenceType: null,
          cashSettlementReferenceId: null,
          cashSettlementEvidenceId: null,
          taxCorrectionFilingId: null,
          status: 'prepared' as const, version: 1,
          dataKeyId: protectedData.keyId, dataIv: protectedData.iv,
          dataCiphertext: protectedData.ciphertext, dataAuthTag: protectedData.authTag,
          createdAt: now, updatedAt: now,
        };
        await this.adjustments.create([record], { session });
        await this.outbox.append({
          type: 'payroll.adjustment.prepared', tenantId: this.tenantId(),
          aggregateId: id, version: 1, occurredAt: now.toISOString(),
          data: {
            period: period.period, type: adjustment.type,
            reasonCode: adjustment.reasonCode, status: 'prepared',
            adjustmentHash: adjustment.adjustmentHash,
          },
        }, session);
        return summary(record);
      },
    ));
  }

  /** R2：人工薪酬人员将已准备差额绑定到专用审批模板，不接收任何调整金额。 */
  async requestApproval(
    key: string,
    id: string,
    expectedVersion: number,
  ): Promise<PayrollAdjustmentSummary> {
    this.assertScope('erp:payroll:adjustment:approval:request');
    this.assertScope('erp:approval:instance:submit');
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'user') throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_APPROVAL_HUMAN_REQUIRED',
      message: '工资调整送审只能由已验证人员执行',
    });
    const current = await this.requireAdjustment(id);
    assertApprovalRequestState(controlFromRecord(current), expectedVersion, actor.actorId);
    const created = await this.approvals.createInstance(deriveKey(key, 'create'), {
      templateCode: 'payroll_adjustment_approval',
      title: `工资调整审批：${current.period} #${current.adjustmentNumber}`,
      formData: {
        adjustment_id: current.id,
        adjustment_hash: current.adjustmentHash,
        period: current.period,
        adjustment_type: current.type,
        reason_code: current.reasonCode,
      },
    });
    const submitted = await this.approvals.submitInstance(
      created.instance.id,
      created.instance.version,
      deriveKey(key, 'submit'),
    );
    if (submitted.instance.status !== 'running' && submitted.instance.status !== 'approved') {
      throw new ConflictException({
        code: 'PAYROLL_ADJUSTMENT_APPROVAL_SUBMIT_INVALID',
        message: '工资调整审批未进入可处理状态',
      });
    }
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment.approval.request',
      deriveKey(key, 'bind'),
      { id, expectedVersion, approvalInstanceId: submitted.instance.id },
      async (session) => {
        const fresh = await this.requireAdjustment(id, session);
        const next = requestPayrollAdjustmentApproval(controlFromRecord(fresh), {
          tenantId: this.tenantId(),
          expectedVersion,
          requestedBy: actor.actorId,
          approvalInstanceId: submitted.instance.id,
        });
        await this.replaceControl(fresh, next, session);
        await this.outbox.append({
          type: 'payroll.adjustment.approval_requested',
          tenantId: this.tenantId(),
          aggregateId: id,
          version: next.version,
          occurredAt: new Date().toISOString(),
          data: adjustmentEventData(fresh, next.status),
        }, session);
        return summary({ ...fresh, ...next });
      },
    ));
  }

  /** 只同步 Approval 专用模板形成的可信终态，拒绝任意客户端批准声明。 */
  async applyApproval(
    key: string,
    id: string,
    expectedVersion: number,
    approvalInstanceId: string,
  ): Promise<PayrollAdjustmentSummary> {
    this.assertScope('erp:payroll:adjustment:approval:sync');
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'PAYROLL_ADJUSTMENT_APPROVAL_SERVICE_REQUIRED',
        message: '工资调整审批同步只允许受信任服务执行',
      });
    }
    const decision = await this.approvals.getPayrollAdjustmentDecision(approvalInstanceId);
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment.approval.apply',
      key,
      { id, expectedVersion, approvalInstanceId, decision: decision.formDataHash },
      async (session) => {
        const current = await this.requireAdjustment(id, session);
        if (
          decision.adjustmentId !== current.id ||
          decision.adjustmentHash !== current.adjustmentHash ||
          decision.period !== current.period ||
          decision.adjustmentType !== current.type ||
          decision.reasonCode !== current.reasonCode
        ) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_APPROVAL_BINDING_MISMATCH',
          message: '审批实例与工资调整控制摘要不匹配',
        });
        const next = applyPayrollAdjustmentApproval(controlFromRecord(current), {
          tenantId: this.tenantId(),
          expectedVersion,
          approvalInstanceId: decision.id,
          outcome: decision.outcome,
          decidedBy: decision.decidedBy,
          approvalEvidenceId: decision.id,
          trustedApproval: true,
        });
        await this.replaceControl(current, next, session);
        await this.outbox.append({
          type: 'payroll.adjustment.approval_applied',
          tenantId: this.tenantId(),
          aggregateId: id,
          version: next.version,
          occurredAt: new Date(decision.completedAt).toISOString(),
          data: {
            ...adjustmentEventData(current, next.status),
            outcome: decision.outcome,
          },
        }, session);
        return summary({ ...current, ...next });
      },
    ));
  }

  /** R3：独立人员以绑定调整 ID 的近期 WebAuthn UV 锁定，MCP 永不注册此动作。 */
  async lock(
    key: string,
    id: string,
    expectedVersion: number,
    evidenceId: string,
    token: VerifiedAccessToken,
  ): Promise<PayrollAdjustmentSummary> {
    this.assertScope('erp:payroll:adjustment:lock');
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'user' || token.actorType !== 'user' ||
      token.tenantId !== this.tenantId() || token.actorId !== actor.actorId
    ) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_LOCK_IDENTITY_INVALID',
      message: '工资调整锁定身份上下文非法',
    });
    if (!ULID.test(id) || !ULID.test(evidenceId)) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_LOCK_EVIDENCE_INVALID',
      message: '工资调整或强认证证据标识非法',
    });
    const evidence = await this.strongAuth.requireVerifiedEvidence({
      evidenceId,
      tenantId: token.tenantId,
      actorId: token.actorId,
      sessionId: token.sessionId,
      operationId: id,
    });
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment.lock',
      key,
      { id, expectedVersion, evidenceId: evidence.evidenceId },
      async (session) => {
        const current = await this.requireAdjustment(id, session);
        const next = lockPayrollAdjustment(controlFromRecord(current), {
          tenantId: this.tenantId(),
          expectedVersion,
          lockedBy: actor.actorId,
          strongAuthEvidenceId: evidence.evidenceId,
        });
        await this.replaceControl(current, next, session);
        await this.outbox.append({
          type: 'payroll.adjustment.locked',
          tenantId: this.tenantId(),
          aggregateId: id,
          version: next.version,
          occurredAt: new Date().toISOString(),
          data: {
            ...adjustmentEventData(current, next.status),
            strongAuthMethod: evidence.method,
          },
        }, session);
        if (
          current.cashSettlementStatus === 'not_required' &&
          current.taxCorrectionStatus === 'not_required'
        ) {
          const settled = await this.adjustments.updateOne({
            tenantId: this.tenantId(),
            id,
            status: 'locked',
            version: next.version,
          }, { $set: {
            status: 'settled',
            version: next.version + 1,
          } }, { session, runValidators: true });
          if (settled.modifiedCount !== 1) throw new ConflictException({
            code: 'PAYROLL_ADJUSTMENT_IMMEDIATE_SETTLEMENT_WRITE_CONFLICT',
            message: '无需现金和税务动作的工资调整结算发生并发冲突',
          });
          await this.outbox.append({
            type: 'payroll.adjustment.settled',
            tenantId: this.tenantId(),
            aggregateId: id,
            version: next.version + 1,
            occurredAt: new Date().toISOString(),
            data: adjustmentEventData(current, 'settled'),
          }, session);
          return summary({
            ...current,
            ...next,
            status: 'settled',
            version: next.version + 1,
          });
        }
        return summary({ ...current, ...next });
      },
    ));
  }

  async get(id: string): Promise<PayrollAdjustmentSummary> {
    this.assertScope('erp:payroll:adjustment:read');
    return summary(await this.requireVerifiedAdjustment(id));
  }

  /** Treasury 只在同一可信身份上下文内读取已锁定正向差额，不暴露密文或更正输入。 */
  async getLockedSupplementSource(
    id: string,
    expectedVersion: number,
    session?: ClientSession,
  ): Promise<LockedPayrollSupplementSource> {
    this.assertScope('erp:treasury:adjustment:source:read');
    const record = await this.requireVerifiedAdjustment(id, session);
    if (
      record.status !== 'locked' ||
      record.version !== expectedVersion ||
      record.type !== 'supplement' ||
      record.cashSettlementStatus !== 'pending' ||
      record.payableMinor < 1 ||
      record.receivableMinor !== 0 ||
      record.lockedBy === null
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_SUPPLEMENT_SOURCE_INVALID',
      message: '只有已锁定且版本一致的正向工资调整可进入补发链',
    });
    const actors = [
      record.preparedBy,
      record.requestedBy,
      record.approvalDecidedBy,
      record.lockedBy,
    ].filter((value): value is string => typeof value === 'string');
    return Object.freeze({
      adjustmentId: record.id,
      adjustmentHash: record.adjustmentHash,
      periodId: record.periodId,
      period: record.period,
      payrollRunId: record.originalRunId,
      originalCalculationLineId: record.originalCalculationLineId,
      employeeId: record.employeeId,
      correctedResultHash: record.correctedResultHash,
      payableMinor: record.payableMinor,
      adjustmentVersion: record.version,
      controlActorIds: Object.freeze([...new Set(actors)]),
      lockedBy: record.lockedBy,
    });
  }

  /** 应收服务只在同一事务中读取已锁定负向差额，不暴露更正输入或密文。 */
  async getLockedReversalSource(
    id: string,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<LockedPayrollReversalSource> {
    this.assertScope('erp:payroll:adjustment:receivable:source:read');
    const record = await this.requireVerifiedAdjustment(id, session);
    if (
      record.status !== 'locked' ||
      record.version !== expectedVersion ||
      record.type !== 'reversal' ||
      record.cashSettlementStatus !== 'pending' ||
      record.cashSettlementReferenceType !== null ||
      record.cashSettlementReferenceId !== null ||
      record.receivableMinor < 1 ||
      record.payableMinor !== 0
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SOURCE_INVALID',
      message: '只有已锁定、未建应收且版本一致的负向工资调整可进入员工应收链',
    });
    const actors = [
      record.preparedBy,
      record.requestedBy,
      record.approvalDecidedBy,
      record.lockedBy,
    ].filter((value): value is string => typeof value === 'string');
    return Object.freeze({
      adjustmentId: record.id,
      adjustmentHash: record.adjustmentHash,
      period: record.period,
      employeeId: record.employeeId,
      receivableMinor: record.receivableMinor,
      adjustmentVersion: record.version,
      controlActorIds: Object.freeze([...new Set(actors)]),
    });
  }

  /** 税务服务只在同一事务内读取完整验证后的待更正税额。 */
  async getLockedTaxCorrectionSource(
    id: string,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<LockedPayrollTaxCorrectionSource> {
    this.assertScope('erp:payroll:adjustment:tax_correction:source:read');
    const { record, bundle } = await this.requireVerifiedAdjustmentBundle(id, session);
    if (
      record.status !== 'locked' ||
      record.version !== expectedVersion ||
      record.taxCorrectionStatus !== 'pending' ||
      record.taxCorrectionFilingId !== null
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SOURCE_INVALID',
      message: '只有已锁定、未建更正清单且版本一致的工资调整可进入税务更正链',
    });
    const actors = [
      record.preparedBy,
      record.requestedBy,
      record.approvalDecidedBy,
      record.lockedBy,
    ].filter((value): value is string => typeof value === 'string');
    return Object.freeze({
      adjustmentId: record.id,
      adjustmentHash: record.adjustmentHash,
      period: record.period,
      employeeId: record.employeeId,
      reasonCode: record.reasonCode,
      originalResultHash: record.originalResultHash,
      correctedResultHash: record.correctedResultHash,
      originalTaxableEarningsMinor: bundle.originalResult.taxableEarningsMinor,
      correctedTaxableEarningsMinor: bundle.correctedResult.taxableEarningsMinor,
      originalWithholdingTaxMinor: bundle.originalResult.withholdingTaxMinor,
      correctedWithholdingTaxMinor: bundle.correctedResult.withholdingTaxMinor,
      taxableEarningsDeltaMinor: bundle.adjustment.delta.taxableEarningsMinor,
      withholdingTaxDeltaMinor: bundle.adjustment.delta.withholdingTaxMinor,
      cumulativeTaxWithheldDeltaMinor:
        bundle.adjustment.delta.cumulativeAfter.taxWithheldMinor,
      adjustmentVersion: record.version,
      controlActorIds: Object.freeze([...new Set(actors)]),
    });
  }

  /** 更正清单写入事务内绑定唯一清单标识，状态仍为 pending。 */
  async recordTaxCorrectionPrepared(
    input: {
      readonly adjustmentId: string;
      readonly adjustmentHash: string;
      readonly filingId: string;
      readonly expectedVersion: number;
    },
    session: ClientSession,
  ): Promise<void> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'user' ||
      !actor.scopes.includes('erp:payroll:adjustment:tax_correction:prepare')
    ) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_PREPARER_DENIED',
      message: '工资调整税务更正只能由受控人工税务制备人绑定',
    });
    if (
      !ULID.test(input.adjustmentId) ||
      !HASH.test(input.adjustmentHash) ||
      !ULID.test(input.filingId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_BINDING_INVALID',
      message: '工资调整税务更正绑定参数非法',
    });
    const record = await this.requireVerifiedAdjustment(input.adjustmentId, session);
    if (
      record.status !== 'locked' ||
      record.version !== input.expectedVersion ||
      record.adjustmentHash !== input.adjustmentHash ||
      record.taxCorrectionStatus !== 'pending' ||
      record.taxCorrectionFilingId !== null
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_BINDING_CONFLICT',
      message: '工资调整状态与税务更正清单绑定不一致',
    });
    const updated = await this.adjustments.updateOne({
      tenantId: this.tenantId(),
      id: record.id,
      status: 'locked',
      version: record.version,
      taxCorrectionStatus: 'pending',
      taxCorrectionFilingId: null,
    }, { $set: {
      taxCorrectionFilingId: input.filingId,
      version: record.version + 1,
    } }, { session, runValidators: true });
    if (updated.modifiedCount !== 1) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_BINDING_WRITE_CONFLICT',
      message: '工资调整税务更正绑定发生并发冲突',
    });
    await this.outbox.append({
      type: 'payroll.adjustment.tax_correction_prepared',
      tenantId: this.tenantId(),
      aggregateId: record.id,
      version: record.version + 1,
      occurredAt: new Date().toISOString(),
      data: adjustmentEventData(record, 'locked'),
    }, session);
  }

  /** 税局受理回执落库后回写税务终态；现金未终结时整体仍保持 locked。 */
  async recordTaxCorrectionSubmitted(
    input: {
      readonly adjustmentId: string;
      readonly adjustmentHash: string;
      readonly filingId: string;
    },
    session: ClientSession,
  ): Promise<void> {
    const actor = this.context.getActorRequired();
    if (
      !['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:payroll:adjustment:tax_correction:submit')
    ) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMITTER_DENIED',
      message: '工资调整税务终态只接受受信任税务连接器',
    });
    if (
      !ULID.test(input.adjustmentId) ||
      !HASH.test(input.adjustmentHash) ||
      !ULID.test(input.filingId)
    ) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_INVALID',
      message: '工资调整税务更正终态引用非法',
    });
    const record = await this.requireVerifiedAdjustment(input.adjustmentId, session);
    if (
      record.status !== 'locked' ||
      record.adjustmentHash !== input.adjustmentHash ||
      record.taxCorrectionStatus !== 'pending' ||
      record.taxCorrectionFilingId !== input.filingId
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_CONFLICT',
      message: '工资调整与税务更正受理终态不一致',
    });
    const status = record.cashSettlementStatus === 'pending' ? 'locked' : 'settled';
    const updated = await this.adjustments.updateOne({
      tenantId: this.tenantId(),
      id: record.id,
      status: 'locked',
      version: record.version,
      taxCorrectionStatus: 'pending',
      taxCorrectionFilingId: input.filingId,
    }, { $set: {
      taxCorrectionStatus: 'submitted',
      status,
      version: record.version + 1,
    } }, { session, runValidators: true });
    if (updated.modifiedCount !== 1) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_TAX_CORRECTION_SUBMISSION_WRITE_CONFLICT',
      message: '工资调整税务更正终态写入发生并发冲突',
    });
    await this.outbox.append({
      type: 'payroll.adjustment.tax_correction_submitted',
      tenantId: this.tenantId(),
      aggregateId: record.id,
      version: record.version + 1,
      occurredAt: new Date().toISOString(),
      data: adjustmentEventData(record, status),
    }, session);
  }

  /** 同一事务内把唯一员工应收绑定回负向调整，但现金仍保持 pending。 */
  async recordReceivableOpened(
    input: {
      readonly adjustmentId: string;
      readonly adjustmentHash: string;
      readonly receivableId: string;
      readonly expectedVersion: number;
    },
    session: ClientSession,
  ): Promise<void> {
    if (
      !ULID.test(input.adjustmentId) ||
      !HASH.test(input.adjustmentHash) ||
      !ULID.test(input.receivableId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_BINDING_INVALID',
      message: '工资调整应收绑定参数非法',
    });
    const record = await this.requireVerifiedAdjustment(input.adjustmentId, session);
    if (
      record.status !== 'locked' ||
      record.version !== input.expectedVersion ||
      record.type !== 'reversal' ||
      record.adjustmentHash !== input.adjustmentHash ||
      record.cashSettlementStatus !== 'pending' ||
      record.cashSettlementReferenceType !== null ||
      record.cashSettlementReferenceId !== null ||
      record.receivableMinor < 1
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_BINDING_CONFLICT',
      message: '工资调整状态与应收绑定不一致',
    });
    const updated = await this.adjustments.updateOne({
      tenantId: this.tenantId(),
      id: record.id,
      status: 'locked',
      version: record.version,
      cashSettlementStatus: 'pending',
      cashSettlementReferenceType: null,
      cashSettlementReferenceId: null,
    }, { $set: {
      cashSettlementReferenceType: 'receivable',
      cashSettlementReferenceId: input.receivableId,
      version: record.version + 1,
    } }, { session, runValidators: true });
    if (updated.modifiedCount !== 1) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_BINDING_WRITE_CONFLICT',
      message: '工资调整应收绑定发生并发冲突',
    });
    await this.outbox.append({
      type: 'payroll.adjustment.receivable_opened',
      tenantId: this.tenantId(),
      aggregateId: record.id,
      version: record.version + 1,
      occurredAt: new Date().toISOString(),
      data: adjustmentEventData(record, 'locked'),
    }, session);
  }

  /** 应收余额归零后回写最终恢复凭证；税务未更正时整体仍保持 locked。 */
  async recordReceivableSettled(
    input: {
      readonly adjustmentId: string;
      readonly adjustmentHash: string;
      readonly receivableId: string;
      readonly recoveryId: string;
    },
    session: ClientSession,
  ): Promise<void> {
    if (
      !ULID.test(input.adjustmentId) ||
      !HASH.test(input.adjustmentHash) ||
      !ULID.test(input.receivableId) ||
      !ULID.test(input.recoveryId)
    ) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SETTLEMENT_INVALID',
      message: '工资调整应收结算引用非法',
    });
    const record = await this.requireVerifiedAdjustment(input.adjustmentId, session);
    if (
      record.status !== 'locked' ||
      record.type !== 'reversal' ||
      record.adjustmentHash !== input.adjustmentHash ||
      record.cashSettlementStatus !== 'pending' ||
      record.cashSettlementReferenceType !== 'receivable' ||
      record.cashSettlementReferenceId !== input.receivableId ||
      record.cashSettlementEvidenceId !== null
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SETTLEMENT_CONFLICT',
      message: '工资调整与员工应收终态不一致',
    });
    const status = record.taxCorrectionStatus === 'pending' ? 'locked' : 'settled';
    const updated = await this.adjustments.updateOne({
      tenantId: this.tenantId(),
      id: record.id,
      status: 'locked',
      version: record.version,
      cashSettlementStatus: 'pending',
      cashSettlementReferenceType: 'receivable',
      cashSettlementReferenceId: input.receivableId,
      cashSettlementEvidenceId: null,
    }, { $set: {
      cashSettlementStatus: 'settled',
      cashSettlementEvidenceId: input.recoveryId,
      status,
      version: record.version + 1,
    } }, { session, runValidators: true });
    if (updated.modifiedCount !== 1) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SETTLEMENT_WRITE_CONFLICT',
      message: '工资调整应收结算发生并发冲突',
    });
    await this.outbox.append({
      type: 'payroll.adjustment.cash_settled',
      tenantId: this.tenantId(),
      aggregateId: record.id,
      version: record.version + 1,
      occurredAt: new Date().toISOString(),
      data: adjustmentEventData(record, status),
    }, session);
  }

  /**
   * Treasury 回盘事务内回写正向现金结算证据。
   * 税务更正未提交时只完成现金侧，不把整个调整伪记为 settled。
   */
  async recordSupplementBankReturn(
    input: {
      readonly adjustmentId: string;
      readonly adjustmentHash: string;
      readonly batchId: string;
      readonly returnId: string;
      readonly successfulMinor: number;
    },
    session: ClientSession,
  ): Promise<void> {
    const actor = this.context.getActorRequired();
    if (
      !['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:treasury:return:ingest')
    ) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_SETTLEMENT_WRITER_DENIED',
      message: '工资调整现金结算只接受受信任 Treasury 回盘服务',
    });
    if (
      !ULID.test(input.adjustmentId) ||
      !HASH.test(input.adjustmentHash) ||
      !ULID.test(input.batchId) ||
      !ULID.test(input.returnId) ||
      !Number.isSafeInteger(input.successfulMinor) ||
      input.successfulMinor < 1
    ) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_SETTLEMENT_INPUT_INVALID',
      message: '工资调整现金结算引用或金额非法',
    });
    const record = await this.requireVerifiedAdjustment(input.adjustmentId, session);
    if (
      record.status !== 'locked' ||
      record.type !== 'supplement' ||
      record.adjustmentHash !== input.adjustmentHash ||
      record.cashSettlementStatus !== 'pending' ||
      record.payableMinor !== input.successfulMinor ||
      record.receivableMinor !== 0
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_SETTLEMENT_STATE_INVALID',
      message: '工资调整与补发终态回盘不一致',
    });
    const status = record.taxCorrectionStatus === 'pending' ? 'locked' : 'settled';
    const updated = await this.adjustments.updateOne({
      tenantId: this.tenantId(),
      id: record.id,
      status: 'locked',
      version: record.version,
      cashSettlementStatus: 'pending',
    }, { $set: {
      cashSettlementStatus: 'settled',
      cashSettlementReferenceType: 'treasury_batch',
      cashSettlementReferenceId: input.batchId,
      cashSettlementEvidenceId: input.returnId,
      status,
      version: record.version + 1,
    } }, { session, runValidators: true });
    if (updated.modifiedCount !== 1) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_SETTLEMENT_WRITE_CONFLICT',
      message: '工资调整现金结算发生并发冲突',
    });
    await this.outbox.append({
      type: 'payroll.adjustment.cash_settled',
      tenantId: this.tenantId(),
      aggregateId: record.id,
      version: record.version + 1,
      occurredAt: new Date().toISOString(),
      data: adjustmentEventData(record, status),
    }, session);
  }

  private async requireVerifiedAdjustment(
    id: string,
    session?: ClientSession,
  ): Promise<PayrollAdjustmentRecord> {
    return (await this.requireVerifiedAdjustmentBundle(id, session)).record;
  }

  private async requireVerifiedAdjustmentBundle(
    id: string,
    session?: ClientSession,
  ): Promise<{
    readonly record: PayrollAdjustmentRecord;
    readonly bundle: z.infer<typeof adjustmentBundleSchema>;
  }> {
    const record = await this.requireAdjustment(id, session);
    const bundle = adjustmentBundleSchema.parse(
      this.crypto.unprotect({
        tenantId: this.tenantId(), resourceType: 'payroll_adjustment',
        resourceId: record.id, version: 1,
      }, protectedValue(record)),
    );
    const { adjustmentHash, ...withoutHash } = bundle.adjustment;
    if (
      payrollDigest({
        tenantId: record.tenantId, employeeId: record.employeeId,
        period: record.period, ...withoutHash,
      }) !== adjustmentHash ||
      adjustmentHash !== record.adjustmentHash ||
      bundle.adjustment.type !== record.type ||
      bundle.adjustment.reasonCode !== record.reasonCode ||
      bundle.adjustment.originalResultHash !== record.originalResultHash ||
      bundle.adjustment.correctedInputHash !== record.correctedInputHash ||
      bundle.adjustment.correctedResultHash !== record.correctedResultHash ||
      bundle.originalResult.resultHash !== record.originalResultHash ||
      bundle.correctedResult.resultHash !== record.correctedResultHash ||
      bundle.adjustment.delta.grossPayMinor !== record.grossDeltaMinor ||
      bundle.adjustment.delta.withholdingTaxMinor !== record.taxDeltaMinor ||
      bundle.adjustment.delta.netPayMinor !== record.netDeltaMinor ||
      bundle.adjustment.payableMinor !== record.payableMinor ||
      bundle.adjustment.receivableMinor !== record.receivableMinor
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_RECORD_INTEGRITY_FAILED',
      message: '工资调整控制字段与密文不一致',
    });
    return Object.freeze({ record, bundle });
  }

  /** AI/控制面只读脱敏摘要；先执行完整密文一致性验证再删去人员与金额。 */
  async getControlStatus(id: string): Promise<PayrollAdjustmentControlSummary> {
    const value = await this.get(id);
    return Object.freeze({
      id: value.id, period: value.period,
      adjustmentNumber: value.adjustmentNumber, type: value.type,
      reasonCode: value.reasonCode, status: value.status,
      cashSettlementStatus: value.cashSettlementStatus,
      taxCorrectionStatus: value.taxCorrectionStatus,
      version: value.version, adjustmentHash: value.adjustmentHash,
    });
  }

  private async requireAdjustment(
    id: string,
    session?: ClientSession,
  ): Promise<PayrollAdjustmentRecord> {
    if (!ULID.test(id)) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_ID_INVALID', message: '工资调整标识非法',
    });
    const query = this.adjustments.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'PAYROLL_ADJUSTMENT_NOT_FOUND', message: '工资调整不存在',
    });
    return record;
  }

  private async replaceControl(
    current: PayrollAdjustmentRecord,
    next: PayrollAdjustmentControl,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.adjustments.updateOne(
      {
        tenantId: this.tenantId(),
        id: current.id,
        version: current.version,
        status: current.status,
      },
      {
        $set: {
          status: next.status,
          requestedBy: next.requestedBy,
          approvalInstanceId: next.approvalInstanceId,
          approvalDecidedBy: next.approvalDecidedBy,
          approvalEvidenceId: next.approvalEvidenceId,
          lockedBy: next.lockedBy,
          strongAuthEvidenceId: next.strongAuthEvidenceId,
          version: next.version,
        },
      },
      { session, runValidators: true },
    );
    if (result.modifiedCount !== 1) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_WRITE_CONFLICT',
      message: '工资调整发生并发写入冲突',
    });
  }

  private assertPrepareActor(): void {
    this.assertScope('erp:payroll:adjustment:prepare');
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType)) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_SERVICE_REQUIRED',
      message: '工资更正重算只允许受信任计算服务执行',
    });
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'AUTH_SCOPE_DENIED', message: '缺少工资调整权限',
    });
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PayrollAdjustmentError) {
        if (error.code.includes('INDEPENDENCE') || error.code.includes('TENANT')) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        if (
          error.code.includes('UNCHANGED') ||
          error.code.includes('ZERO') ||
          error.code.includes('VERSION') ||
          error.code.includes('TRANSITION') ||
          error.code.includes('UNTRUSTED')
        ) {
          throw new ConflictException({ code: error.code, message: error.message });
        }
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (error instanceof z.ZodError) throw new ConflictException({
        code: 'PAYROLL_ADJUSTMENT_PROTECTED_DATA_INVALID',
        message: '工资调整原结果密文结构非法',
      });
      if (isDuplicateKeyError(error)) throw new ConflictException({
        code: 'PAYROLL_ADJUSTMENT_WRITE_CONFLICT',
        message: '工资调整编号或标识冲突',
      });
      throw error;
    }
  }
}

function assertPrepareInput(input: PreparePayrollAdjustmentInput): void {
  const lineKeys = Object.keys(input.correctedLine).sort().join(',');
  const profileIds = [
    input.correctedLine.compensationProfileId,
    ...(input.correctedLine.additionalCompensationProfileIds ?? []),
  ];
  if (Object.keys(input).sort().join(',') !==
      'correctedLine,originalCalculationLineId,periodId,reasonCode,rulePackId,rulePackVersion' ||
    !ULID.test(input.periodId) || !ULID.test(input.originalCalculationLineId) ||
    !ULID.test(input.rulePackId) || !REASON.test(input.reasonCode) ||
    !Number.isSafeInteger(input.rulePackVersion) || input.rulePackVersion < 1 ||
    ![
      'attendanceSnapshotId,compensationProfileId,employeeId',
      'additionalCompensationProfileIds,attendanceSnapshotId,compensationProfileId,employeeId',
    ].includes(lineKeys) ||
    !ID.test(input.correctedLine.employeeId) ||
    !ID.test(input.correctedLine.attendanceSnapshotId) ||
    profileIds.length < 1 || profileIds.length > 31 ||
    profileIds.some((value) => !ID.test(value)) ||
    new Set(profileIds).size !== profileIds.length) {
    throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_INPUT_INVALID',
      message: '工资调整只接受规范引用、原因码与规则版本',
    });
  }
}

function summary(record: PayrollAdjustmentRecord): PayrollAdjustmentSummary {
  return Object.freeze({
    id: record.id, periodId: record.periodId, period: record.period,
    originalCalculationLineId: record.originalCalculationLineId,
    adjustmentNumber: record.adjustmentNumber, type: record.type,
    reasonCode: record.reasonCode, status: record.status, version: record.version,
    adjustmentHash: record.adjustmentHash,
    grossDeltaMinor: record.grossDeltaMinor, taxDeltaMinor: record.taxDeltaMinor,
    netDeltaMinor: record.netDeltaMinor, payableMinor: record.payableMinor,
    receivableMinor: record.receivableMinor,
    approvalInstanceId: record.approvalInstanceId ?? null,
    cashSettlementStatus: record.cashSettlementStatus,
    taxCorrectionStatus: record.taxCorrectionStatus,
  });
}

function assertApprovalRequestState(
  control: PayrollAdjustmentControl,
  expectedVersion: number,
  requestedBy: string,
): void {
  if (control.tenantId.length === 0) throw new BadRequestException({
    code: 'PAYROLL_ADJUSTMENT_TENANT_INVALID', message: '工资调整租户非法',
  });
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== control.version ||
    control.status !== 'prepared') throw new ConflictException({
    code: 'PAYROLL_ADJUSTMENT_APPROVAL_REQUEST_STATE_CHANGED',
    message: '工资调整版本或准备状态已变化',
  });
  if (!ID.test(requestedBy) || requestedBy === control.preparedBy) throw new ForbiddenException({
    code: 'PAYROLL_ADJUSTMENT_REQUESTER_INDEPENDENCE_REQUIRED',
    message: '调整送审人与重算服务必须分离',
  });
}

function controlFromRecord(record: PayrollAdjustmentRecord): PayrollAdjustmentControl {
  return Object.freeze({
    id: record.id,
    tenantId: record.tenantId,
    status: record.status,
    preparedBy: record.preparedBy,
    requestedBy: record.requestedBy ?? null,
    approvalInstanceId: record.approvalInstanceId ?? null,
    approvalDecidedBy: record.approvalDecidedBy ?? null,
    approvalEvidenceId: record.approvalEvidenceId ?? null,
    lockedBy: record.lockedBy ?? null,
    strongAuthEvidenceId: record.strongAuthEvidenceId ?? null,
    version: record.version,
  });
}

function adjustmentEventData(
  record: PayrollAdjustmentRecord,
  status: PayrollAdjustmentSummary['status'],
): Readonly<Record<string, string>> {
  return Object.freeze({
    period: record.period,
    type: record.type,
    reasonCode: record.reasonCode,
    status,
    adjustmentHash: record.adjustmentHash,
  });
}

function deriveKey(root: string, stage: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([root, stage]), 'utf8')
    .digest('base64url');
  return `payroll-adjustment:${digest}`;
}

function taxCorrectionRequired(adjustment: PayrollAdjustmentResult): boolean {
  return adjustment.delta.taxableEarningsMinor !== 0 ||
    adjustment.delta.withholdingTaxMinor !== 0 ||
    Object.values(adjustment.delta.cumulativeAfter).some((value) => value !== 0);
}

function protectedValue(record: {
  readonly dataKeyId: string;
  readonly dataIv: string;
  readonly dataCiphertext: string;
  readonly dataAuthTag: string;
}) {
  return {
    keyId: record.dataKeyId, iv: record.dataIv,
    ciphertext: record.dataCiphertext, authTag: record.dataAuthTag,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { readonly code?: unknown }).code === 11000;
}
