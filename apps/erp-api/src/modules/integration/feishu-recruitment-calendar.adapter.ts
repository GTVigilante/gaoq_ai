import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrgPlatformHttpClient } from './org-platform-http.client.js';
import { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgPushError } from './org-push.adapter.js';
import {
  RecruitmentCalendarAdapter,
  assertCancelRecruitmentCalendarCommand,
  assertRecruitmentCalendarExternalEventId,
  assertUpsertRecruitmentCalendarCommand,
  type CancelRecruitmentCalendarCommand,
  type RecruitmentCalendarResult,
  RecruitmentCalendarError,
  type UpsertRecruitmentCalendarCommand,
} from './recruitment-calendar.adapter.js';

const feishuResponseSchema = z.object({
  code: z.number().int().min(-999_999_999).max(999_999_999),
  data: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const eventDataSchema = z.object({
  event: z.object({ event_id: z.string().min(1).max(512) }).passthrough(),
}).passthrough();
const RETRYABLE_CODES = new Set([190003, 190004, 190005, 190010, 193001, 99991400, 99991401]);
const REQUEST_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;

/** 飞书 Calendar v4 适配器；应用身份只写租户显式绑定的 primary/shared 日历。 */
@Injectable()
export class FeishuRecruitmentCalendarAdapter extends RecruitmentCalendarAdapter {
  readonly channel = 'feishu' as const;

  constructor(
    private readonly tokens: OrgPlatformTokenService,
    private readonly http: OrgPlatformHttpClient,
  ) {
    super();
  }

  async upsert(command: UpsertRecruitmentCalendarCommand): Promise<RecruitmentCalendarResult> {
    assertUpsertRecruitmentCalendarCommand(command);
    const calendarPath = this.calendarPath(command.externalCalendarId);
    const currentId = command.currentExternalEventId;
    const eventResponse = await this.call({
      tenantId: command.tenantId,
      path: currentId === null
        ? `${calendarPath}/events`
        : `${calendarPath}/events/${encodeURIComponent(currentId)}`,
      method: currentId === null ? 'POST' : 'PATCH',
      query: {
        user_id_type: 'user_id',
        ...(currentId === null
          ? { idempotency_key: this.protocolIdempotencyKey(command.idempotencyKey) }
          : {}),
      },
      body: {
        summary: '招聘面试',
        need_notification: true,
        start_time: { date_time: command.startsAt, timezone: command.timezone },
        end_time: { date_time: command.endsAt, timezone: command.timezone },
        free_busy_status: 'busy',
        visibility: 'private',
        attendee_ability: 'none',
        location: { name: command.location },
      },
    });
    const parsed = eventDataSchema.safeParse(eventResponse.data);
    if (!parsed.success) throw new RecruitmentCalendarError(
      'FEISHU_CALENDAR_RESULT_UNKNOWN',
      'conflict',
      '飞书日程可能已提交但响应无效',
    );
    const eventId = assertRecruitmentCalendarExternalEventId(parsed.data.event.event_id);
    try {
      await this.call({
        tenantId: command.tenantId,
        path: `${calendarPath}/events/${encodeURIComponent(eventId)}/attendees`,
        method: 'POST',
        query: { user_id_type: 'user_id' },
        body: {
          attendees: command.attendeeExternalIds.map((userId) => ({
            type: 'user', user_id: userId, is_optional: false,
          })),
          need_notification: true,
        },
      });
    } catch {
      throw new RecruitmentCalendarError(
        'FEISHU_CALENDAR_ATTENDEES_OUTCOME_UNKNOWN',
        'conflict',
        '飞书日程已提交但参与人结果无法确认',
        undefined,
        eventId,
      );
    }
    return this.result(eventId, eventResponse.requestId);
  }

  async cancel(command: CancelRecruitmentCalendarCommand): Promise<RecruitmentCalendarResult> {
    assertCancelRecruitmentCalendarCommand(command);
    try {
      const response = await this.call({
        tenantId: command.tenantId,
        path: `${this.calendarPath(command.externalCalendarId)}`
          + `/events/${encodeURIComponent(command.externalEventId)}`,
        method: 'DELETE',
      });
      return this.result(command.externalEventId, response.requestId);
    } catch (error) {
      if (
        (error instanceof OrgPushError
          && (error.status === 404 || error.providerCode === 193001 || error.providerCode === 193003))
        || (error instanceof RecruitmentCalendarError
          && (error.code === 'FEISHU_CALENDAR_193001' || error.code === 'FEISHU_CALENDAR_193003'))
      ) return { externalEventId: command.externalEventId };
      throw error;
    }
  }

  private calendarPath(calendarId: string): string {
    return `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}`;
  }

  private async call(input: {
    readonly tenantId: string;
    readonly path: string;
    readonly method: 'POST' | 'PATCH' | 'DELETE';
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: Readonly<Record<string, unknown>>;
  }, allowTokenRefresh = true): Promise<{
    readonly data: Record<string, unknown> | undefined;
    readonly requestId: string | undefined;
  }> {
    const access = await this.tokens.getAccess(input.tenantId, 'feishu');
    let response;
    try {
      response = await this.http.request({
        origin: 'https://open.feishu.cn',
        path: input.path,
        method: input.method,
        headers: { Authorization: `Bearer ${access.accessToken}` },
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.body === undefined ? {} : { body: input.body }),
      });
    } catch (error) {
      if (allowTokenRefresh && error instanceof OrgPushError && error.status === 401) {
        this.tokens.invalidate(input.tenantId, 'feishu', access.accessToken);
        return this.call(input, false);
      }
      throw error;
    }
    const parsed = feishuResponseSchema.safeParse(response.body);
    if (!parsed.success) throw new RecruitmentCalendarError(
      'FEISHU_CALENDAR_RESPONSE_INVALID', 'retryable', '飞书日历响应无效',
    );
    if (parsed.data.code !== 0) throw new RecruitmentCalendarError(
      `FEISHU_CALENDAR_${Math.abs(parsed.data.code)}`,
      RETRYABLE_CODES.has(parsed.data.code) ? 'retryable' : 'business',
      '飞书日历业务调用失败',
    );
    return { data: parsed.data.data, requestId: response.requestId };
  }

  private protocolIdempotencyKey(value: string): string {
    const hex = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
      + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private requestId(value: string | undefined): string | undefined {
    return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : undefined;
  }

  private result(
    externalEventId: string,
    rawRequestId: string | undefined,
  ): RecruitmentCalendarResult {
    const requestId = this.requestId(rawRequestId);
    return requestId === undefined ? { externalEventId } : { externalEventId, requestId };
  }
}
