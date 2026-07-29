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
import { LegacyPayrollBoundaryService } from '../legacy-payroll-boundary.service.js';
import { PayrollDataCryptoService } from '../persistence/payroll-data-crypto.service.js';
import { PayrollOutboxWriter } from '../persistence/payroll-outbox.writer.js';
import {
  PayrollAdjustmentReceivableRecord,
  type PayrollAdjustmentReceivableDocument,
  PayrollAdjustmentReceivableRecoveryRecord,
  type PayrollAdjustmentReceivableRecoveryDocument,
} from '../persistence/payroll.schemas.js';
import {
  PayrollAdjustmentService,
  type LockedPayrollReversalSource,
} from './payroll-adjustment.service.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const protectedReceivableSchema = z.object({
  employeeId: z.string().regex(ID),
  adjustmentId: z.string().regex(ULID),
  adjustmentHash: z.string().regex(HASH),
  originalAmountMinor: z.number().int().safe().positive(),
  openedBy: z.string().regex(ID),
}).strict();

export type PayrollAdjustmentRecoveryMethod =
  | 'bank_repayment'
  | 'authorized_payroll_deduction';

export interface OpenPayrollAdjustmentReceivableInput {
  readonly expectedAdjustmentVersion: number;
}

export interface RecordPayrollAdjustmentRecoveryInput {
  readonly expectedReceivableVersion: number;
  readonly method: PayrollAdjustmentRecoveryMethod;
  readonly amountMinor: number;
  readonly sourceReferenceId: string;
  readonly sourceEvidenceId: string;
  readonly legalAuthorizationEvidenceId?: string;
  readonly receivedAt: string;
}

export interface PayrollAdjustmentReceivableSummary extends Record<string, unknown> {
  readonly id: string;
  readonly adjustmentId: string;
  readonly adjustmentHash: string;
  readonly currency: 'CNY';
  readonly originalAmountMinor: number;
  readonly recoveredAmountMinor: number;
  readonly outstandingAmountMinor: number;
  readonly status: 'open' | 'settled';
  readonly version: number;
}

/**
 * 负向工资调整员工应收。
 *
 * 应收来源只取自已锁定调整；恢复只接受受信任服务的银行回款或带法定授权证据的
 * 工资抵扣终态。任何路径都不能创建负数银行支付指令。
 */
@Injectable()
export class PayrollAdjustmentReceivableService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly boundary: LegacyPayrollBoundaryService,
    private readonly adjustments: PayrollAdjustmentService,
    private readonly crypto: PayrollDataCryptoService,
    private readonly outbox: PayrollOutboxWriter,
    @InjectModel(PayrollAdjustmentReceivableRecord.name)
    private readonly receivables: Model<PayrollAdjustmentReceivableDocument>,
    @InjectModel(PayrollAdjustmentReceivableRecoveryRecord.name)
    private readonly recoveries: Model<PayrollAdjustmentReceivableRecoveryDocument>,
  ) {}

  async open(
    key: string,
    adjustmentId: string,
    input: OpenPayrollAdjustmentReceivableInput,
  ): Promise<PayrollAdjustmentReceivableSummary> {
    const actor = this.context.getActorRequired();
    if (
      actor.actorType !== 'user' ||
      !actor.scopes.includes('erp:payroll:adjustment:receivable:open') ||
      !actor.scopes.includes('erp:payroll:adjustment:receivable:source:read')
    ) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_OPENER_DENIED',
      message: '员工应收只允许受控人工财务人员建立',
    });
    this.boundary.assertLegacy();
    if (
      !ULID.test(adjustmentId) ||
      !Number.isSafeInteger(input.expectedAdjustmentVersion) ||
      input.expectedAdjustmentVersion < 1
    ) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_OPEN_INPUT_INVALID',
      message: '员工应收来源调整或版本非法',
    });
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment_receivable.open',
      key,
      { adjustmentId, expectedAdjustmentVersion: input.expectedAdjustmentVersion },
      async (session) => {
        const source = await this.adjustments.getLockedReversalSource(
          adjustmentId,
          input.expectedAdjustmentVersion,
          session,
        );
        if (source.controlActorIds.includes(actor.actorId)) throw new ForbiddenException({
          code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_INDEPENDENCE_REQUIRED',
          message: '应收建立人必须独立于调整重算、送审、审批和锁定控制链',
        });
        return this.createReceivable(source, actor.actorId, session);
      },
    ));
  }

  async recordRecovery(
    key: string,
    receivableId: string,
    input: RecordPayrollAdjustmentRecoveryInput,
  ): Promise<PayrollAdjustmentReceivableSummary> {
    this.assertRecoveryActor(input.method);
    this.boundary.assertLegacy();
    assertRecoveryInput(receivableId, input);
    return this.run(() => this.idempotency.execute(
      'payroll.adjustment_receivable.record_recovery',
      key,
      { receivableId, ...input },
      async (session) => {
        const receivable = await this.requireVerifiedReceivable(receivableId, session);
        if (
          receivable.status !== 'open' ||
          receivable.version !== input.expectedReceivableVersion ||
          input.amountMinor > receivable.outstandingAmountMinor
        ) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_STATE_INVALID',
          message: '员工应收状态、版本或恢复金额不一致',
        });
        const receivedAt = new Date(input.receivedAt);
        if (
          receivedAt.getTime() < receivable.openedAt.getTime() ||
          receivedAt.getTime() > Date.now() + 5 * 60_000
        ) throw new BadRequestException({
          code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_TIME_INVALID',
          message: '员工应收恢复时间早于建账或超出允许时钟偏差',
        });
        const recoveryId = createEventId(receivedAt);
        const actor = this.context.getActorRequired();
        const recoveryHash = digest({
          tenantId: this.tenantId(),
          recoveryId,
          receivableId: receivable.id,
          method: input.method,
          amountMinor: input.amountMinor,
          sourceReferenceId: input.sourceReferenceId,
          sourceEvidenceId: input.sourceEvidenceId,
          legalAuthorizationEvidenceId: input.legalAuthorizationEvidenceId ?? null,
          receivedAt: receivedAt.toISOString(),
        });
        await this.recoveries.create([{
          id: recoveryId,
          tenantId: this.tenantId(),
          receivableId: receivable.id,
          method: input.method,
          amountMinor: input.amountMinor,
          sourceReferenceId: input.sourceReferenceId,
          sourceEvidenceId: input.sourceEvidenceId,
          legalAuthorizationEvidenceId: input.legalAuthorizationEvidenceId ?? null,
          receivedAt,
          recordedBy: actor.actorId,
          recoveryHash,
        }], { session });
        const outstandingAmountMinor =
          receivable.outstandingAmountMinor - input.amountMinor;
        const status = outstandingAmountMinor === 0 ? 'settled' : 'open';
        const updated = await this.receivables.updateOne({
          tenantId: this.tenantId(),
          id: receivable.id,
          status: 'open',
          version: receivable.version,
          outstandingAmountMinor: receivable.outstandingAmountMinor,
        }, { $set: {
          outstandingAmountMinor,
          status,
          settledAt: status === 'settled' ? receivedAt : null,
          version: receivable.version + 1,
        } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) throw new ConflictException({
          code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_WRITE_CONFLICT',
          message: '员工应收恢复发生并发冲突',
        });
        if (status === 'settled') {
          await this.adjustments.recordReceivableSettled({
            adjustmentId: receivable.adjustmentId,
            adjustmentHash: receivable.adjustmentHash,
            receivableId: receivable.id,
            recoveryId,
          }, session);
        }
        await this.outbox.append({
          type: 'payroll.receivable.recovery_recorded',
          tenantId: this.tenantId(),
          aggregateId: receivable.id,
          version: receivable.version + 1,
          occurredAt: receivedAt.toISOString(),
          data: { adjustmentHash: receivable.adjustmentHash, status },
        }, session);
        return summary({
          ...receivable,
          outstandingAmountMinor,
          status,
          version: receivable.version + 1,
        });
      },
    ));
  }

  async get(id: string): Promise<PayrollAdjustmentReceivableSummary> {
    this.assertScope('erp:payroll:adjustment:receivable:read');
    this.boundary.assertLegacy();
    return this.run(async () => summary(await this.requireVerifiedReceivable(id)));
  }

  private async createReceivable(
    source: LockedPayrollReversalSource,
    openedBy: string,
    session: ClientSession,
  ): Promise<PayrollAdjustmentReceivableSummary> {
    const now = new Date();
    const id = createEventId(now);
    const protectedData = this.crypto.protect({
      tenantId: this.tenantId(),
      resourceType: 'adjustment_receivable',
      resourceId: id,
      version: 1,
    }, {
      employeeId: source.employeeId,
      adjustmentId: source.adjustmentId,
      adjustmentHash: source.adjustmentHash,
      originalAmountMinor: source.receivableMinor,
      openedBy,
    });
    const record: PayrollAdjustmentReceivableRecord = {
      id,
      tenantId: this.tenantId(),
      adjustmentId: source.adjustmentId,
      adjustmentHash: source.adjustmentHash,
      currency: 'CNY',
      originalAmountMinor: source.receivableMinor,
      outstandingAmountMinor: source.receivableMinor,
      openedBy,
      openedAt: now,
      settledAt: null,
      status: 'open',
      version: 1,
      dataKeyId: protectedData.keyId,
      dataIv: protectedData.iv,
      dataCiphertext: protectedData.ciphertext,
      dataAuthTag: protectedData.authTag,
      createdAt: now,
      updatedAt: now,
    };
    await this.receivables.create([record], { session });
    await this.adjustments.recordReceivableOpened({
      adjustmentId: source.adjustmentId,
      adjustmentHash: source.adjustmentHash,
      receivableId: id,
      expectedVersion: source.adjustmentVersion,
    }, session);
    await this.outbox.append({
      type: 'payroll.receivable.opened',
      tenantId: this.tenantId(),
      aggregateId: id,
      version: 1,
      occurredAt: now.toISOString(),
      data: { adjustmentHash: source.adjustmentHash, status: 'open' },
    }, session);
    return summary(record);
  }

  private async requireVerifiedReceivable(
    id: string,
    session?: ClientSession,
  ): Promise<PayrollAdjustmentReceivableRecord> {
    if (!ULID.test(id)) throw new BadRequestException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_ID_INVALID',
      message: '员工应收标识非法',
    });
    const query = this.receivables.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    if (record === null) throw new NotFoundException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_NOT_FOUND',
      message: '员工应收不存在',
    });
    const protectedData = protectedReceivableSchema.parse(this.crypto.unprotect({
      tenantId: this.tenantId(),
      resourceType: 'adjustment_receivable',
      resourceId: record.id,
      version: 1,
    }, protectedValue(record)));
    if (
      protectedData.adjustmentId !== record.adjustmentId ||
      protectedData.adjustmentHash !== record.adjustmentHash ||
      protectedData.originalAmountMinor !== record.originalAmountMinor ||
      protectedData.openedBy !== record.openedBy
    ) throw new ConflictException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_INTEGRITY_FAILED',
      message: '员工应收控制字段与密文不一致',
    });
    return record;
  }

  private assertRecoveryActor(method: PayrollAdjustmentRecoveryMethod): void {
    const actor = this.context.getActorRequired();
    if (
      !['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:payroll:adjustment:receivable:settle') ||
      (method === 'authorized_payroll_deduction' &&
        !actor.scopes.includes('erp:payroll:adjustment:receivable:deduction:settle'))
    ) throw new ForbiddenException({
      code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_WRITER_DENIED',
      message: '员工应收恢复只接受对应受信任银行或工资运行连接器',
    });
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({
        code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_SCOPE_REQUIRED',
        message: `缺少必要权限 ${scope}`,
      });
    }
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof z.ZodError) throw new ConflictException({
        code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_PROTECTED_DATA_INVALID',
        message: '员工应收受保护数据非法',
      });
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { readonly code?: unknown }).code === 11_000
      ) throw new ConflictException({
        code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_DUPLICATE_SOURCE',
        message: '工资调整应收、恢复来源或证据已存在',
      });
      throw error;
    }
  }
}

function assertRecoveryInput(
  receivableId: string,
  input: RecordPayrollAdjustmentRecoveryInput,
): void {
  const receivedAt = new Date(input.receivedAt);
  if (
    !ULID.test(receivableId) ||
    !Number.isSafeInteger(input.expectedReceivableVersion) ||
    input.expectedReceivableVersion < 1 ||
    !['bank_repayment', 'authorized_payroll_deduction'].includes(input.method) ||
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor < 1 ||
    !ID.test(input.sourceReferenceId) ||
    !ID.test(input.sourceEvidenceId) ||
    (input.legalAuthorizationEvidenceId !== undefined &&
      !ID.test(input.legalAuthorizationEvidenceId)) ||
    (input.method === 'bank_repayment' &&
      input.legalAuthorizationEvidenceId !== undefined) ||
    (input.method === 'authorized_payroll_deduction' &&
      input.legalAuthorizationEvidenceId === undefined) ||
    !Number.isFinite(receivedAt.getTime()) ||
    receivedAt.toISOString() !== input.receivedAt
  ) throw new BadRequestException({
    code: 'PAYROLL_ADJUSTMENT_RECEIVABLE_RECOVERY_INPUT_INVALID',
    message: '员工应收恢复金额、来源、授权证据或时间非法',
  });
}

function summary(
  record: PayrollAdjustmentReceivableRecord,
): PayrollAdjustmentReceivableSummary {
  return Object.freeze({
    id: record.id,
    adjustmentId: record.adjustmentId,
    adjustmentHash: record.adjustmentHash,
    currency: record.currency,
    originalAmountMinor: record.originalAmountMinor,
    recoveredAmountMinor:
      record.originalAmountMinor - record.outstandingAmountMinor,
    outstandingAmountMinor: record.outstandingAmountMinor,
    status: record.status,
    version: record.version,
  });
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('base64url');
}

function protectedValue(record: PayrollAdjustmentReceivableRecord) {
  return {
    keyId: record.dataKeyId,
    iv: record.dataIv,
    ciphertext: record.dataCiphertext,
    authTag: record.dataAuthTag,
  };
}
