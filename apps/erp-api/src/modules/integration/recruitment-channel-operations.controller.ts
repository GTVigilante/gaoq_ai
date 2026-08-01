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
import { ULID_PATTERN } from '@gaoq/shared-utils';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  RecruitmentChannelOperationsService,
  type RecruitmentChannelDeliveryKind,
  type RecruitmentChannelResolutionReason,
} from './recruitment-channel-operations.service.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const REASONS: readonly RecruitmentChannelResolutionReason[] = [
  'credentials_fixed', 'mapping_fixed', 'provider_recovered', 'approved_exception',
];

/** 招聘渠道结果未知人工核验接口；R2 写操作明确禁止注册为 MCP Tool。 */
@Controller('integrations/recruitment-channel-deliveries')
export class RecruitmentChannelOperationsController {
  private readonly logger = new Logger(RecruitmentChannelOperationsController.name);

  constructor(
    private readonly operations: RecruitmentChannelOperationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequiredScopes('erp:integration:recruitment_channel:read')
  list(
    @Query('kind') kind: string | undefined,
    @Query('status') status: string | undefined,
    @Query('before') before: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    return this.operations.listTerminal({
      kind: this.requireKind(kind),
      status: this.requireStatus(status),
      ...(before === undefined ? {} : { beforeEventId: this.requireUlid(before) }),
      limit: this.requireLimit(limit),
    });
  }

  @Post(':kind/:eventId/retries')
  @HttpCode(200)
  @RequiredScopes('erp:integration:recruitment_channel:operate')
  async retry(
    @Param('kind') kind: string,
    @Param('eventId') eventId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: {
      readonly reason?: string;
      readonly providerConfirmedNotCommitted?: boolean;
    },
  ) {
    const parsedKind = this.requireKind(kind);
    const parsedEventId = this.requireUlid(eventId);
    const reason = this.requireReason(body.reason);
    const providerConfirmedNotCommitted = body.providerConfirmedNotCommitted === true;
    const metadata = { kind: parsedKind, reason, providerConfirmedNotCommitted };
    let result;
    try {
      result = await this.operations.retry({
        kind: parsedKind,
        eventId: parsedEventId,
        reason,
        providerConfirmedNotCommitted,
        idempotencyKey: this.requireIdempotencyKey(idempotencyKey),
      });
    } catch (error) {
      try {
        await this.audit.record({
          action: 'integration.recruitment_channel.retry',
          resourceType: 'recruitment_channel_delivery',
          resourceId: `${parsedKind}:${parsedEventId}`,
          riskLevel: 'R2',
          outcome: 'failure',
          metadata,
        });
      } catch {
        this.logger.error({
          code: 'RECRUITMENT_CHANNEL_RETRY_FAILURE_AUDIT_FAILED',
          kind: parsedKind,
          eventId: parsedEventId,
        });
      }
      throw error;
    }
    try {
      await this.audit.record({
        action: 'integration.recruitment_channel.retry',
        resourceType: 'recruitment_channel_delivery',
        resourceId: `${parsedKind}:${parsedEventId}`,
        riskLevel: 'R2',
        outcome: 'success',
        metadata,
      });
    } catch {
      this.logger.error({
        code: 'RECRUITMENT_CHANNEL_RETRY_AUDIT_AFTER_COMMIT_FAILED',
        kind: parsedKind,
        eventId: parsedEventId,
      });
    }
    return result;
  }

  private requireKind(value: string | undefined): RecruitmentChannelDeliveryKind {
    if (value === 'position' || value === 'stage') return value;
    throw new BadRequestException({
      code: 'RECRUITMENT_CHANNEL_DELIVERY_KIND_INVALID',
      message: 'kind 必须为 position 或 stage',
    });
  }

  private requireStatus(value: string | undefined): 'manual_review' | 'dead' {
    if (value === 'manual_review' || value === 'dead') return value;
    throw new BadRequestException({
      code: 'RECRUITMENT_CHANNEL_DELIVERY_STATUS_INVALID',
      message: 'status 必须为 manual_review 或 dead',
    });
  }

  private requireReason(value: string | undefined): RecruitmentChannelResolutionReason {
    if (REASONS.includes(value as RecruitmentChannelResolutionReason)) {
      return value as RecruitmentChannelResolutionReason;
    }
    throw new BadRequestException({
      code: 'RECRUITMENT_CHANNEL_RESOLUTION_REASON_INVALID',
      message: '处置原因码非法',
    });
  }

  private requireUlid(value: string): string {
    if (ULID_PATTERN.test(value)) return value;
    throw new BadRequestException({
      code: 'RECRUITMENT_CHANNEL_EVENT_ID_INVALID',
      message: 'eventId 必须为严格 ULID',
    });
  }

  private requireLimit(value: string | undefined): number {
    const parsed = value === undefined ? 50 : Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) return parsed;
    throw new BadRequestException({
      code: 'RECRUITMENT_CHANNEL_LIMIT_INVALID',
      message: 'limit 必须为 1..100',
    });
  }

  private requireIdempotencyKey(value: string | undefined): string {
    if (value !== undefined && IDEMPOTENCY_KEY_PATTERN.test(value)) return value;
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: '必须提供合法 Idempotency-Key',
    });
  }
}
