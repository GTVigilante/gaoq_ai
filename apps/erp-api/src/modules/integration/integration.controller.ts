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
  OrgDeliveryOperationsService,
  type OrgDeliveryRetryReason,
} from './org-delivery-operations.service.js';
import type { OrgDeliveryChannel } from './org-delivery.schemas.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const RETRY_REASONS: readonly OrgDeliveryRetryReason[] = [
  'credentials_fixed', 'mapping_fixed', 'provider_recovered', 'approved_exception',
];

/** 双平台组织同步运维接口；不暴露 Outbox envelope、平台令牌或原始响应。 */
@Controller('integrations/org-deliveries')
export class IntegrationController {
  constructor(
    private readonly operations: OrgDeliveryOperationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequiredScopes('integration:read')
  list(
    @Query('status') status: string | undefined,
    @Query('channel') channel: string | undefined,
    @Query('before') before: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    return this.operations.listTerminal({
      status: this.requireStatus(status),
      ...(channel === undefined ? {} : { channel: this.requireChannel(channel) }),
      ...(before === undefined ? {} : { beforeEventId: this.requireUlid(before) }),
      limit: this.requireLimit(limit),
    });
  }

  @Post(':eventId/:channel/retries')
  @HttpCode(200)
  @RequiredScopes('integration:operate')
  async retry(
    @Param('eventId') eventId: string,
    @Param('channel') channel: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: { readonly reason?: string },
  ) {
    const parsedEventId = this.requireUlid(eventId);
    const parsedChannel = this.requireChannel(channel);
    const reason = this.requireReason(body.reason);
    const parsedIdempotencyKey = this.requireIdempotencyKey(idempotencyKey);
    let result;
    try {
      result = await this.operations.retry(
        parsedEventId,
        parsedChannel,
        reason,
        parsedIdempotencyKey,
      );
    } catch (error) {
      await this.audit.record({
        action: 'integration.org_delivery.retry',
        resourceType: 'org_delivery',
        resourceId: `${parsedEventId}:${parsedChannel}`,
        riskLevel: 'R2',
        outcome: 'failure',
        metadata: { reason },
      });
      throw error;
    }
    await this.audit.record({
      action: 'integration.org_delivery.retry',
      resourceType: 'org_delivery',
      resourceId: `${parsedEventId}:${parsedChannel}`,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { reason },
    });
    return result;
  }

  private requireStatus(value: string | undefined): 'manual_review' | 'dead' {
    if (value === 'manual_review' || value === 'dead') return value;
    throw new BadRequestException({ code: 'ORG_DELIVERY_STATUS_INVALID', message: 'status 必须为 manual_review 或 dead' });
  }

  private requireChannel(value: string): OrgDeliveryChannel {
    if (value === 'dingtalk' || value === 'feishu') return value;
    throw new BadRequestException({ code: 'ORG_DELIVERY_CHANNEL_INVALID', message: 'channel 非法' });
  }

  private requireUlid(value: string): string {
    if (ULID_PATTERN.test(value)) return value;
    throw new BadRequestException({ code: 'ORG_DELIVERY_ID_INVALID', message: 'eventId 必须为严格 ULID' });
  }

  private requireReason(value: string | undefined): OrgDeliveryRetryReason {
    if (RETRY_REASONS.includes(value as OrgDeliveryRetryReason)) return value as OrgDeliveryRetryReason;
    throw new BadRequestException({ code: 'ORG_DELIVERY_REASON_INVALID', message: '重试原因码非法' });
  }

  private requireLimit(value: string | undefined): number {
    const parsed = value === undefined ? 50 : Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) return parsed;
    throw new BadRequestException({ code: 'ORG_DELIVERY_LIMIT_INVALID', message: 'limit 必须为 1..100' });
  }

  private requireIdempotencyKey(value: string | undefined): string {
    if (value !== undefined && IDEMPOTENCY_KEY_PATTERN.test(value)) return value;
    throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '必须提供合法 Idempotency-Key' });
  }
}
