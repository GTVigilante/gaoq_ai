import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrgPlatformHttpClient } from './org-platform-http.client.js';
import { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgPushError } from './org-push.adapter.js';
import {
  RecruitmentCalendarAdapter,
  type CancelRecruitmentCalendarCommand,
  type RecruitmentCalendarResult,
  type UpsertRecruitmentCalendarCommand,
} from './recruitment-calendar.adapter.js';

const eventResponseSchema = z.object({ id: z.string().min(1).max(512) }).passthrough();

/** 钉钉 Calendar 1.0 适配器；令牌仅在调用时从安全凭据服务取得。 */
@Injectable()
export class DingTalkRecruitmentCalendarAdapter extends RecruitmentCalendarAdapter {
  readonly channel = 'dingtalk' as const;

  constructor(
    private readonly tokens: OrgPlatformTokenService,
    private readonly http: OrgPlatformHttpClient,
  ) {
    super();
  }

  async upsert(command: UpsertRecruitmentCalendarCommand): Promise<RecruitmentCalendarResult> {
    const eventId = command.currentExternalEventId;
    const response = await this.call({
      tenantId: command.tenantId,
      path: eventId === null
        ? this.eventsPath(command)
        : `${this.eventsPath(command)}/${encodeURIComponent(eventId)}`,
      method: eventId === null ? 'POST' : 'PUT',
      idempotencyKey: command.idempotencyKey,
      body: {
        summary: '招聘面试',
        isAllDay: false,
        freeBusyStatus: 'busy',
        start: { dateTime: command.startsAt, timeZone: command.timezone },
        end: { dateTime: command.endsAt, timeZone: command.timezone },
        location: { displayName: command.location },
        attendees: command.attendeeExternalIds.map((id) => ({ id, isOptional: false })),
      },
    });
    const parsed = eventResponseSchema.safeParse(response.body);
    if (!parsed.success) throw new OrgPushError(
      'DINGTALK_CALENDAR_RESPONSE_INVALID', 'retryable', '钉钉日程响应无效',
    );
    return {
      externalEventId: parsed.data.id,
      ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    };
  }

  async cancel(command: CancelRecruitmentCalendarCommand): Promise<RecruitmentCalendarResult> {
    try {
      const response = await this.call({
        tenantId: command.tenantId,
        path: `${this.eventsPath(command)}/${encodeURIComponent(command.externalEventId)}`,
        method: 'DELETE',
        idempotencyKey: command.idempotencyKey,
        query: { pushNotification: true },
      });
      return {
        externalEventId: command.externalEventId,
        ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
      };
    } catch (error) {
      if (error instanceof OrgPushError && error.status === 404) {
        return { externalEventId: command.externalEventId };
      }
      throw error;
    }
  }

  private eventsPath(command: {
    readonly organizerExternalId: string;
    readonly externalCalendarId: string;
  }): string {
    return `/v1.0/calendar/users/${encodeURIComponent(command.organizerExternalId)}`
      + `/calendars/${encodeURIComponent(command.externalCalendarId)}/events`;
  }

  private async call(input: {
    readonly tenantId: string;
    readonly path: string;
    readonly method: 'POST' | 'PUT' | 'DELETE';
    readonly idempotencyKey: string;
    readonly query?: Readonly<Record<string, string | number | boolean>>;
    readonly body?: Readonly<Record<string, unknown>>;
  }, allowTokenRefresh = true): Promise<{
    readonly body: unknown;
    readonly requestId: string | undefined;
  }> {
    const access = await this.tokens.getAccess(input.tenantId, 'dingtalk');
    try {
      const response = await this.http.request({
        origin: 'https://api.dingtalk.com',
        path: input.path,
        method: input.method,
        headers: {
          'x-acs-dingtalk-access-token': access.accessToken,
          'x-client-token': this.protocolIdempotencyKey(input.idempotencyKey),
        },
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      return { body: response.body, requestId: response.requestId };
    } catch (error) {
      if (allowTokenRefresh && error instanceof OrgPushError && error.status === 401) {
        this.tokens.invalidate(input.tenantId, 'dingtalk', access.accessToken);
        return this.call(input, false);
      }
      throw error;
    }
  }

  private protocolIdempotencyKey(value: string): string {
    const hex = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
      + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
