import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { retryReasonSchema as retryRequestSchema } from '../../contracts/rest-request-contracts.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  ApprovalNotificationOperationsService,
  type ApprovalNotificationRetryReason,
} from './notification/approval-notification-operations.service.js';
import type { ApprovalNotificationChannel } from './notification/approval-notification.schema.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const RETRY_REASONS: readonly ApprovalNotificationRetryReason[] = [
  'credentials_fixed', 'identity_bound', 'provider_recovered', 'approved_exception',
];
/** 审批通知运维接口；只暴露脱敏状态，不暴露平台 Token、响应或消息正文。 */
@Controller('approvals/notifications')
export class ApprovalNotificationOperationsController {
  private readonly logger = new Logger(ApprovalNotificationOperationsController.name);

  constructor(
    private readonly operations: ApprovalNotificationOperationsService,
    private readonly audit: AuditService,
  ) {}

  @Get('dead')
  @RequiredScopes('erp:approval:notification:read')
  listDead(
    @Query('channel') channel: unknown,
    @Query('before') before: unknown,
    @Query('limit') limit: unknown,
  ) {
    return this.operations.listDead({
      ...(channel === undefined ? {} : { channel: this.requireChannel(channel) }),
      ...(before === undefined ? {} : { beforeNotificationId: this.requireUlid(before) }),
      limit: this.requireLimit(limit),
    });
  }

  @Get('reconciliation')
  @RequiredScopes('erp:approval:notification:read')
  reconciliation() {
    return this.operations.reconciliation();
  }

  @Post(':notificationId/retries')
  @HttpCode(200)
  @RequiredScopes('erp:approval:notification:operate')
  async retry(
    @Param('notificationId') notificationId: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    const id = this.requireUlid(notificationId);
    const request = this.requireRetryRequest(body);
    const reason = this.requireReason(request.reason);
    const key = this.requireKey(idempotencyKey);
    let result;
    try {
      result = await this.operations.retry(id, reason, key);
    } catch (error) {
      try {
        await this.auditRetry(id, reason, 'failure');
      } catch {
        this.logger.error({
          code: 'APPROVAL_NOTIFICATION_RETRY_FAILURE_AUDIT_FAILED',
          notificationId: id,
        });
      }
      throw error;
    }
    try {
      await this.auditRetry(id, reason, 'success');
    } catch {
      this.logger.error({
        code: 'APPROVAL_NOTIFICATION_RETRY_AUDIT_AFTER_COMMIT_FAILED',
        notificationId: id,
      });
    }
    return result;
  }

  private requireRetryRequest(value: unknown): { readonly reason: string } {
    const parsed = retryRequestSchema.safeParse(value);
    if (parsed.success) return Object.freeze({ reason: parsed.data.reason });
    throw new BadRequestException({
      code: 'APPROVAL_NOTIFICATION_RETRY_REQUEST_INVALID',
      message: '审批通知重试请求结构无效',
    });
  }

  private requireChannel(value: unknown): ApprovalNotificationChannel {
    if (value === 'dingtalk' || value === 'feishu') return value;
    throw new BadRequestException({ code: 'APPROVAL_NOTIFICATION_CHANNEL_INVALID', message: 'channel 非法' });
  }

  private requireUlid(value: unknown): string {
    if (typeof value === 'string' && ULID_PATTERN.test(value)) return value;
    throw new BadRequestException({ code: 'APPROVAL_NOTIFICATION_ID_INVALID', message: '通知标识必须为严格 ULID' });
  }

  private requireLimit(value: unknown): number {
    if (value === undefined) return 50;
    if (typeof value === 'string' && /^(?:[1-9]|[1-9][0-9]|100)$/u.test(value)) {
      return Number(value);
    }
    throw new BadRequestException({ code: 'APPROVAL_NOTIFICATION_LIMIT_INVALID', message: 'limit 必须为 1..100' });
  }

  private requireReason(value: unknown): ApprovalNotificationRetryReason {
    if (RETRY_REASONS.includes(value as ApprovalNotificationRetryReason)) {
      return value as ApprovalNotificationRetryReason;
    }
    throw new BadRequestException({ code: 'APPROVAL_NOTIFICATION_REASON_INVALID', message: '重试原因码非法' });
  }

  private requireKey(value: unknown): string {
    if (typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value)) return value;
    throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '必须提供合法 Idempotency-Key' });
  }

  private async auditRetry(
    id: string,
    reason: ApprovalNotificationRetryReason,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    await this.audit.record({
      action: 'approval.notification.retry',
      resourceType: 'approval_notification',
      resourceId: id,
      riskLevel: 'R2',
      outcome,
      metadata: { reason },
    });
  }
}
