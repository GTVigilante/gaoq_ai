import { describe, expect, it, vi } from 'vitest';

import { DingTalkRecruitmentCalendarAdapter } from './dingtalk-recruitment-calendar.adapter.js';
import { FeishuRecruitmentCalendarAdapter } from './feishu-recruitment-calendar.adapter.js';
import type {
  OrgPlatformHttpRequest,
  OrgPlatformHttpResponse,
} from './org-platform-http.client.js';
import type { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgPushError } from './org-push.adapter.js';
import { RecruitmentCalendarError } from './recruitment-calendar.adapter.js';

const command = {
  tenantId: 'tenant-001', interviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X1', version: 1,
  externalCalendarId: 'recruitment-calendar', startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:00:00.000Z', timezone: 'Asia/Shanghai',
  organizerExternalId: 'user-001', attendeeExternalIds: ['user-001', 'user-002'],
  location: '会议室 A', currentExternalEventId: null,
  idempotencyKey: 'tenant-001:calendar:interview:1:upsert',
};

type Request = (input: OrgPlatformHttpRequest) => Promise<OrgPlatformHttpResponse>;

const cancelCommand = {
  tenantId: command.tenantId,
  interviewId: command.interviewId,
  version: 2,
  externalCalendarId: command.externalCalendarId,
  organizerExternalId: command.organizerExternalId,
  externalEventId: 'provider-event-001',
  idempotencyKey: 'tenant-001:calendar:interview:2:cancel',
};

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

  it('取消传递通知参数并过滤不可信 requestId', async () => {
    const request = vi.fn<Request>().mockResolvedValue({
      status: 200,
      requestId: 'bad request id',
      body: {},
    });
    const adapter = new DingTalkRecruitmentCalendarAdapter(tokenFixture().service, { request });
    await expect(adapter.cancel(cancelCommand)).resolves.toEqual({
      externalEventId: 'provider-event-001',
    });
    const input = request.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      method: 'DELETE',
      query: { pushNotification: true },
    });
    expect(input?.path).toContain('/events/provider-event-001');
  });

  it('取消已不存在事件按幂等成功，其他错误透传', async () => {
    const missing = vi.fn<Request>().mockRejectedValue(
      new OrgPushError('ORG_PLATFORM_HTTP_404', 'business', '不存在', 404),
    );
    await expect(new DingTalkRecruitmentCalendarAdapter(
      tokenFixture().service,
      { request: missing },
    ).cancel(cancelCommand)).resolves.toEqual({
      externalEventId: 'provider-event-001',
    });

    const failure = new OrgPushError('ORG_PLATFORM_HTTP_403', 'business', '禁止', 403);
    const denied = vi.fn<Request>().mockRejectedValue(failure);
    await expect(new DingTalkRecruitmentCalendarAdapter(
      tokenFixture().service,
      { request: denied },
    ).cancel(cancelCommand)).rejects.toBe(failure);
  });

  it.each([
    ['响应结构无效', { bad: true }, 'DINGTALK_CALENDAR_RESULT_UNKNOWN'],
    ['事件标识无效', { id: 'bad id' }, 'CALENDAR_EXTERNAL_EVENT_ID_INVALID'],
  ])('%s 时结果不确定且不自动重试', async (_label, body, code) => {
    const request = vi.fn<Request>().mockResolvedValue({
      status: 200,
      requestId: undefined,
      body,
    });
    const adapter = new DingTalkRecruitmentCalendarAdapter(tokenFixture().service, { request });
    await expect(adapter.upsert(command)).rejects.toMatchObject({
      code,
      category: 'conflict',
    });
  });

  it('令牌刷新后的第二次 401 直接抛出', async () => {
    const tokenStore = tokenFixture();
    const failure = new OrgPushError('ORG_PLATFORM_HTTP_401', 'business', '失败', 401);
    const request = vi.fn<Request>().mockRejectedValue(failure);
    const adapter = new DingTalkRecruitmentCalendarAdapter(tokenStore.service, { request });
    await expect(adapter.upsert(command)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(2);
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
      ...cancelCommand,
      externalEventId: 'fs-event-001',
    })).resolves.toEqual({ externalEventId: 'fs-event-001' });
  });

  it('更新事件不发送创建幂等参数并过滤非法 requestId', async () => {
    const request = vi.fn<Request>()
      .mockResolvedValueOnce({
        status: 200,
        requestId: 'bad request id',
        body: { code: 0, data: { event: { event_id: 'fs-event-001' } } },
      })
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { code: 0, data: {} } });
    const adapter = new FeishuRecruitmentCalendarAdapter(tokenFixture().service, { request });
    await expect(adapter.upsert({
      ...command,
      currentExternalEventId: 'fs-event-001',
    })).resolves.toEqual({ externalEventId: 'fs-event-001' });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'PATCH',
      query: { user_id_type: 'user_id' },
    });
    expect(request.mock.calls[0]?.[0].query).not.toHaveProperty('idempotency_key');
  });

  it('事件已建而参与人调用失败时携带已知事件标识进入人工核验', async () => {
    const request = vi.fn<Request>()
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { code: 0, data: { event: { event_id: 'fs-event-001' } } },
      })
      .mockRejectedValueOnce(new Error('网络中断'));
    const adapter = new FeishuRecruitmentCalendarAdapter(tokenFixture().service, { request });
    await expect(adapter.upsert(command)).rejects.toMatchObject({
      code: 'FEISHU_CALENDAR_ATTENDEES_OUTCOME_UNKNOWN',
      category: 'conflict',
      externalEventId: 'fs-event-001',
    });
  });

  it.each([
    ['成功响应缺少事件', { code: 0, data: {} }, 'FEISHU_CALENDAR_RESULT_UNKNOWN', 'conflict'],
    ['响应结构非法', { bad: true }, 'FEISHU_CALENDAR_RESPONSE_INVALID', 'retryable'],
    ['可重试业务码', { code: 190003 }, 'FEISHU_CALENDAR_190003', 'retryable'],
    ['不可重试业务码', { code: 190099 }, 'FEISHU_CALENDAR_190099', 'business'],
    ['负业务码', { code: -7 }, 'FEISHU_CALENDAR_7', 'business'],
  ])('%s 分类稳定', async (_label, body, code, category) => {
    const request = vi.fn<Request>().mockResolvedValue({
      status: 200,
      requestId: undefined,
      body,
    });
    const adapter = new FeishuRecruitmentCalendarAdapter(tokenFixture().service, { request });
    await expect(adapter.upsert(command)).rejects.toMatchObject({ code, category });
  });

  it.each([
    new OrgPushError('ORG_PLATFORM_HTTP_404', 'business', '不存在', 404),
    new OrgPushError('ORG_PLATFORM_HTTP_403', 'business', '不存在', 403, 193001),
    new RecruitmentCalendarError('FEISHU_CALENDAR_193003', 'business', '不存在'),
  ])('多种不存在语义均按幂等取消成功', async (failure) => {
    const request = vi.fn<Request>().mockRejectedValue(failure);
    const adapter = new FeishuRecruitmentCalendarAdapter(tokenFixture().service, { request });
    await expect(adapter.cancel(cancelCommand)).resolves.toEqual({
      externalEventId: 'provider-event-001',
    });
  });

  it('取消成功保留合法 requestId，其他错误透传', async () => {
    const request = vi.fn<Request>().mockResolvedValue({
      status: 200,
      requestId: 'fs-cancel-request',
      body: { code: 0, data: {} },
    });
    const adapter = new FeishuRecruitmentCalendarAdapter(tokenFixture().service, { request });
    await expect(adapter.cancel(cancelCommand)).resolves.toEqual({
      externalEventId: 'provider-event-001',
      requestId: 'fs-cancel-request',
    });

    const failure = new RecruitmentCalendarError('FEISHU_CALENDAR_190099', 'business', '拒绝');
    const denied = new FeishuRecruitmentCalendarAdapter(
      tokenFixture().service,
      { request: vi.fn<Request>().mockRejectedValue(failure) },
    );
    await expect(denied.cancel(cancelCommand)).rejects.toBe(failure);
  });

  it('401 仅刷新一次，第二次失败透传', async () => {
    const tokenStore = tokenFixture();
    const failure = new OrgPushError('ORG_PLATFORM_HTTP_401', 'business', '失败', 401);
    const request = vi.fn<Request>().mockRejectedValue(failure);
    const adapter = new FeishuRecruitmentCalendarAdapter(tokenStore.service, { request });
    await expect(adapter.cancel(cancelCommand)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(2);
    expect(tokenStore.invalidate).toHaveBeenCalledOnce();
  });
});
