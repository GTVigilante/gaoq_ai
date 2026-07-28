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
import { z } from 'zod';

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
const retryRequestSchema = z.object({
  reason: z.string(),
}).strict();

/** 多渠道组织同步运维接口；不暴露 Outbox envelope、平台令牌或原始响应。 */
@Controller('integrations/org-deliveries')
export class IntegrationController {
  private readonly logger = new Logger(IntegrationController.name);

  constructor(
    private readonly operations: OrgDeliveryOperationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequiredScopes('erp:integration:org_delivery:read')
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
  @RequiredScopes('erp:integration:org_delivery:operate')
  async retry(
    @Param('eventId') eventId: string,
    @Param('channel') channel: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const parsedEventId = this.requireUlid(eventId);
    const parsedChannel = this.requireChannel(channel);
    const reason = this.requireReason(this.requireRetryRequest(body).reason);
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
      try {
        await this.audit.record({
          action: 'integration.org_delivery.retry',
          resourceType: 'org_delivery',
          resourceId: `${parsedEventId}:${parsedChannel}`,
          riskLevel: 'R2',
          outcome: 'failure',
          metadata: { reason },
        });
      } catch {
        this.logger.error({
          code: 'ORG_DELIVERY_RETRY_FAILURE_AUDIT_FAILED',
          eventId: parsedEventId,
          channel: parsedChannel,
        });
      }
      throw error;
    }
    try {
      await this.audit.record({
        action: 'integration.org_delivery.retry',
        resourceType: 'org_delivery',
        resourceId: `${parsedEventId}:${parsedChannel}`,
        riskLevel: 'R2',
        outcome: 'success',
        metadata: { reason },
      });
    } catch {
      this.logger.error({
        code: 'ORG_DELIVERY_RETRY_AUDIT_AFTER_COMMIT_FAILED',
        eventId: parsedEventId,
        channel: parsedChannel,
      });
    }
    return result;
  }

  private requireRetryRequest(value: unknown): { readonly reason: string } {
    const parsed = retryRequestSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new BadRequestException({
      code: 'ORG_DELIVERY_RETRY_REQUEST_INVALID',
      message: '重试请求结构无效',
    });
  }

  private requireStatus(value: string | undefined): 'manual_review' | 'dead' {
    if (value === 'manual_review' || value === 'dead') return value;
    throw new BadRequestException({ code: 'ORG_DELIVERY_STATUS_INVALID', message: 'status 必须为 manual_review 或 dead' });
  }

  private requireChannel(value: string): OrgDeliveryChannel {
    if (value === 'dingtalk' || value === 'feishu' || value === 'op') return value;
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
    if (value === undefined) return 50;
    if (/^(?:[1-9]|[1-9][0-9]|100)$/u.test(value)) return Number(value);
    throw new BadRequestException({ code: 'ORG_DELIVERY_LIMIT_INVALID', message: 'limit 必须为 1..100' });
  }

  private requireIdempotencyKey(value: string | undefined): string {
    if (value !== undefined && IDEMPOTENCY_KEY_PATTERN.test(value)) return value;
    throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '必须提供合法 Idempotency-Key' });
  }
}
