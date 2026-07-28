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
import { ULID_PATTERN } from '@gaoq/shared-utils';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import {
  RecruitmentCalendarOperationsService,
  type RecruitmentCalendarResolutionDecision,
  type RecruitmentCalendarResolutionReason,
} from './recruitment-calendar-operations.service.js';
import {
  assertRecruitmentCalendarExternalEventId,
  type RecruitmentCalendarChannel,
} from './recruitment-calendar.adapter.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const CALENDAR_ID_PATTERN = /^[\x21-\x7E]{1,256}$/;
const REASONS: readonly RecruitmentCalendarResolutionReason[] = [
  'credentials_fixed', 'identity_fixed', 'provider_recovered', 'approved_exception',
];
const DECISIONS: readonly RecruitmentCalendarResolutionDecision[] = [
  'retry', 'accept_succeeded',
];

/** 招聘日历人工核验接口；明确不注册为 MCP Tool。 */
@Controller('integrations/recruitment-calendar-deliveries')
export class RecruitmentCalendarOperationsController {
  constructor(
    private readonly operations: RecruitmentCalendarOperationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequiredScopes('erp:integration:calendar:read')
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

  @Post(':eventId/:channel/resolutions')
  @HttpCode(200)
  @RequiredScopes('erp:integration:calendar:operate')
  async resolve(
    @Param('eventId') eventId: string,
    @Param('channel') channel: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: {
      readonly externalCalendarId?: string;
      readonly decision?: string;
      readonly reason?: string;
      readonly externalEventId?: string;
    },
  ) {
    const parsedEventId = this.requireUlid(eventId);
    const parsedChannel = this.requireChannel(channel);
    const externalCalendarId = this.requireCalendarId(body.externalCalendarId);
    const decision = this.requireDecision(body.decision);
    const reason = this.requireReason(body.reason);
    const parsedExternalEventId = this.requireExternalEventId(
      decision,
      body.externalEventId,
    );
    const parsedIdempotencyKey = this.requireIdempotencyKey(idempotencyKey);
    const metadata = { decision, reason };
    let result;
    try {
      result = await this.operations.resolve({
        eventId: parsedEventId,
        channel: parsedChannel,
        externalCalendarId,
        decision,
        reason,
        ...(parsedExternalEventId === undefined
          ? {}
          : { externalEventId: parsedExternalEventId }),
        idempotencyKey: parsedIdempotencyKey,
      });
    } catch (error) {
      await this.audit.record({
        action: 'integration.recruitment_calendar.resolve',
        resourceType: 'recruitment_calendar_delivery',
        resourceId: `${parsedEventId}:${parsedChannel}`,
        riskLevel: 'R2',
        outcome: 'failure',
        metadata,
      });
      throw error;
    }
    await this.audit.record({
      action: 'integration.recruitment_calendar.resolve',
      resourceType: 'recruitment_calendar_delivery',
      resourceId: `${parsedEventId}:${parsedChannel}`,
      riskLevel: 'R2',
      outcome: 'success',
      metadata,
    });
    return result;
  }

  private requireStatus(value: string | undefined): 'manual_review' | 'dead' {
    if (value === 'manual_review' || value === 'dead') return value;
    throw new BadRequestException({
      code: 'RECRUITMENT_CALENDAR_STATUS_INVALID',
      message: 'status 必须为 manual_review 或 dead',
    });
  }

  private requireChannel(value: string): RecruitmentCalendarChannel {
    if (value === 'dingtalk' || value === 'feishu') return value;
    throw new BadRequestException({
      code: 'RECRUITMENT_CALENDAR_CHANNEL_INVALID',
      message: 'channel 非法',
    });
  }

  private requireUlid(value: string): string {
    if (ULID_PATTERN.test(value)) return value;
    throw new BadRequestException({
      code: 'RECRUITMENT_CALENDAR_EVENT_ID_INVALID',
      message: 'eventId 必须为严格 ULID',
    });
  }

  private requireCalendarId(value: string | undefined): string {
    if (value !== undefined && CALENDAR_ID_PATTERN.test(value)) return value;
    throw new BadRequestException({
      code: 'RECRUITMENT_CALENDAR_ID_INVALID',
      message: 'externalCalendarId 非法',
    });
  }

  private requireDecision(
    value: string | undefined,
  ): RecruitmentCalendarResolutionDecision {
    if (DECISIONS.includes(value as RecruitmentCalendarResolutionDecision)) {
      return value as RecruitmentCalendarResolutionDecision;
    }
    throw new BadRequestException({
      code: 'RECRUITMENT_CALENDAR_DECISION_INVALID',
      message: '处置决策非法',
    });
  }

  private requireReason(value: string | undefined): RecruitmentCalendarResolutionReason {
    if (REASONS.includes(value as RecruitmentCalendarResolutionReason)) {
      return value as RecruitmentCalendarResolutionReason;
    }
    throw new BadRequestException({
      code: 'RECRUITMENT_CALENDAR_REASON_INVALID',
      message: '处置原因码非法',
    });
  }

  private requireExternalEventId(
    decision: RecruitmentCalendarResolutionDecision,
    value: string | undefined,
  ): string | undefined {
    if (decision === 'retry' && value === undefined) return undefined;
    if (decision === 'accept_succeeded' && value === undefined) {
      throw new BadRequestException({
        code: 'RECRUITMENT_CALENDAR_EXTERNAL_EVENT_ID_REQUIRED',
        message: '确认平台成功必须提供外部事件标识',
      });
    }
    try {
      return assertRecruitmentCalendarExternalEventId(value ?? '');
    } catch {
      throw new BadRequestException({
        code: 'RECRUITMENT_CALENDAR_EXTERNAL_EVENT_ID_INVALID',
        message: '外部事件标识非法',
      });
    }
  }

  private requireLimit(value: string | undefined): number {
    const parsed = value === undefined ? 50 : Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) return parsed;
    throw new BadRequestException({
      code: 'RECRUITMENT_CALENDAR_LIMIT_INVALID',
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
