import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';

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
  constructor(
    private readonly operations: ApprovalNotificationOperationsService,
    private readonly audit: AuditService,
  ) {}

  @Get('dead')
  @RequiredScopes('erp:approval:notification:read')
  listDead(
    @Query('channel') channel: string | undefined,
    @Query('before') before: string | undefined,
    @Query('limit') limit: string | undefined,
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
    @Param('notificationId') notificationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: { readonly reason?: string },
  ) {
    const id = this.requireUlid(notificationId);
    const reason = this.requireReason(body.reason);
    let result;
    try {
      result = await this.operations.retry(id, reason, this.requireKey(idempotencyKey));
    } catch (error) {
      await this.auditRetry(id, reason, 'failure');
      throw error;
    }
    await this.auditRetry(id, reason, 'success');
    return result;
  }

  private requireChannel(value: string): ApprovalNotificationChannel {
    if (value === 'dingtalk' || value === 'feishu') return value;
    throw new BadRequestException({ code: 'APPROVAL_NOTIFICATION_CHANNEL_INVALID', message: 'channel 非法' });
  }

  private requireUlid(value: string): string {
    if (ULID_PATTERN.test(value)) return value;
    throw new BadRequestException({ code: 'APPROVAL_NOTIFICATION_ID_INVALID', message: '通知标识必须为严格 ULID' });
  }

  private requireLimit(value: string | undefined): number {
    const parsed = value === undefined ? 50 : Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) return parsed;
    throw new BadRequestException({ code: 'APPROVAL_NOTIFICATION_LIMIT_INVALID', message: 'limit 必须为 1..100' });
  }

  private requireReason(value: string | undefined): ApprovalNotificationRetryReason {
    if (RETRY_REASONS.includes(value as ApprovalNotificationRetryReason)) {
      return value as ApprovalNotificationRetryReason;
    }
    throw new BadRequestException({ code: 'APPROVAL_NOTIFICATION_REASON_INVALID', message: '重试原因码非法' });
  }

  private requireKey(value: string | undefined): string {
    if (value !== undefined && IDEMPOTENCY_KEY_PATTERN.test(value)) return value;
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
