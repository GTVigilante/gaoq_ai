import { describe, expect, it, vi } from 'vitest';

import {
  AttendanceProviderRegistry,
  DingTalkAttendanceProvider,
  FeishuAttendanceProvider,
  type AttendanceProviderPullInput,
} from './attendance-provider.adapter.js';
import type {
  OrgPlatformHttpRequest,
  OrgPlatformHttpResponse,
} from './org-platform-http.client.js';
import type { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgPushError } from './org-push.adapter.js';

type Request = (input: OrgPlatformHttpRequest) => Promise<OrgPlatformHttpResponse>;
interface DingTestRecord {
  id: number | string;
  userId: string;
  userCheckTime: number | string;
  checkType: 'OnDuty' | 'OffDuty';
  locationResult?: string;
}
interface DingTestBody {
  errcode: number;
  request_id?: string;
  recordresult: DingTestRecord[];
  [key: string]: unknown;
}
interface FeishuTestRecord {
  user_id: string;
  check_time: string;
  record_id?: string;
}
interface FeishuTestSlot {
  check_in_record_id: string;
  check_in_record?: FeishuTestRecord;
  check_out_record_id: string;
  check_out_record?: FeishuTestRecord;
}
interface FeishuTestTask {
  result_id: string;
  user_id: string;
  records: FeishuTestSlot[];
}
interface FeishuTestBody {
  code: number;
  data: {
    user_task_results: FeishuTestTask[];
    invalid_user_ids: string[];
    unauthorized_user_ids: string[];
  };
  [key: string]: unknown;
}

const DING_MILLIS = Date.parse('2026-07-22T01:30:00.000Z');
const FEISHU_SECONDS = String(Date.parse('2026-07-22T10:30:00.000Z') / 1_000);
const pullInput: AttendanceProviderPullInput = {
  tenantId: 'tenant-001',
  externalEmployeeIds: ['external-user-001'],
  fromDate: '2026-07-20',
  toDate: '2026-07-22',
  timeZone: 'Asia/Shanghai',
};

function tokenFixture() {
  const access = {
    accessToken: 'platform-token',
    externalTenantId: 'external-tenant',
    clientId: 'app-001',
  };
  const getAccess = vi.fn().mockResolvedValue(access);
  const invalidate = vi.fn();
  return {
    service: {
      getAccess,
      invalidate,
    } as unknown as OrgPlatformTokenService,
    getAccess,
    invalidate,
  };
}

function dingBody(overrides: Record<string, unknown> = {}): DingTestBody {
  return {
    errcode: 0,
    recordresult: [{
      id: 9001,
      userId: 'external-user-001',
      userCheckTime: DING_MILLIS,
      checkType: 'OnDuty',
      locationResult: 'Normal',
    }],
    ...overrides,
  };
}

function feishuBody(overrides: Record<string, unknown> = {}): FeishuTestBody {
  return {
    code: 0,
    data: {
      user_task_results: [{
        result_id: 'result-001',
        user_id: 'external-user-001',
        records: [{
          check_in_record_id: '',
          check_out_record_id: 'flow-out-001',
          check_out_record: {
            user_id: 'external-user-001',
            check_time: FEISHU_SECONDS,
            record_id: 'flow-out-001',
          },
        }],
      }],
      invalid_user_ids: [],
      unauthorized_user_ids: [],
    },
    ...overrides,
  };
}

function dingProvider(
  body: unknown = dingBody(),
  requestId: string | null | undefined = 'ding-request-001',
) {
  const tokens = tokenFixture();
  const request = vi.fn<Request>().mockResolvedValue({
    status: 200,
    requestId: requestId === null ? undefined : requestId,
    body,
  });
  return {
    provider: new DingTalkAttendanceProvider(tokens.service, { request }),
    request,
    tokens,
  };
}

function feishuProvider(
  body: unknown = feishuBody(),
  requestId: string | null | undefined = 'feishu-request-001',
) {
  const tokens = tokenFixture();
  const request = vi.fn<Request>().mockResolvedValue({
    status: 200,
    requestId: requestId === null ? undefined : requestId,
    body,
  });
  return {
    provider: new FeishuAttendanceProvider(tokens.service, { request }),
    request,
    tokens,
  };
}

describe('考勤 Provider 请求与标准化契约', () => {
  it('钉钉只通过敏感查询参数传令牌并形成 v2 不可变证据', async () => {
    const { provider, request } = dingProvider();
    const events = await provider.pullBatch(pullInput);
    expect(provider.schemaVersion).toBe('dingtalk-list-record-v2');
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      origin: 'https://oapi.dingtalk.com',
      path: '/attendance/listRecord',
      method: 'POST',
      sensitiveQuery: { access_token: 'platform-token' },
      body: {
        userIds: ['external-user-001'],
        checkDateFrom: '2026-07-20 00:00:00',
        checkDateTo: '2026-07-22 23:59:59',
        isI18n: true,
      },
    });
    expect(events).toHaveLength(1);
    expect(provider.normalize(events[0]?.payload, pullInput.timeZone)).toMatchObject({
      externalEmployeeId: 'external-user-001',
      externalEventId: '9001',
      factType: 'punch_in',
      timeZone: 'Asia/Shanghai',
      impact: { workedMinutes: 0, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
    });
    expect(provider.verify(events[0]?.payload, 'ding-request-001')).toBe(true);
  });

  it('飞书固定授权查询并把出卡记录拆为可反向绑定的 v2 证据', async () => {
    const { provider, request } = feishuProvider();
    const events = await provider.pullBatch(pullInput);
    expect(provider.schemaVersion).toBe('feishu-user-task-v2');
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/attendance/v1/user_tasks/query',
      method: 'POST',
      headers: { authorization: 'Bearer platform-token' },
      query: { employee_type: 'employee_id', ignore_invalid_users: false },
      body: {
        user_ids: ['external-user-001'],
        check_date_from: 20260720,
        check_date_to: 20260722,
        need_overtime_result: false,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      externalEventId: 'flow-out-001',
      source: {
        resultId: 'result-001',
        slotIndex: 0,
        providerRecordId: 'flow-out-001',
      },
    });
    expect(provider.normalize(events[0]?.payload, pullInput.timeZone)).toMatchObject({
      externalEmployeeId: 'external-user-001',
      externalEventId: 'flow-out-001',
      factType: 'punch_out',
    });
    expect(provider.verify(events[0]?.payload, 'feishu-request-001')).toBe(true);
  });

  it('飞书没有平台记录 ID 时使用稳定摘要事件 ID且仍可验证来源', async () => {
    const body = feishuBody();
    const data = body.data.user_task_results[0]!.records[0]!;
    data.check_out_record_id = '';
    delete data.check_out_record?.record_id;
    const { provider } = feishuProvider(body);
    const first = await provider.pullBatch(pullInput);
    const second = await provider.pullBatch(pullInput);
    expect(first[0]?.externalEventId).toMatch(/^derived:[A-Za-z0-9_-]{43}$/u);
    expect(second[0]?.externalEventId).toBe(first[0]?.externalEventId);
    expect(provider.verify(first[0]?.payload, 'feishu-request-001')).toBe(true);
  });

  it('飞书同一时段的上下班记录形成两个方向明确的事实', async () => {
    const body = feishuBody();
    body.data.user_task_results[0]!.records[0] = {
      check_in_record_id: 'flow-in-001',
      check_in_record: {
        user_id: 'external-user-001',
        check_time: FEISHU_SECONDS,
        record_id: 'flow-in-001',
      },
      check_out_record_id: 'flow-out-001',
      check_out_record: {
        user_id: 'external-user-001',
        check_time: FEISHU_SECONDS,
        record_id: 'flow-out-001',
      },
    };
    const { provider } = feishuProvider(body);
    const events = await provider.pullBatch(pullInput);
    expect(events.map((event) =>
      provider.normalize(event.payload, pullInput.timeZone).factType))
      .toEqual(['punch_in', 'punch_out']);
  });

  it('空打卡结果是合法零事实批次', async () => {
    const { provider } = feishuProvider({
      code: 0,
      data: { user_task_results: [], invalid_user_ids: [], unauthorized_user_ids: [] },
    });
    await expect(provider.pullBatch(pullInput)).resolves.toEqual([]);
  });
});

describe('考勤 Provider 请求闭包', () => {
  it.each([
    ['空员工批次', { ...pullInput, externalEmployeeIds: [] }],
    ['超过五十人', {
      ...pullInput,
      externalEmployeeIds: Array.from({ length: 51 }, (_, index) => `employee-${index}`),
    }],
    ['重复员工', {
      ...pullInput,
      externalEmployeeIds: ['external-user-001', 'external-user-001'],
    }],
    ['含空格员工', { ...pullInput, externalEmployeeIds: ['external user'] }],
    ['非规范员工', { ...pullInput, externalEmployeeIds: ['ｅmployee'] }],
    ['非法租户', { ...pullInput, tenantId: 'tenant/001' }],
    ['额外字段', { ...pullInput, actorTenantId: 'tenant-002' }],
  ])('%s在网络请求前失败关闭', async (_label, candidate) => {
    const { provider, request } = dingProvider();
    await expect(provider.pullBatch(candidate))
      .rejects.toThrow('ATTENDANCE_PROVIDER_EMPLOYEE_BATCH_INVALID');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['日期格式', { ...pullInput, fromDate: '2026/07/20' }],
    ['不存在日期', { ...pullInput, fromDate: '2026-02-30' }],
    ['逆序窗口', { ...pullInput, fromDate: '2026-07-23' }],
    ['超过七天', { ...pullInput, fromDate: '2026-07-15' }],
  ])('%s非法时拒绝拉取', async (_label, candidate) => {
    const { provider } = feishuProvider();
    await expect(provider.pullBatch(candidate)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_WINDOW_INVALID',
    );
  });

  it.each(['Bad/Zone', 'Asia /Shanghai', ''])('非法时区 %j 被拒绝', async (timeZone) => {
    const { provider } = feishuProvider();
    await expect(provider.pullBatch({ ...pullInput, timeZone })).rejects.toThrow(
      'ATTENDANCE_PROVIDER_TIME_ZONE_INVALID',
    );
  });

  it('钉钉明确拒绝非上海时区', async () => {
    const { provider } = dingProvider();
    await expect(provider.pullBatch({ ...pullInput, timeZone: 'Asia/Hong_Kong' }))
      .rejects.toThrow('ATTENDANCE_DINGTALK_TIME_ZONE_UNSUPPORTED');
  });
});

describe('考勤 Provider 响应闭包', () => {
  it.each([
    ['Schema 漂移', { invalid: true }],
    ['平台失败码', dingBody({ errcode: 88 })],
  ])('钉钉%s整批失败', async (_label, body) => {
    const { provider } = dingProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_DINGTALK_RESPONSE_INVALID',
    );
  });

  it('钉钉拒绝请求外员工', async () => {
    const body = dingBody();
    body.recordresult[0]!.userId = 'external-user-002';
    const { provider } = dingProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_EMPLOYEE_SCOPE_MISMATCH',
    );
  });

  it('钉钉拒绝窗口外事实', async () => {
    const body = dingBody();
    body.recordresult[0]!.userCheckTime = Date.parse('2026-07-23T01:00:00.000Z');
    const { provider } = dingProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_EVENT_WINDOW_MISMATCH',
    );
  });

  it('钉钉拒绝重复事件 ID', async () => {
    const body = dingBody();
    body.recordresult.push({ ...body.recordresult[0]! });
    const { provider } = dingProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_EVENT_DUPLICATE',
    );
  });

  it('钉钉拒绝不可形成真实时间的事实', async () => {
    const body = dingBody();
    body.recordresult[0]!.userCheckTime = Number.MAX_SAFE_INTEGER;
    const { provider } = dingProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_TIME_INVALID',
    );
  });

  it.each([
    ['Schema 漂移', { invalid: true }],
    ['失败码', feishuBody({ code: 88 })],
    ['缺少 data', { code: 0 }],
  ])('飞书%s整批失败', async (_label, body) => {
    const { provider } = feishuProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_FEISHU_RESPONSE_INVALID',
    );
  });

  it.each(['invalid_user_ids', 'unauthorized_user_ids'] as const)(
    '飞书返回 %s 时整批失败',
    async (field) => {
      const body = feishuBody();
      body.data[field] = ['external-user-002'];
      const { provider } = feishuProvider(body);
      await expect(provider.pullBatch(pullInput)).rejects.toThrow(
        'ATTENDANCE_FEISHU_EMPLOYEE_SCOPE_MISMATCH',
      );
    },
  );

  it('飞书拒绝请求外任务员工', async () => {
    const body = feishuBody();
    body.data.user_task_results[0]!.user_id = 'external-user-002';
    const { provider } = feishuProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_EMPLOYEE_SCOPE_MISMATCH',
    );
  });

  it('飞书拒绝嵌套记录员工与任务员工不一致', async () => {
    const body = feishuBody();
    body.data.user_task_results[0]!.records[0]!.check_out_record!.user_id =
      'external-user-002';
    const { provider } = feishuProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_EMPLOYEE_SCOPE_MISMATCH',
    );
  });

  it('飞书拒绝重复任务和重复事件', async () => {
    const taskBody = feishuBody();
    taskBody.data.user_task_results.push({ ...taskBody.data.user_task_results[0]! });
    await expect(feishuProvider(taskBody).provider.pullBatch(pullInput))
      .rejects.toThrow('ATTENDANCE_FEISHU_TASK_DUPLICATE');

    const eventBody = feishuBody();
    const slot = eventBody.data.user_task_results[0]!.records[0]!;
    eventBody.data.user_task_results[0]!.records.push({ ...slot });
    await expect(feishuProvider(eventBody).provider.pullBatch(pullInput))
      .rejects.toThrow('ATTENDANCE_PROVIDER_EVENT_DUPLICATE');
  });

  it('飞书拒绝响应中的两个记录 ID 互相矛盾', async () => {
    const body = feishuBody();
    body.data.user_task_results[0]!.records[0]!.check_out_record!.record_id =
      'other-record-001';
    const { provider } = feishuProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_FEISHU_RECORD_ID_MISMATCH',
    );
  });

  it('飞书拒绝窗口外事实', async () => {
    const body = feishuBody();
    body.data.user_task_results[0]!.records[0]!.check_out_record!.check_time =
      String(Date.parse('2026-07-23T10:30:00.000Z') / 1_000);
    const { provider } = feishuProvider(body);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_EVENT_WINDOW_MISMATCH',
    );
  });
});

describe('考勤 Provider 传输证据与令牌恢复', () => {
  it.each([
    [null, {}],
    [null, { request_id: 'bad id' }],
  ])('缺少规范请求 ID 时不形成 Inbox 证据', async (requestId, extra) => {
    const { provider } = dingProvider(dingBody(extra), requestId);
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      !('request_id' in extra)
        ? 'ATTENDANCE_PROVIDER_REQUEST_ID_MISSING'
        : 'ATTENDANCE_DINGTALK_RESPONSE_INVALID',
    );
  });

  it('响应体中的规范请求 ID可作为传输证据', async () => {
    const { provider } = dingProvider(dingBody({ request_id: 'body-request-001' }), null);
    const events = await provider.pullBatch(pullInput);
    expect(events[0]?.transportRequestId).toBe('body-request-001');
  });

  it.each(['short', 'request id', 'request\n001'])(
    'Verifier 拒绝非法请求 ID %j',
    async (requestId) => {
      const { provider } = dingProvider();
      const [event] = await provider.pullBatch(pullInput);
      expect(provider.verify(event?.payload, requestId)).toBe(false);
    },
  );

  it('Verifier 拒绝畸形、错位、未来和逆序证据', async () => {
    const { provider } = dingProvider();
    const [event] = await provider.pullBatch(pullInput);
    const payload = event?.payload as Record<string, unknown>;
    expect(provider.verify({ ...payload, extra: true }, 'ding-request-001')).toBe(false);
    expect(provider.verify(
      { ...payload, externalEventId: 'other-event' },
      'ding-request-001',
    )).toBe(false);
    expect(provider.verify(
      { ...payload, pulledAt: '2999-01-01T00:00:00.000Z' },
      'ding-request-001',
    )).toBe(false);
    expect(provider.verify(
      { ...payload, pulledAt: '2026-07-22T09:30:00+08:00' },
      'ding-request-001',
    )).toBe(false);
    expect(provider.verify({
      ...payload,
      pulledAt: '2020-01-01T00:00:00.000Z',
    }, 'ding-request-001')).toBe(false);
  });

  it('飞书 Verifier 拒绝来源删除、事件错位和不可解析时间', async () => {
    const { provider } = feishuProvider();
    const [event] = await provider.pullBatch(pullInput);
    const payload = event?.payload as Record<string, unknown>;
    const withoutSource = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== 'source'),
    );
    expect(provider.verify(withoutSource, 'feishu-request-001')).toBe(false);
    expect(provider.verify(
      { ...payload, externalEventId: 'other-event' },
      'feishu-request-001',
    )).toBe(false);
    expect(provider.verify({
      ...payload,
      record: { ...(payload['record'] as object), check_time: '999999999999' },
    }, 'feishu-request-001')).toBe(false);
  });

  it('Normalizer 拒绝非法时区和错位事件', async () => {
    const ding = dingProvider();
    const [dingEvent] = await ding.provider.pullBatch(pullInput);
    expect(() => ding.provider.normalize(dingEvent?.payload, 'Bad/Zone'))
      .toThrow('ATTENDANCE_PROVIDER_TIME_ZONE_INVALID');
    expect(() => ding.provider.normalize({
      ...(dingEvent?.payload as object),
      externalEventId: 'other-event',
    }, pullInput.timeZone)).toThrow();

    const feishu = feishuProvider();
    const [feishuEvent] = await feishu.provider.pullBatch(pullInput);
    expect(() => feishu.provider.normalize(feishuEvent?.payload, 'Asia /Shanghai'))
      .toThrow('ATTENDANCE_PROVIDER_TIME_ZONE_INVALID');
  });

  it('401 只刷新一次令牌，第二次成功后返回事实', async () => {
    const tokens = tokenFixture();
    const request = vi.fn<Request>()
      .mockRejectedValueOnce(new OrgPushError(
        'TOKEN_EXPIRED', 'retryable', 'token expired', 401,
      ))
      .mockResolvedValueOnce({
        status: 200,
        requestId: 'ding-request-001',
        body: dingBody(),
      });
    const provider = new DingTalkAttendanceProvider(tokens.service, { request });
    await expect(provider.pullBatch(pullInput)).resolves.toHaveLength(1);
    expect(tokens.getAccess).toHaveBeenCalledTimes(2);
    expect(tokens.invalidate).toHaveBeenCalledWith(
      'tenant-001',
      'dingtalk',
      'platform-token',
    );
  });

  it('第二次 401 和非 401 错误原样失败且不会无限刷新', async () => {
    const tokens = tokenFixture();
    const unauthorized = new OrgPushError(
      'TOKEN_EXPIRED', 'retryable', 'token expired', 401,
    );
    const request = vi.fn<Request>().mockRejectedValue(unauthorized);
    const provider = new FeishuAttendanceProvider(tokens.service, { request });
    await expect(provider.pullBatch(pullInput)).rejects.toBe(unauthorized);
    expect(request).toHaveBeenCalledTimes(2);
    expect(tokens.invalidate).toHaveBeenCalledOnce();

    const rejected = new OrgPushError('RATE_LIMITED', 'retryable', 'limited', 429);
    const otherRequest = vi.fn<Request>().mockRejectedValue(rejected);
    const other = new DingTalkAttendanceProvider(tokens.service, { request: otherRequest });
    await expect(other.pullBatch(pullInput)).rejects.toBe(rejected);
    expect(otherRequest).toHaveBeenCalledOnce();
  });
});

describe('考勤 Provider 注册表', () => {
  it('要求双平台三角色唯一齐备并提供精确解析', () => {
    const ding = dingProvider().provider;
    const feishu = feishuProvider().provider;
    const registry = new AttendanceProviderRegistry(
      [ding, feishu],
      [ding, feishu],
      [ding, feishu],
    );
    expect(registry.adapter('dingtalk')).toBe(ding);
    expect(registry.normalizer('feishu')).toBe(feishu);
    expect(registry.verifier('dingtalk')).toBe(ding);
    expect(() => registry.adapter('unknown' as never))
      .toThrow('ATTENDANCE_PROVIDER_ADAPTER_MISSING');
  });

  it('拒绝重复角色或缺少任一平台角色', () => {
    const ding = dingProvider().provider;
    const feishu = feishuProvider().provider;
    expect(() => new AttendanceProviderRegistry(
      [ding, ding, feishu],
      [ding, feishu],
      [ding, feishu],
    )).toThrow('ATTENDANCE_PROVIDER_ADAPTER_DUPLICATE');
    expect(() => new AttendanceProviderRegistry(
      [ding, feishu],
      [ding, ding, feishu],
      [ding, feishu],
    )).toThrow('ATTENDANCE_PROVIDER_NORMALIZER_DUPLICATE');
    expect(() => new AttendanceProviderRegistry(
      [ding, feishu],
      [ding, feishu],
      [ding, ding, feishu],
    )).toThrow('ATTENDANCE_PROVIDER_VERIFIER_DUPLICATE');
    expect(() => new AttendanceProviderRegistry([ding], [ding], [ding]))
      .toThrow('ATTENDANCE_PROVIDER_REGISTRY_INCOMPLETE');
  });
});
