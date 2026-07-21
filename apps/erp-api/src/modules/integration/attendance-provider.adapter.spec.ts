import { describe, expect, it, vi } from 'vitest';

import {
  AttendanceProviderRegistry,
  DingTalkAttendanceProvider,
  FeishuAttendanceProvider,
} from './attendance-provider.adapter.js';
import type {
  OrgPlatformHttpRequest,
  OrgPlatformHttpResponse,
} from './org-platform-http.client.js';
import type { OrgPlatformTokenService } from './org-platform-token.service.js';

type Request = (input: OrgPlatformHttpRequest) => Promise<OrgPlatformHttpResponse>;

function tokenFixture(): OrgPlatformTokenService {
  return {
    getAccess: vi.fn().mockImplementation((_tenantId: string, channel: string) => Promise.resolve({
      accessToken: `${channel}-token`, externalTenantId: 'external-tenant', clientId: 'app-001',
    })),
  } as unknown as OrgPlatformTokenService;
}

const pullInput = {
  tenantId: 'tenant-001', externalEmployeeIds: ['external-user-001'],
  fromDate: '2026-07-20', toDate: '2026-07-22', timeZone: 'Asia/Shanghai',
};

describe('考勤 Provider 契约', () => {
  it('钉钉只通过敏感查询参数传令牌并标准化上下班卡', async () => {
    const request = vi.fn<Request>().mockResolvedValue({
      status: 200, requestId: 'ding-request-001', body: {
        errcode: 0,
        recordresult: [{
          id: 9001, userId: 'external-user-001', userCheckTime: 1_753_157_600_000,
          checkType: 'OnDuty', locationResult: 'Normal',
        }],
      },
    });
    const provider = new DingTalkAttendanceProvider(tokenFixture(), { request });

    const events = await provider.pullBatch(pullInput);

    expect(request.mock.calls[0]?.[0]).toMatchObject({
      origin: 'https://oapi.dingtalk.com', path: '/attendance/listRecord', method: 'POST',
      sensitiveQuery: { access_token: 'dingtalk-token' },
      body: {
        userIds: ['external-user-001'],
        checkDateFrom: '2026-07-20 00:00:00', checkDateTo: '2026-07-22 23:59:59',
      },
    });
    expect(events).toHaveLength(1);
    const normalized = provider.normalize(events[0]?.payload, pullInput.timeZone);
    expect(normalized).toMatchObject({
      externalEmployeeId: 'external-user-001', externalEventId: '9001',
      factType: 'punch_in', timeZone: 'Asia/Shanghai',
      impact: { workedMinutes: 0, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
    });
    expect(provider.verify(events[0]?.payload, 'ding-request-001')).toBe(true);
  });

  it('飞书使用 tenant token 查询打卡结果并把出卡记录拆为不可变事实', async () => {
    const request = vi.fn<Request>().mockResolvedValue({
      status: 200, requestId: 'feishu-request-001', body: {
        code: 0,
        data: {
          user_task_results: [{
            result_id: 'result-001', user_id: 'external-user-001',
            records: [{
              check_in_record_id: '',
              check_out_record_id: 'flow-out-001',
              check_out_record: {
                user_id: 'external-user-001', check_time: '1753157600', record_id: 'flow-out-001',
              },
            }],
          }],
          invalid_user_ids: [], unauthorized_user_ids: [],
        },
      },
    });
    const provider = new FeishuAttendanceProvider(tokenFixture(), { request });

    const events = await provider.pullBatch(pullInput);

    expect(request.mock.calls[0]?.[0]).toMatchObject({
      origin: 'https://open.feishu.cn', path: '/open-apis/attendance/v1/user_tasks/query',
      method: 'POST', headers: { authorization: 'Bearer feishu-token' },
      query: { employee_type: 'employee_id', ignore_invalid_users: false },
      body: {
        user_ids: ['external-user-001'], check_date_from: 20260720, check_date_to: 20260722,
      },
    });
    expect(provider.normalize(events[0]?.payload, pullInput.timeZone)).toMatchObject({
      externalEmployeeId: 'external-user-001', externalEventId: 'flow-out-001',
      factType: 'punch_out', timeZone: 'Asia/Shanghai',
    });
  });

  it('飞书发现无权限员工时整批失败，注册表缺少任一角色时失败关闭', async () => {
    const request = vi.fn<Request>().mockResolvedValue({
      status: 200, requestId: 'feishu-request-001',
      body: { code: 0, data: { user_task_results: [], unauthorized_user_ids: ['employee-002'] } },
    });
    const provider = new FeishuAttendanceProvider(tokenFixture(), { request });
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_FEISHU_EMPLOYEE_SCOPE_MISMATCH',
    );
    expect(() => new AttendanceProviderRegistry([provider], [provider], [provider]))
      .toThrow('ATTENDANCE_PROVIDER_REGISTRY_INCOMPLETE');
  });

  it('缺少平台请求 ID 时不允许形成证据 Inbox', async () => {
    const request = vi.fn<Request>().mockResolvedValue({
      status: 200, requestId: undefined, body: { errcode: 0, recordresult: [] },
    });
    const provider = new DingTalkAttendanceProvider(tokenFixture(), { request });
    await expect(provider.pullBatch(pullInput)).rejects.toThrow(
      'ATTENDANCE_PROVIDER_REQUEST_ID_MISSING',
    );
  });
});
