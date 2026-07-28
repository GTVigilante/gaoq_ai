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
import { APPROVAL_NOTIFICATION_MAX_ATTEMPTS } from './approval-notification.policy.js';
import {
  ApprovalNotificationRecord,
  type ApprovalNotificationChannel,
  type ApprovalNotificationDocument,
  type ApprovalNotificationStatus,
} from './approval-notification.schema.js';

export type ApprovalNotificationRetryReason =
  | 'credentials_fixed'
  | 'identity_bound'
  | 'provider_recovered'
  | 'approved_exception';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_TYPE_PATTERN = /^instance\.(?:submitted|decided|approver_transferred|approver_added|withdrawn)$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{3,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_OPERATOR_RETRIES = 100;
const RETRY_REASONS = [
  'credentials_fixed',
  'identity_bound',
  'provider_recovered',
  'approved_exception',
] as const;
const CREDENTIAL_ERROR_CODES = Object.freeze([
  'ORG_CREDENTIAL_REF_INVALID',
  'ORG_CREDENTIAL_UNAVAILABLE',
  'ORG_CREDENTIAL_INVALID',
  'ORG_PLATFORM_BINDING_MISSING',
  'ORG_PLATFORM_HTTP_401',
]);
const IDENTITY_ERROR_CODES = Object.freeze([
  'APPROVAL_RECIPIENT_INACTIVE',
  'APPROVAL_RECIPIENT_IDENTITY_UNBOUND',
]);
const PROVIDER_ERROR_CODES = Object.freeze([
  'ORG_PLATFORM_NETWORK_ERROR',
  'ORG_PLATFORM_RESPONSE_READ_ERROR',
  'ORG_PLATFORM_RESPONSE_TOO_LARGE',
  'ORG_PLATFORM_RESPONSE_INVALID',
  'DINGTALK_TOKEN_RESPONSE_INVALID',
  'FEISHU_TOKEN_RESPONSE_INVALID',
  'DINGTALK_APPROVAL_MESSAGE_RESPONSE_INVALID',
  'FEISHU_APPROVAL_MESSAGE_RESPONSE_INVALID',
]);
const PROVIDER_HTTP_ERROR_PATTERN = /^ORG_PLATFORM_HTTP_(?:429|5[0-9]{2})$/;
const TERMINAL_PROJECTION = Object.freeze({
  tenantId: 1,
  notificationId: 1,
  instanceId: 1,
  aggregateVersion: 1,
  eventType: 1,
  recipientActorId: 1,
  channel: 1,
  riskLevel: 1,
  status: 1,
  attempts: 1,
  operatorRetryCount: 1,
  lastErrorCode: 1,
  updatedAt: 1,
  _id: 0,
} as const);
const RETRY_PROJECTION = Object.freeze({
  tenantId: 1,
  notificationId: 1,
  status: 1,
  attempts: 1,
  operatorRetryCount: 1,
  nextAttemptAt: 1,
  lockedAt: 1,
  lockedBy: 1,
  externalMessageId: 1,
  lastErrorCode: 1,
  sentAt: 1,
  updatedAt: 1,
  _id: 0,
} as const);
const OLDEST_PENDING_PROJECTION = Object.freeze({
  tenantId: 1,
  status: 1,
  createdAt: 1,
  _id: 0,
} as const);
const terminalProjectionSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  notificationId: z.string().regex(ULID_PATTERN),
  instanceId: z.string().regex(ID_PATTERN),
  aggregateVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  eventType: z.string().regex(EVENT_TYPE_PATTERN),
  recipientActorId: z.string().regex(ID_PATTERN),
  channel: z.enum(['dingtalk', 'feishu']),
  riskLevel: z.enum(['R1', 'R2']),
  status: z.literal('dead'),
  attempts: z.number().int().min(0).max(APPROVAL_NOTIFICATION_MAX_ATTEMPTS),
  operatorRetryCount: z.number().int().min(0).max(MAX_OPERATOR_RETRIES),
  lastErrorCode: z.string().regex(ERROR_CODE_PATTERN),
  updatedAt: z.date(),
}).strict().refine((value) => value.updatedAt.getTime() <= Date.now());
const retryProjectionSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  notificationId: z.string().regex(ULID_PATTERN),
  status: z.literal('pending'),
  attempts: z.literal(0),
  operatorRetryCount: z.number().int().min(1).max(MAX_OPERATOR_RETRIES),
  nextAttemptAt: z.date(),
  lockedAt: z.null(),
  lockedBy: z.null(),
  externalMessageId: z.null(),
  lastErrorCode: z.null(),
  sentAt: z.null(),
  updatedAt: z.date(),
}).strict().refine((value) =>
  value.nextAttemptAt.getTime() === value.updatedAt.getTime() &&
  value.updatedAt.getTime() <= Date.now(),
);
const oldestPendingProjectionSchema = z.object({
  tenantId: z.string().regex(ID_PATTERN),
  status: z.enum(['pending', 'processing']),
  createdAt: z.date(),
}).strict().refine((value) => value.createdAt.getTime() <= Date.now());
const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export interface ApprovalNotificationSummary {
  readonly notificationId: string;
  readonly instanceId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly recipientActorId: string;
  readonly channel: ApprovalNotificationChannel;
  readonly riskLevel: 'R1' | 'R2';
  readonly attempts: number;
  readonly operatorRetryCount: number;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

/** 审批通知运维服务；所有读写固定绑定可信租户，不返回平台回执或正文。 */
@Injectable()
export class ApprovalNotificationOperationsService {
  constructor(
    @InjectModel(ApprovalNotificationRecord.name)
    private readonly records: Model<ApprovalNotificationDocument>,
    private readonly context: TenantContextService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listDead(input: {
    readonly channel?: ApprovalNotificationChannel;
    readonly beforeNotificationId?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly ApprovalNotificationSummary[]; readonly nextCursor: string | null }> {
    const trusted = this.context.getRequired();
    this.requireScope(
      trusted.actor.scopes,
      'erp:approval:notification:read',
      'APPROVAL_NOTIFICATION_READ_SCOPE_REQUIRED',
    );
    this.assertListInput(input);
    const tenantId = trusted.tenant.tenantId;
    const records = await this.records.find(
      {
        tenantId,
        status: 'dead',
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        ...(input.beforeNotificationId === undefined
          ? {}
          : { notificationId: { $lt: input.beforeNotificationId } }),
      },
      TERMINAL_PROJECTION,
    ).sort({ notificationId: -1 }).limit(input.limit + 1).lean().exec();
    const parsed = z.array(terminalProjectionSchema).max(input.limit + 1).safeParse(records);
    if (
      !parsed.success ||
      parsed.data.some((record) =>
        record.tenantId !== tenantId ||
        record.status !== 'dead' ||
        (input.channel !== undefined && record.channel !== input.channel),
      )
    ) {
      throw new Error('APPROVAL_NOTIFICATION_STATE_INVALID');
    }
    const page = parsed.data.slice(0, input.limit);
    const items = Object.freeze(page.map((record) => Object.freeze({
        notificationId: record.notificationId,
        instanceId: record.instanceId,
        aggregateVersion: record.aggregateVersion,
        eventType: record.eventType,
        recipientActorId: record.recipientActorId,
        channel: record.channel,
        riskLevel: record.riskLevel,
        attempts: record.attempts,
        operatorRetryCount: record.operatorRetryCount,
        lastErrorCode: record.lastErrorCode,
        updatedAt: record.updatedAt.toISOString(),
      })));
    return Object.freeze({
      items,
      nextCursor: parsed.data.length > input.limit
        ? page.at(-1)?.notificationId ?? null
        : null,
    });
  }

  async retry(
    notificationId: string,
    reason: ApprovalNotificationRetryReason,
    idempotencyKey: string,
  ): Promise<{ readonly notification: {
    readonly notificationId: string;
    readonly status: 'pending';
    readonly reason: ApprovalNotificationRetryReason;
  } }> {
    const trusted = this.context.getRequired();
    this.requireScope(
      trusted.actor.scopes,
      'erp:approval:notification:operate',
      'APPROVAL_NOTIFICATION_OPERATE_SCOPE_REQUIRED',
    );
    this.assertRetryInput(notificationId, reason, idempotencyKey);
    const tenantId = trusted.tenant.tenantId;
    return this.idempotency.execute(
      'approval.notification.retry',
      idempotencyKey,
      { notificationId, reason },
      async (session) => {
        const now = new Date();
        const updated = await this.records.findOneAndUpdate(
          {
            tenantId,
            notificationId,
            status: 'dead',
            operatorRetryCount: { $lt: MAX_OPERATOR_RETRIES },
            ...this.retryEligibility(reason),
          },
          {
            $set: {
              status: 'pending', attempts: 0, nextAttemptAt: now,
              lockedAt: null, lockedBy: null, externalMessageId: null,
              lastErrorCode: null, sentAt: null, updatedAt: now,
            },
            $inc: { operatorRetryCount: 1 },
          },
          {
            session,
            returnDocument: 'after',
            timestamps: false,
            runValidators: true,
            projection: RETRY_PROJECTION,
          },
        ).lean().exec();
        if (updated === null) throw new NotFoundException({
          code: 'APPROVAL_NOTIFICATION_NOT_RETRYABLE',
          message: '通知不存在或当前状态不可重试',
        });
        const parsed = retryProjectionSchema.safeParse(updated);
        if (
          !parsed.success ||
          parsed.data.tenantId !== tenantId ||
          parsed.data.notificationId !== notificationId
        ) {
          throw new Error('APPROVAL_NOTIFICATION_STATE_INVALID');
        }
        return Object.freeze({
          notification: Object.freeze({
            notificationId: parsed.data.notificationId,
            status: parsed.data.status,
            reason,
          }),
        });
      },
    );
  }

  async reconciliation(): Promise<{
    readonly counts: Readonly<Record<ApprovalNotificationChannel, Readonly<Record<ApprovalNotificationStatus, number>>>>;
    readonly oldestPendingAt: string | null;
  }> {
    const trusted = this.context.getRequired();
    this.requireScope(
      trusted.actor.scopes,
      'erp:approval:notification:read',
      'APPROVAL_NOTIFICATION_READ_SCOPE_REQUIRED',
    );
    const tenantId = trusted.tenant.tenantId;
    const channels = ['dingtalk', 'feishu'] as const;
    const statuses = ['pending', 'processing', 'sent', 'dead'] as const;
    const values = await Promise.all(channels.flatMap((channel) =>
      statuses.map(async (status) => ({
        channel,
        status,
        count: await this.records.countDocuments({ tenantId, channel, status }),
      })),
    ));
    const oldest = await this.records.findOne(
      { tenantId, status: { $in: ['pending', 'processing'] } },
      OLDEST_PENDING_PROJECTION,
    ).sort({ createdAt: 1 }).lean().exec();
    if (values.some((value) => !countSchema.safeParse(value.count).success)) {
      throw new Error('APPROVAL_NOTIFICATION_STATE_INVALID');
    }
    const parsedOldest = oldestPendingProjectionSchema.nullable().safeParse(oldest);
    if (
      !parsedOldest.success ||
      (
        parsedOldest.data !== null &&
        parsedOldest.data.tenantId !== tenantId
      )
    ) {
      throw new Error('APPROVAL_NOTIFICATION_STATE_INVALID');
    }
    const counts = {
      dingtalk: { pending: 0, processing: 0, sent: 0, dead: 0 },
      feishu: { pending: 0, processing: 0, sent: 0, dead: 0 },
    };
    for (const value of values) counts[value.channel][value.status] = value.count;
    return Object.freeze({
      counts: Object.freeze({
        dingtalk: Object.freeze(counts.dingtalk),
        feishu: Object.freeze(counts.feishu),
      }),
      oldestPendingAt: parsedOldest.data?.createdAt.toISOString() ?? null,
    });
  }

  private assertListInput(input: {
    readonly channel?: ApprovalNotificationChannel;
    readonly beforeNotificationId?: string;
    readonly limit: number;
  }): void {
    const value: unknown = input;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Reflect.ownKeys(value).some((key) =>
        typeof key !== 'string' ||
        !['channel', 'beforeNotificationId', 'limit'].includes(key),
      )
    ) {
      throw new BadRequestException({
        code: 'APPROVAL_NOTIFICATION_LIST_REQUEST_INVALID',
        message: '审批通知查询结构无效',
      });
    }
    if (
      input.channel !== undefined &&
      input.channel !== 'dingtalk' &&
      input.channel !== 'feishu'
    ) {
      throw new BadRequestException({
        code: 'APPROVAL_NOTIFICATION_CHANNEL_INVALID',
        message: 'channel 非法',
      });
    }
    if (
      input.beforeNotificationId !== undefined &&
      (
        typeof input.beforeNotificationId !== 'string' ||
        !ULID_PATTERN.test(input.beforeNotificationId)
      )
    ) {
      throw new BadRequestException({
        code: 'APPROVAL_NOTIFICATION_ID_INVALID',
        message: '通知标识必须为严格 ULID',
      });
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new BadRequestException({
        code: 'APPROVAL_NOTIFICATION_LIMIT_INVALID',
        message: 'limit 必须为 1..100',
      });
    }
  }

  private assertRetryInput(
    notificationId: string,
    reason: ApprovalNotificationRetryReason,
    idempotencyKey: string,
  ): void {
    if (typeof notificationId !== 'string' || !ULID_PATTERN.test(notificationId)) {
      throw new BadRequestException({
        code: 'APPROVAL_NOTIFICATION_ID_INVALID',
        message: '通知标识必须为严格 ULID',
      });
    }
    if (typeof reason !== 'string' || !RETRY_REASONS.includes(reason)) {
      throw new BadRequestException({
        code: 'APPROVAL_NOTIFICATION_REASON_INVALID',
        message: '重试原因码非法',
      });
    }
    if (
      typeof idempotencyKey !== 'string' ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
    ) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: '必须提供合法 Idempotency-Key',
      });
    }
  }

  private retryEligibility(
    reason: ApprovalNotificationRetryReason,
  ): Readonly<Record<string, unknown>> {
    if (reason === 'approved_exception') {
      return {
        lastErrorCode: 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE',
      };
    }
    if (reason === 'credentials_fixed') {
      return { lastErrorCode: { $in: CREDENTIAL_ERROR_CODES } };
    }
    if (reason === 'identity_bound') {
      return { lastErrorCode: { $in: IDENTITY_ERROR_CODES } };
    }
    return {
      lastErrorCode: {
        $in: [...PROVIDER_ERROR_CODES, PROVIDER_HTTP_ERROR_PATTERN],
      },
    };
  }

  private requireScope(
    scopes: readonly string[],
    required: string,
    code: string,
  ): void {
    if (!scopes.includes(required)) {
      throw new ForbiddenException({
        code,
        message: '缺少审批通知运维权限',
      });
    }
  }
}
