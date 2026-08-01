import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  OpApprovalResultDeliveryRecord,
  type OpApprovalResultDeliveryDocument,
} from '../persistence/op.schemas.js';

export type OpApprovalResultRetryReason =
  | 'credentials_fixed'
  | 'route_fixed'
  | 'provider_recovered'
  | 'approved_exception';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXTERNAL_EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SOURCE_DOCUMENT_TYPE_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{3,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const RETRY_REASONS = [
  'credentials_fixed',
  'route_fixed',
  'provider_recovered',
  'approved_exception',
] as const;
const CREDENTIAL_ERROR_CODES = Object.freeze([
  'OP_APPROVAL_SECRET_REF_INVALID',
  'OP_APPROVAL_OUTBOUND_SECRET_UNAVAILABLE',
]);
const ROUTE_ERROR_CODES = Object.freeze([
  'OP_APPROVAL_ROUTE_DISABLED',
  'OP_APPROVAL_BASE_URL_INVALID',
  'OP_APPROVAL_TARGET_INVALID',
  'OP_APPROVAL_PATH_INVALID',
]);
const terminalProjectionSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  eventId: z.string().regex(ULID_PATTERN),
  externalEventId: z.string().regex(EXTERNAL_EVENT_ID_PATTERN),
  sourceDocumentType: z.string().regex(SOURCE_DOCUMENT_TYPE_PATTERN),
  sourceDocumentId: z.string().regex(ID_PATTERN),
  approvalInstanceId: z.string().regex(ULID_PATTERN),
  approvalVersion: z.number().int().min(3).max(Number.MAX_SAFE_INTEGER),
  result: z.enum(['approved', 'rejected', 'withdrawn']),
  status: z.enum(['manual_review', 'dead']),
  attempts: z.number().int().min(1).max(100),
  operatorRetryCount: z.number().int().min(0).max(100),
  lastErrorCode: z.string().regex(ERROR_CODE_PATTERN),
  updatedAt: z.date(),
}).strict().refine((value) => value.updatedAt.getTime() <= Date.now());
const retryProjectionSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  eventId: z.string().regex(ULID_PATTERN),
  status: z.literal('pending'),
  attempts: z.literal(0),
  operatorRetryCount: z.number().int().min(1).max(100),
  nextAttemptAt: z.date(),
  lockedAt: z.null(),
  lockedBy: z.null(),
  lastErrorCode: z.null(),
  succeededAt: z.null(),
  updatedAt: z.date(),
}).strict().refine((value) =>
  value.nextAttemptAt.getTime() === value.updatedAt.getTime() &&
  value.updatedAt.getTime() <= Date.now(),
);
const TERMINAL_PROJECTION = Object.freeze({
  tenantId: 1,
  eventId: 1,
  externalEventId: 1,
  sourceDocumentType: 1,
  sourceDocumentId: 1,
  approvalInstanceId: 1,
  approvalVersion: 1,
  result: 1,
  status: 1,
  attempts: 1,
  operatorRetryCount: 1,
  lastErrorCode: 1,
  updatedAt: 1,
  _id: 0,
} as const);
const RETRY_PROJECTION = Object.freeze({
  tenantId: 1,
  eventId: 1,
  status: 1,
  attempts: 1,
  operatorRetryCount: 1,
  nextAttemptAt: 1,
  lockedAt: 1,
  lockedBy: 1,
  lastErrorCode: 1,
  succeededAt: 1,
  updatedAt: 1,
  _id: 0,
} as const);

export interface OpApprovalResultDeliveryView {
  readonly eventId: string;
  readonly externalEventId: string;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly approvalInstanceId: string;
  readonly approvalVersion: number;
  readonly result: 'approved' | 'rejected' | 'withdrawn';
  readonly status: 'manual_review' | 'dead';
  readonly attempts: number;
  readonly operatorRetryCount: number;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

/** OP 审批结果投递运维服务；查询与重试均绑定可信租户上下文。 */
@Injectable()
export class OpApprovalResultOperationsService {
  constructor(
    @InjectModel(OpApprovalResultDeliveryRecord.name)
    private readonly deliveries: Model<OpApprovalResultDeliveryDocument>,
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listTerminal(input: {
    readonly status: 'manual_review' | 'dead';
    readonly beforeEventId?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly OpApprovalResultDeliveryView[]; readonly nextCursor: string | null }> {
    const trusted = this.context.getRequired();
    if (!trusted.actor.scopes.includes('erp:op:approval_result:read')) {
      throw new ForbiddenException({
        code: 'OP_APPROVAL_RESULT_READ_SCOPE_REQUIRED',
        message: '缺少 OP 审批结果读取权限',
      });
    }
    this.assertListInput(input);
    const tenantId = trusted.tenant.tenantId;
    const records = await this.deliveries.find({
      tenantId, status: input.status,
      ...(input.beforeEventId === undefined ? {} : { eventId: { $lt: input.beforeEventId } }),
    }, TERMINAL_PROJECTION).sort({ eventId: -1 }).limit(input.limit + 1).lean().exec();
    const parsed = z.array(terminalProjectionSchema).max(input.limit + 1).safeParse(records);
    if (
      !parsed.success ||
      parsed.data.some((record) =>
        record.tenantId !== tenantId || record.status !== input.status,
      )
    ) throw new Error('OP_APPROVAL_RESULT_STATE_INVALID');
    const page = parsed.data.slice(0, input.limit);
    const items = Object.freeze(page.map((record) => Object.freeze({
      eventId: record.eventId,
      externalEventId: record.externalEventId,
      sourceDocumentType: record.sourceDocumentType,
      sourceDocumentId: record.sourceDocumentId,
      approvalInstanceId: record.approvalInstanceId,
      approvalVersion: record.approvalVersion,
      result: record.result,
      status: record.status,
      attempts: record.attempts,
      operatorRetryCount: record.operatorRetryCount,
      lastErrorCode: record.lastErrorCode,
      updatedAt: record.updatedAt.toISOString(),
    })));
    return Object.freeze({
      items,
      nextCursor: parsed.data.length > input.limit ? page.at(-1)?.eventId ?? null : null,
    });
  }

  async retry(
    eventId: string,
    reason: OpApprovalResultRetryReason,
    idempotencyKey: string,
  ): Promise<{ readonly delivery: { readonly eventId: string; readonly status: 'pending'; readonly reason: OpApprovalResultRetryReason } }> {
    const trusted = this.context.getRequired();
    if (!trusted.actor.scopes.includes('erp:op:approval_result:operate')) {
      throw new ForbiddenException({
        code: 'OP_APPROVAL_RESULT_OPERATE_SCOPE_REQUIRED',
        message: '缺少 OP 审批结果运维权限',
      });
    }
    this.assertRetryInput(eventId, reason, idempotencyKey);
    const tenantId = trusted.tenant.tenantId;
    return this.idempotency.execute(
      'op.approval_result.retry', idempotencyKey, { eventId, reason }, async (session) => {
        const now = new Date();
        const updated = await this.deliveries.findOneAndUpdate({
          tenantId,
          eventId,
          operatorRetryCount: { $lt: 100 },
          ...this.retryEligibility(reason),
        }, {
          $set: {
            status: 'pending', attempts: 0, nextAttemptAt: now,
            lockedAt: null, lockedBy: null, succeededAt: null, lastErrorCode: null,
            updatedAt: now,
          },
          $inc: { operatorRetryCount: 1 },
        }, {
          session, returnDocument: 'after', timestamps: false, runValidators: true,
          projection: RETRY_PROJECTION,
        }).lean().exec();
        if (updated === null) throw new NotFoundException({
          code: 'OP_APPROVAL_RESULT_NOT_RETRYABLE',
          message: 'OP 审批结果投递不存在或当前状态不可重试',
        });
        const parsed = retryProjectionSchema.safeParse(updated);
        if (
          !parsed.success ||
          parsed.data.tenantId !== tenantId ||
          parsed.data.eventId !== eventId
        ) throw new Error('OP_APPROVAL_RESULT_STATE_INVALID');
        return Object.freeze({
          delivery: Object.freeze({
            eventId: parsed.data.eventId,
            status: parsed.data.status,
            reason,
          }),
        });
      },
    );
  }

  private assertListInput(input: {
    readonly status: 'manual_review' | 'dead';
    readonly beforeEventId?: string;
    readonly limit: number;
  }): void {
    if (input.status !== 'manual_review' && input.status !== 'dead') {
      throw new BadRequestException({
        code: 'OP_APPROVAL_RESULT_STATUS_INVALID',
        message: 'status 必须为 manual_review 或 dead',
      });
    }
    if (input.beforeEventId !== undefined && !ULID_PATTERN.test(input.beforeEventId)) {
      throw new BadRequestException({
        code: 'OP_APPROVAL_RESULT_EVENT_ID_INVALID',
        message: 'eventId 必须为严格 ULID',
      });
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new BadRequestException({
        code: 'OP_APPROVAL_RESULT_LIMIT_INVALID',
        message: 'limit 必须为 1..100',
      });
    }
  }

  private assertRetryInput(
    eventId: string,
    reason: OpApprovalResultRetryReason,
    idempotencyKey: string,
  ): void {
    if (!ULID_PATTERN.test(eventId)) {
      throw new BadRequestException({
        code: 'OP_APPROVAL_RESULT_EVENT_ID_INVALID',
        message: 'eventId 必须为严格 ULID',
      });
    }
    if (!RETRY_REASONS.includes(reason)) {
      throw new BadRequestException({
        code: 'OP_APPROVAL_RESULT_REASON_INVALID',
        message: '重试原因码非法',
      });
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: '必须提供合法 Idempotency-Key',
      });
    }
  }

  private retryEligibility(reason: OpApprovalResultRetryReason): Record<string, unknown> {
    if (reason === 'provider_recovered') {
      return {
        status: 'dead',
        lastErrorCode: { $nin: CREDENTIAL_ERROR_CODES },
      };
    }
    if (reason === 'approved_exception') return { status: 'manual_review' };
    return {
      status: reason === 'route_fixed'
        ? 'manual_review'
        : { $in: ['manual_review', 'dead'] },
      lastErrorCode: {
        $in: reason === 'credentials_fixed' ? CREDENTIAL_ERROR_CODES : ROUTE_ERROR_CODES,
      },
    };
  }
}
