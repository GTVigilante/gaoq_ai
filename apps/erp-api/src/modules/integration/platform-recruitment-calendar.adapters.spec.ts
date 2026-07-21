import { describe, expect, it, vi } from 'vitest';

import { DingTalkRecruitmentCalendarAdapter } from './dingtalk-recruitment-calendar.adapter.js';
import { FeishuRecruitmentCalendarAdapter } from './feishu-recruitment-calendar.adapter.js';
import type {
  OrgPlatformHttpRequest,
  OrgPlatformHttpResponse,
} from './org-platform-http.client.js';
import type { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgPushError } from './org-push.adapter.js';

const command = {
  tenantId: 'tenant-001', interviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X1', version: 1,
  externalCalendarId: 'recruitment-calendar', startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:00:00.000Z', timezone: 'Asia/Shanghai',
  organizerExternalId: 'user-001', attendeeExternalIds: ['user-001', 'user-002'],
  location: '会议室 A', currentExternalEventId: null,
  idempotencyKey: 'tenant-001:calendar:interview:1:upsert',
};

type Request = (input: OrgPlatformHttpRequest) => Promise<OrgPlatformHttpResponse>;

function tokenFixture() {
  const invalidate = vi.fn();
  const service = {
    getAccess: vi.fn().mockImplementation((_tenantId: string, channel: string) => Promise.resolve({
      accessToken: `${channel}-access-token`, externalTenantId: 'external-tenant',
    })),
    invalidate,
  } as unknown as OrgPlatformTokenService;
  return { service, invalidate };
}

describe('DingTalkRecruitmentCalendarAdapter', () => {
  it('以稳定幂等键原子创建日程与参与人', async () => {
    const request = vi.fn<Request>().mockResolvedValue({
      status: 200, requestId: 'dt-request', body: { id: 'dt-event-001' },
    });
    const adapter = new DingTalkRecruitmentCalendarAdapter(tokenFixture().service, { request });

    await expect(adapter.upsert(command)).resolves.toEqual({
      externalEventId: 'dt-event-001', requestId: 'dt-request',
    });
    const input = request.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      origin: 'https://api.dingtalk.com',
      path: '/v1.0/calendar/users/user-001/calendars/recruitment-calendar/events',
      method: 'POST',
    });
    expect(input?.headers?.['x-acs-dingtalk-access-token']).toBe('dingtalk-access-token');
    expect(input?.headers?.['x-client-token']).toMatch(/^[a-f0-9-]{36}$/);
    expect(input?.body).toMatchObject({
        summary: '招聘面试', location: { displayName: '会议室 A' },
        attendees: [
          { id: 'user-001', isOptional: false },
          { id: 'user-002', isOptional: false },
        ],
    });
  });

  it('更新复用外部事件标识，401 时只刷新一次令牌', async () => {
    const tokenStore = tokenFixture();
    const request = vi.fn<Request>()
      .mockRejectedValueOnce(new OrgPushError('ORG_PLATFORM_HTTP_401', 'business', '失败', 401))
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { id: 'dt-event-001' } });
    const adapter = new DingTalkRecruitmentCalendarAdapter(tokenStore.service, { request });

    await adapter.upsert({ ...command, currentExternalEventId: 'dt-event-001' });

    expect(request.mock.calls[1]?.[0]).toMatchObject({
      method: 'PUT',
      path: '/v1.0/calendar/users/user-001/calendars/recruitment-calendar/events/dt-event-001',
    });
    expect(tokenStore.invalidate).toHaveBeenCalledOnce();
  });
});

describe('FeishuRecruitmentCalendarAdapter', () => {
  it('幂等创建日程后按 user_id 批量添加参与人', async () => {
    const request = vi.fn<Request>()
      .mockResolvedValueOnce({
        status: 200, requestId: 'fs-request',
        body: { code: 0, data: { event: { event_id: 'fs-event-001' } } },
      })
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { code: 0, data: {} } });
    const adapter = new FeishuRecruitmentCalendarAdapter(tokenFixture().service, { request });

    await expect(adapter.upsert(command)).resolves.toEqual({
      externalEventId: 'fs-event-001', requestId: 'fs-request',
    });
    const createInput = request.mock.calls[0]?.[0];
    expect(createInput).toMatchObject({
      method: 'POST',
      path: '/open-apis/calendar/v4/calendars/recruitment-calendar/events',
      query: { user_id_type: 'user_id' },
    });
    expect(createInput?.query?.idempotency_key).toMatch(/^[a-f0-9-]{36}$/);
    expect(createInput?.body).toMatchObject({
      summary: '招聘面试', visibility: 'private', location: { name: '会议室 A' },
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      path: '/open-apis/calendar/v4/calendars/recruitment-calendar/events/fs-event-001/attendees',
      query: { user_id_type: 'user_id' },
      body: {
        attendees: [
          { type: 'user', user_id: 'user-001', is_optional: false },
          { type: 'user', user_id: 'user-002', is_optional: false },
        ],
        need_notification: true,
      },
    });
  });

  it('删除已不存在的日程按幂等成功处理', async () => {
    const request = vi.fn<Request>().mockRejectedValue(
      new OrgPushError('ORG_PLATFORM_HTTP_403', 'business', '已删除', 403, 193003),
    );
    const adapter = new FeishuRecruitmentCalendarAdapter(tokenFixture().service, { request });

    await expect(adapter.cancel({
      tenantId: command.tenantId, interviewId: command.interviewId, version: 2,
      externalCalendarId: command.externalCalendarId,
      organizerExternalId: command.organizerExternalId,
      externalEventId: 'fs-event-001', idempotencyKey: 'cancel-key',
    })).resolves.toEqual({ externalEventId: 'fs-event-001' });
  });
});
