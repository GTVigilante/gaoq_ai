import { describe, expect, it, vi } from 'vitest';

import { DingTalkOrgPushAdapter } from './dingtalk-org-push.adapter.js';
import { FeishuOrgPushAdapter } from './feishu-org-push.adapter.js';
import type { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgPushError } from './org-push.adapter.js';

const departmentCommand = {
  tenantId: 'tenant-a',
  departmentId: '01K00000000000000000000001',
  version: 1,
  code: 'FIN',
  name: '财务部',
  status: 'active' as const,
  parentExternalId: null,
  managerExternalId: null,
  sortOrder: 10,
  currentExternalId: null,
  idempotencyKey: 'tenant-a:department:1',
};

const provisionCommand = {
  tenantId: 'tenant-a',
  employeeId: 'employee-a',
  externalUserId: 'gq_external_user_a',
  employeeNo: 'E001',
  displayName: '张三',
  departmentExternalIds: ['123'],
  idempotencyKey: 'provision-key-001',
  contact: {
    email: 'person@example.com',
    mobile: { countryCode: '+86', subscriberNumber: '13800138000' },
  },
};

function tokens() {
  return {
    getAccess: vi.fn().mockImplementation((_tenantId: string, channel: string) => Promise.resolve({
      accessToken: `${channel}-access-token`,
      externalTenantId: 'external-tenant',
    })),
  } as unknown as OrgPlatformTokenService;
}

describe('DingTalkOrgPushAdapter', () => {
  it('创建部门时使用 topapi/v2、根部门 1，并只通过敏感查询传令牌', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      requestId: undefined,
      body: { errcode: 0, result: { dept_id: 123 }, request_id: 'dt-request' },
    });
    const adapter = new DingTalkOrgPushAdapter(tokens(), { request });

    await expect(adapter.pushDepartment(departmentCommand)).resolves.toEqual({
      externalId: '123',
      requestId: 'dt-request',
    });
    expect(request).toHaveBeenCalledWith({
      origin: 'https://oapi.dingtalk.com',
      path: '/topapi/v2/department/create',
      method: 'POST',
      sensitiveQuery: { access_token: 'dingtalk-access-token' },
      body: {
        name: '财务部', parent_id: 1, order: 10, create_dept_group: false,
        source_identifier: '01K00000000000000000000001',
      },
    });
  });

  it('未绑定员工禁止使用领域事件猜测手机号创建账号', async () => {
    const adapter = new DingTalkOrgPushAdapter(tokens(), {
      request: vi.fn(),
    });
    await expect(adapter.pushEmployee({
      tenantId: 'tenant-a',
      employeeId: 'employee-a',
      version: 1,
      employeeNo: 'E001',
      displayName: '张三',
      status: 'active',
      departmentExternalIds: ['123'],
      primaryDepartmentExternalId: '123',
      currentExternalId: null,
      idempotencyKey: 'employee-a:1',
    })).rejects.toMatchObject({
      code: 'ORG_EMPLOYEE_PREPROVISION_REQUIRED',
      category: 'business',
    });
  });

  it('私密通道创建后固定回读 userid、unionid 和工号', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { errcode: 0, request_id: 'dt-create-request', result: { userid: 'ignored' } },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          errcode: 0,
          result: { userid: 'gq_external_user_a', unionid: 'dt-union-a', job_number: 'E001' },
        },
      });
    const adapter = new DingTalkOrgPushAdapter(tokens(), { request });

    await expect(adapter.provisionEmployee(provisionCommand)).resolves.toEqual({
      externalUserId: 'gq_external_user_a',
      unionId: 'dt-union-a',
      requestId: 'dt-create-request',
    });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      path: '/topapi/v2/user/create',
      body: {
        userid: 'gq_external_user_a',
        mobile: '13800138000',
        state_code: '86',
        hide_mobile: true,
        email: 'person@example.com',
        dept_id_list: '123',
      },
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      path: '/topapi/v2/user/get',
      body: { userid: 'gq_external_user_a' },
    });
  });

  it('创建冲突后的恢复查询暂时失败时保留可重试分类', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200, requestId: undefined, body: { errcode: 40035, errmsg: 'duplicate' },
      })
      .mockRejectedValueOnce(
        new OrgPushError('DINGTALK_HTTP_RETRYABLE', 'retryable', '查询暂时失败'),
      );
    const adapter = new DingTalkOrgPushAdapter(tokens(), { request });

    await expect(adapter.provisionEmployee(provisionCommand)).rejects.toMatchObject({
      code: 'DINGTALK_HTTP_RETRYABLE',
      category: 'retryable',
    });
  });

  it('全量快照递归部门并主动丢弃手机号邮箱等私密字段', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: { errcode: 0, result: [{ dept_id: 2, parent_id: 1, name: '财务部' }] },
      })
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { errcode: 0, result: [] } })
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: { errcode: 0, result: { list: [], has_more: false } },
      })
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: {
          errcode: 0,
          result: {
            list: [{
              userid: 'user-a', name: '张三', job_number: 'E001', dept_id_list: [2],
              mobile: 'should-not-survive', email: 'should-not-survive@example.com',
            }],
            has_more: false,
          },
        },
      });
    const adapter = new DingTalkOrgPushAdapter(tokens(), { request });

    const snapshot = await adapter.fetchSnapshot('tenant-a');

    expect(snapshot.departments.get('2')).toEqual({
      externalId: '2', parentExternalId: '1', name: '财务部',
    });
    expect(snapshot.employees.get('user-a')).toEqual({
      externalId: 'user-a', displayName: '张三', employeeNo: 'E001',
      departmentExternalIds: ['2'], active: true, suspended: false,
    });
    expect(JSON.stringify([...snapshot.employees.values()])).not.toContain('should-not-survive');
  });

  it('创建响应丢失后以 source_identifier 恢复钉钉部门映射', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: { errcode: 40035, errmsg: 'duplicate' },
      })
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: {
          errcode: 0,
          result: [{
            dept_id: 123, parent_id: 1, name: '财务部',
            source_identifier: '01K00000000000000000000001',
          }],
        },
      });
    const adapter = new DingTalkOrgPushAdapter(tokens(), { request });

    await expect(adapter.pushDepartment(departmentCommand)).resolves.toEqual({ externalId: '123' });
  });

  it('HTTP 401 时只失效被拒令牌并刷新一次', async () => {
    const getAccess = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'token-v1', externalTenantId: 'corp-id' })
      .mockResolvedValueOnce({ accessToken: 'token-v2', externalTenantId: 'corp-id' });
    const invalidate = vi.fn();
    const request = vi.fn()
      .mockRejectedValueOnce(new OrgPushError('ORG_PLATFORM_HTTP_401', 'business', '调用失败', 401))
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: { errcode: 0, result: { dept_id: 123 } },
      });
    const adapter = new DingTalkOrgPushAdapter(
      { getAccess, invalidate } as unknown as OrgPlatformTokenService,
      { request },
    );

    await expect(adapter.pushDepartment(departmentCommand)).resolves.toMatchObject({
      externalId: '123',
    });
    expect(invalidate).toHaveBeenCalledWith('tenant-a', 'dingtalk', 'token-v1');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('FeishuOrgPushAdapter', () => {
  it('创建部门时使用 Contact v3 自定义 ID 与哈希幂等令牌', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      requestId: 'fs-request',
      body: {
        code: 0,
        data: { department: { department_id: '01K00000000000000000000001' } },
      },
    });
    const adapter = new FeishuOrgPushAdapter(tokens(), { request });

    await expect(adapter.pushDepartment(departmentCommand)).resolves.toEqual({
      externalId: '01K00000000000000000000001',
      requestId: 'fs-request',
    });
    const call = request.mock.calls[0]?.[0] as {
      headers: Record<string, string>;
      query: Record<string, string>;
      body: Record<string, unknown>;
    };
    expect(call.headers).toEqual({ Authorization: 'Bearer feishu-access-token' });
    expect(call.query).toMatchObject({
      department_id_type: 'department_id',
      user_id_type: 'user_id',
    });
    expect(call.query.client_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call.body).toMatchObject({
      department_id: '01K00000000000000000000001',
      parent_department_id: '0',
      create_group_chat: false,
    });
  });

  it('私密通道创建员工时使用自定义 user_id 与平台幂等令牌', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        requestId: 'fs-create-request',
        body: { code: 0, data: {} },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: 'fs-get-request',
        body: {
          code: 0,
          data: {
            user: {
              user_id: 'gq_external_user_a',
              union_id: 'fs-union-a',
              employee_no: 'E001',
            },
          },
        },
      });
    const adapter = new FeishuOrgPushAdapter(tokens(), { request });

    await expect(adapter.provisionEmployee(provisionCommand)).resolves.toEqual({
      externalUserId: 'gq_external_user_a',
      unionId: 'fs-union-a',
      requestId: 'fs-create-request',
    });
    const call = request.mock.calls[0]?.[0] as {
      readonly path: string;
      readonly query: Record<string, string>;
      readonly body: Record<string, unknown>;
    };
    expect(call.path).toBe('/open-apis/contact/v3/users');
    expect(call.query).toMatchObject({
      user_id_type: 'user_id',
      department_id_type: 'department_id',
    });
    expect(call.query.client_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call.body).toMatchObject({
      user_id: 'gq_external_user_a',
      email: 'person@example.com',
      mobile: '+8613800138000',
      employee_no: 'E001',
      department_ids: ['123'],
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      method: 'GET',
      path: '/open-apis/contact/v3/users/gq_external_user_a',
      query: { user_id_type: 'user_id', department_id_type: 'department_id' },
    });
  });

  it('创建冲突后的恢复查询暂时失败时保留飞书可重试分类', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200, requestId: undefined, body: { code: 40001 },
      })
      .mockRejectedValueOnce(
        new OrgPushError('FEISHU_HTTP_RETRYABLE', 'retryable', '查询暂时失败'),
      );
    const adapter = new FeishuOrgPushAdapter(tokens(), { request });

    await expect(adapter.provisionEmployee(provisionCommand)).rejects.toMatchObject({
      code: 'FEISHU_HTTP_RETRYABLE',
      category: 'retryable',
    });
  });

  it('员工冻结通过 PATCH is_frozen，离职通过 DELETE', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, requestId: 'freeze', body: { code: 0 } })
      .mockResolvedValueOnce({ status: 200, requestId: 'delete', body: { code: 0 } });
    const adapter = new FeishuOrgPushAdapter(tokens(), { request });

    await adapter.changeEmployeeStatus({
      tenantId: 'tenant-a', employeeId: 'employee-a', externalId: 'user-a',
      version: 2, status: 'suspended', idempotencyKey: 'employee-a:2',
    });
    await adapter.changeEmployeeStatus({
      tenantId: 'tenant-a', employeeId: 'employee-a', externalId: 'user-a',
      version: 3, status: 'terminated', idempotencyKey: 'employee-a:3',
    });

    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'PATCH', body: { is_frozen: true },
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({ method: 'DELETE' });
  });

  it('飞书快照只投影对账所需组织字段', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: {
          code: 0,
          data: {
            has_more: false,
            items: [{ department_id: 'dept-a', parent_department_id: '0', name: '财务部' }],
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: {
          code: 0,
          data: {
            has_more: false,
            items: [],
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: {
          code: 0,
          data: {
            has_more: false,
            items: [{
              user_id: 'user-a', name: '张三', employee_no: 'E001',
              department_ids: ['dept-a'], status: { is_frozen: false },
              mobile: 'should-not-survive', email: 'should-not-survive@example.com',
            }],
          },
        },
      });
    const adapter = new FeishuOrgPushAdapter(tokens(), { request });

    const snapshot = await adapter.fetchSnapshot('tenant-a');

    expect(snapshot.employees.get('user-a')).toEqual({
      externalId: 'user-a', displayName: '张三', employeeNo: 'E001',
      departmentExternalIds: ['dept-a'], frozen: false, suspended: false, resigned: false,
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      path: '/open-apis/contact/v3/users/find_by_department',
      query: { department_id: '0' },
    });
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      path: '/open-apis/contact/v3/users/find_by_department',
      query: { department_id: 'dept-a' },
    });
    expect(JSON.stringify([...snapshot.employees.values()])).not.toContain('should-not-survive');
  });

  it('创建冲突后按自定义 department_id 恢复飞书部门映射', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { code: 40001 } })
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: {
          code: 0,
          data: { department: { department_id: '01K00000000000000000000001' } },
        },
      });
    const adapter = new FeishuOrgPushAdapter(tokens(), { request });

    await expect(adapter.pushDepartment(departmentCommand)).resolves.toEqual({
      externalId: '01K00000000000000000000001',
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({ method: 'GET' });
  });

  it('HTTP 401 时只失效飞书旧令牌并刷新一次', async () => {
    const getAccess = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'token-v1', externalTenantId: 'tenant-key' })
      .mockResolvedValueOnce({ accessToken: 'token-v2', externalTenantId: 'tenant-key' });
    const invalidate = vi.fn();
    const request = vi.fn()
      .mockRejectedValueOnce(new OrgPushError('ORG_PLATFORM_HTTP_401', 'business', '调用失败', 401))
      .mockResolvedValueOnce({
        status: 200, requestId: 'fs-request',
        body: {
          code: 0,
          data: { department: { department_id: '01K00000000000000000000001' } },
        },
      });
    const adapter = new FeishuOrgPushAdapter(
      { getAccess, invalidate } as unknown as OrgPlatformTokenService,
      { request },
    );

    await expect(adapter.pushDepartment(departmentCommand)).resolves.toMatchObject({
      externalId: '01K00000000000000000000001',
    });
    expect(invalidate).toHaveBeenCalledWith('tenant-a', 'feishu', 'token-v1');
    expect(request).toHaveBeenCalledTimes(2);
  });
});
