import { describe, expect, it, vi } from 'vitest';

import { DingTalkOrgPushAdapter } from './dingtalk-org-push.adapter.js';
import { FeishuOrgPushAdapter } from './feishu-org-push.adapter.js';
import { OpOrgPushAdapter } from './op-org-push.adapter.js';
import type { OrgPlatformCredentialService } from './org-platform-credential.service.js';
import type { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgPushError } from './org-push.adapter.js';

const departmentCommand = {
  tenantId: 'tenant-a',
  departmentId: 'department-a',
  version: 2,
  code: 'FIN',
  name: '财务部',
  status: 'active' as const,
  parentExternalId: null,
  managerExternalId: null,
  sortOrder: 10,
  currentExternalId: null,
  idempotencyKey: 'tenant-a:department-a:2',
};

const employeeCommand = {
  tenantId: 'tenant-a',
  employeeId: 'employee-a',
  version: 2,
  employeeNo: 'E001',
  displayName: '张三',
  status: 'active' as const,
  departmentExternalIds: ['123'],
  primaryDepartmentExternalId: '123',
  currentExternalId: 'user-a',
  idempotencyKey: 'tenant-a:employee-a:2',
};

const provisionCommand = {
  tenantId: 'tenant-a',
  employeeId: 'employee-a',
  externalUserId: 'gq_external_user_a',
  employeeNo: 'E001',
  displayName: '张三',
  departmentExternalIds: ['123'],
  idempotencyKey: 'tenant-a:employee-a:provision',
  contact: {
    email: 'person@example.com',
    mobile: { countryCode: '+86', subscriberNumber: '13800138000' },
  },
};

const statusCommand = {
  tenantId: 'tenant-a',
  employeeId: 'employee-a',
  externalId: 'user-a',
  version: 3,
  status: 'active' as const,
  idempotencyKey: 'tenant-a:employee-a:3',
};

function tokenService() {
  return {
    getAccess: vi.fn().mockImplementation((_tenantId: string, channel: string) => Promise.resolve({
      accessToken: `${channel}-token`,
      externalTenantId: 'external-tenant',
    })),
    invalidate: vi.fn(),
  } as unknown as OrgPlatformTokenService;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('测试夹具不是对象');
  }
  return value as Record<string, unknown>;
}

describe('DingTalkOrgPushAdapter 可靠性边界', () => {
  it('更新部门时验证数值映射并省略不存在的 requestId', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      requestId: undefined,
      body: { errcode: 0 },
    });
    const adapter = new DingTalkOrgPushAdapter(tokenService(), { request });

    await expect(adapter.pushDepartment({
      ...departmentCommand,
      departmentId: 'department-a',
      parentExternalId: '2',
      currentExternalId: '123',
    })).resolves.toEqual({ externalId: '123' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/topapi/v2/department/update',
      body: {
        dept_id: 123,
        name: '财务部',
        parent_id: 2,
        order: 10,
      },
    }));
  });

  it('部门停用和非法钉钉映射均失败关闭', async () => {
    const adapter = new DingTalkOrgPushAdapter(tokenService(), { request: vi.fn() });

    await expect(adapter.pushDepartment({
      ...departmentCommand,
      status: 'inactive',
    })).rejects.toMatchObject({
      code: 'DINGTALK_DEPARTMENT_DEACTIVATION_REQUIRES_REVIEW',
      category: 'business',
    });
    await expect(adapter.pushDepartment({
      ...departmentCommand,
      parentExternalId: 'not-numeric',
    })).rejects.toMatchObject({ code: 'DINGTALK_DEPARTMENT_ID_INVALID' });
    await expect(adapter.pushDepartment({
      ...departmentCommand,
      parentExternalId: '0',
    })).rejects.toMatchObject({ code: 'DINGTALK_DEPARTMENT_ID_INVALID' });
  });

  it.each([
    ['invalid', 'DINGTALK_RESPONSE_INVALID', 'retryable'],
    [{ errcode: -1 }, 'DINGTALK_1', 'retryable'],
    [{ errcode: 88 }, 'DINGTALK_88', 'retryable'],
    [{ errcode: 40035 }, 'DINGTALK_40035', 'business'],
  ] as const)('拒绝异常或业务失败响应 %#', async (body, code, category) => {
    const adapter = new DingTalkOrgPushAdapter(tokenService(), {
      request: vi.fn().mockResolvedValue({ status: 200, requestId: undefined, body }),
    });

    await expect(adapter.pushDepartment({
      ...departmentCommand,
      currentExternalId: '123',
    })).rejects.toMatchObject({ code, category });
  });

  it.each([
    [null],
    [[]],
    [{ dept_id: 'not-numeric' }],
  ])('创建部门必须取得合法平台标识 %#', async (result) => {
    const adapter = new DingTalkOrgPushAdapter(tokenService(), {
      request: vi.fn().mockResolvedValue({
        status: 200,
        requestId: undefined,
        body: { errcode: 0, result },
      }),
    });

    await expect(adapter.pushDepartment(departmentCommand)).rejects.toMatchObject({
      code: 'DINGTALK_DEPARTMENT_ID_MISSING',
      category: 'retryable',
    });
  });

  it('创建部门的非重试冲突若无法找到来源标识则保留原错误', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { errcode: 40035 } })
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { errcode: 0, result: [] } });
    const adapter = new DingTalkOrgPushAdapter(tokenService(), { request });

    await expect(adapter.pushDepartment(departmentCommand)).rejects.toMatchObject({
      code: 'DINGTALK_40035',
      category: 'business',
    });
  });

  it('创建部门恢复查询的受损快照失败关闭', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { errcode: 40035 } })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { errcode: 0, result: 'invalid' },
      });
    const adapter = new DingTalkOrgPushAdapter(tokenService(), { request });

    await expect(adapter.pushDepartment(departmentCommand)).rejects.toMatchObject({
      code: 'DINGTALK_SNAPSHOT_INVALID',
      category: 'retryable',
    });
  });

  it('员工更新、删除、暂停和状态变更使用不同安全路径', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      requestId: undefined,
      body: { errcode: 0 },
    });
    const adapter = new DingTalkOrgPushAdapter(tokenService(), { request });

    await expect(adapter.pushEmployee(employeeCommand)).resolves.toEqual({ externalId: 'user-a' });
    await expect(adapter.pushEmployee({
      ...employeeCommand,
      status: 'terminated',
    })).resolves.toEqual({ externalId: 'user-a' });
    await expect(adapter.pushEmployee({
      ...employeeCommand,
      status: 'suspended',
    })).rejects.toMatchObject({ code: 'DINGTALK_SUSPEND_REQUIRES_REVIEW' });
    await expect(adapter.changeEmployeeStatus(statusCommand)).resolves.toEqual({
      externalId: 'user-a',
    });
    await expect(adapter.changeEmployeeStatus({
      ...statusCommand,
      status: 'terminated',
    })).resolves.toEqual({ externalId: 'user-a' });
    await expect(adapter.changeEmployeeStatus({
      ...statusCommand,
      status: 'suspended',
    })).rejects.toMatchObject({ code: 'DINGTALK_SUSPEND_REQUIRES_REVIEW' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/topapi/v2/user/update',
    }));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/topapi/v2/user/delete',
    }));
  });

  it('钉钉开户要求手机号，并支持无邮箱和无 requestId 的最小返回', async () => {
    const adapterWithoutMobile = new DingTalkOrgPushAdapter(tokenService(), { request: vi.fn() });
    await expect(adapterWithoutMobile.provisionEmployee({
      ...provisionCommand,
      contact: {},
    })).rejects.toMatchObject({ code: 'DINGTALK_PROVISIONING_MOBILE_REQUIRED' });

    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { errcode: 0 },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          errcode: 0,
          result: {
            userid: provisionCommand.externalUserId,
            unionid: 'union-a',
            job_number: provisionCommand.employeeNo,
          },
        },
      });
    const adapter = new DingTalkOrgPushAdapter(tokenService(), { request });

    await expect(adapter.provisionEmployee({
      ...provisionCommand,
      contact: { mobile: provisionCommand.contact.mobile },
    })).resolves.toEqual({
      externalUserId: provisionCommand.externalUserId,
      unionId: 'union-a',
    });
    const createCall: unknown = request.mock.calls[0]?.[0];
    expect(asRecord(asRecord(createCall).body)).not.toHaveProperty('email');
  });

  it('开户创建的未知异常和可重试异常不得转化为恢复成功', async () => {
    const unknown = new Error('unexpected');
    const unknownAdapter = new DingTalkOrgPushAdapter(tokenService(), {
      request: vi.fn().mockRejectedValue(unknown),
    });
    await expect(unknownAdapter.provisionEmployee(provisionCommand)).rejects.toBe(unknown);

    const retryable = new OrgPushError('DINGTALK_TEMPORARY', 'retryable', '暂时失败');
    const retryableAdapter = new DingTalkOrgPushAdapter(tokenService(), {
      request: vi.fn().mockRejectedValue(retryable),
    });
    await expect(retryableAdapter.provisionEmployee(provisionCommand)).rejects.toBe(retryable);
  });

  it('开户冲突仅在身份与工号完全一致时恢复', async () => {
    const conflictResponse = {
      status: 200,
      requestId: undefined,
      body: { errcode: 40035 },
    };
    const identityInvalid = vi.fn()
      .mockResolvedValueOnce(conflictResponse)
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          errcode: 0,
          result: { userid: 'other-user', unionid: 'union-a', job_number: 'E001' },
        },
      });
    await expect(new DingTalkOrgPushAdapter(
      tokenService(),
      { request: identityInvalid },
    ).provisionEmployee(provisionCommand)).rejects.toMatchObject({ code: 'DINGTALK_40035' });

    const identityConflict = vi.fn()
      .mockResolvedValueOnce(conflictResponse)
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          errcode: 0,
          result: {
            userid: provisionCommand.externalUserId,
            unionid: 'union-a',
            job_number: 'OTHER',
          },
        },
      });
    await expect(new DingTalkOrgPushAdapter(
      tokenService(),
      { request: identityConflict },
    ).provisionEmployee(provisionCommand)).rejects.toMatchObject({
      code: 'DINGTALK_PROVISIONING_IDENTITY_CONFLICT',
    });
  });

  it('快照拒绝受损部门、员工和不前进的游标', async () => {
    const departmentInvalid = new DingTalkOrgPushAdapter(tokenService(), {
      request: vi.fn().mockResolvedValue({
        status: 200,
        requestId: undefined,
        body: { errcode: 0, result: 'invalid' },
      }),
    });
    await expect(departmentInvalid.fetchSnapshot('tenant-a')).rejects.toMatchObject({
      code: 'DINGTALK_SNAPSHOT_INVALID',
    });

    const employeeInvalidRequest = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { errcode: 0, result: [] },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { errcode: 0, result: 'invalid' },
      });
    await expect(new DingTalkOrgPushAdapter(
      tokenService(),
      { request: employeeInvalidRequest },
    ).fetchSnapshot('tenant-a')).rejects.toMatchObject({ code: 'DINGTALK_SNAPSHOT_INVALID' });

    for (const nextCursor of [undefined, 0]) {
      const cursorRequest = vi.fn()
        .mockResolvedValueOnce({
          status: 200,
          requestId: undefined,
          body: { errcode: 0, result: [] },
        })
        .mockResolvedValueOnce({
          status: 200,
          requestId: undefined,
          body: {
            errcode: 0,
            result: { list: [], has_more: true, next_cursor: nextCursor },
          },
        });
      await expect(new DingTalkOrgPushAdapter(
        tokenService(),
        { request: cursorRequest },
      ).fetchSnapshot('tenant-a')).rejects.toMatchObject({
        code: 'DINGTALK_SNAPSHOT_CURSOR_INVALID',
      });
    }
  });

  it('快照处理前进游标以及员工缺省字段和停用状态', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { errcode: 0, result: [] },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          errcode: 0,
          result: {
            list: [{ userid: 'user-a', active: false }],
            has_more: true,
            next_cursor: 10,
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { errcode: 0, result: { list: [], has_more: false } },
      });
    const snapshot = await new DingTalkOrgPushAdapter(
      tokenService(),
      { request },
    ).fetchSnapshot('tenant-a');

    expect(snapshot.employees.get('user-a')).toEqual({
      externalId: 'user-a',
      displayName: '',
      employeeNo: '',
      departmentExternalIds: [],
      active: false,
      suspended: true,
    });
    expect(request.mock.calls[2]?.[0]).toMatchObject({ body: { cursor: 10 } });
  });

  it('快照超过分页安全上限时停止调用', async () => {
    let cursor = 0;
    const request = vi.fn().mockImplementation(() => {
      if (request.mock.calls.length === 1) {
        return Promise.resolve({
          status: 200,
          requestId: undefined,
          body: { errcode: 0, result: [] },
        });
      }
      cursor += 1;
      return Promise.resolve({
        status: 200,
        requestId: undefined,
        body: {
          errcode: 0,
          result: { list: [], has_more: true, next_cursor: cursor },
        },
      });
    });
    const adapter = new DingTalkOrgPushAdapter(tokenService(), { request });

    await expect(adapter.fetchSnapshot('tenant-a')).rejects.toMatchObject({
      code: 'DINGTALK_SNAPSHOT_PAGE_LIMIT',
    });
    expect(request).toHaveBeenCalledTimes(201);
  });
});

describe('FeishuOrgPushAdapter 可靠性边界', () => {
  it('更新部门时只发送更新字段、负责人和现有标识', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      requestId: undefined,
      body: { code: 0 },
    });
    const adapter = new FeishuOrgPushAdapter(tokenService(), { request });

    await expect(adapter.pushDepartment({
      ...departmentCommand,
      parentExternalId: 'parent-a',
      managerExternalId: 'manager-a',
      currentExternalId: 'department/existing',
    })).resolves.toEqual({ externalId: 'department/existing' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/open-apis/contact/v3/departments/department%2Fexisting',
      method: 'PATCH',
      query: {
        department_id_type: 'department_id',
        user_id_type: 'user_id',
      },
      body: {
        name: '财务部',
        parent_department_id: 'parent-a',
        leader_user_id: 'manager-a',
        order: '10',
      },
    }));
  });

  it('部门停用、创建响应缺少标识和无效响应均失败关闭', async () => {
    const inactive = new FeishuOrgPushAdapter(tokenService(), { request: vi.fn() });
    await expect(inactive.pushDepartment({
      ...departmentCommand,
      status: 'inactive',
    })).rejects.toMatchObject({
      code: 'FEISHU_DEPARTMENT_DEACTIVATION_REQUIRES_REVIEW',
    });

    const missing = new FeishuOrgPushAdapter(tokenService(), {
      request: vi.fn().mockResolvedValue({
        status: 200,
        requestId: undefined,
        body: { code: 0, data: {} },
      }),
    });
    await expect(missing.pushDepartment(departmentCommand)).rejects.toMatchObject({
      code: 'FEISHU_DEPARTMENT_ID_MISSING',
    });

    const invalid = new FeishuOrgPushAdapter(tokenService(), {
      request: vi.fn().mockResolvedValue({
        status: 200,
        requestId: undefined,
        body: { invalid: true },
      }),
    });
    await expect(invalid.pushDepartment({
      ...departmentCommand,
      currentExternalId: 'department-a',
    })).rejects.toMatchObject({ code: 'FEISHU_RESPONSE_INVALID' });
  });

  it.each([
    [99991400, 'retryable'],
    [99991401, 'retryable'],
    [40001, 'business'],
  ] as const)('飞书业务码 %s 使用稳定分类', async (code, category) => {
    const adapter = new FeishuOrgPushAdapter(tokenService(), {
      request: vi.fn().mockResolvedValue({
        status: 200,
        requestId: undefined,
        body: { code },
      }),
    });

    await expect(adapter.pushDepartment({
      ...departmentCommand,
      currentExternalId: 'department-a',
    })).rejects.toMatchObject({ code: `FEISHU_${code}`, category });
  });

  it('部门创建冲突恢复失败时保留原业务错误', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { code: 40001 } })
      .mockResolvedValueOnce({ status: 200, requestId: undefined, body: { code: 0, data: {} } });
    const adapter = new FeishuOrgPushAdapter(tokenService(), { request });

    await expect(adapter.pushDepartment(departmentCommand)).rejects.toMatchObject({
      code: 'FEISHU_40001',
      category: 'business',
    });
  });

  it('员工更新、删除、冻结和解冻均绑定既有 user_id', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      requestId: undefined,
      body: { code: 0 },
    });
    const adapter = new FeishuOrgPushAdapter(tokenService(), { request });

    await expect(adapter.pushEmployee(employeeCommand)).resolves.toEqual({ externalId: 'user-a' });
    await expect(adapter.pushEmployee({
      ...employeeCommand,
      status: 'terminated',
    })).resolves.toEqual({ externalId: 'user-a' });
    await expect(adapter.pushEmployee({
      ...employeeCommand,
      currentExternalId: null,
    })).rejects.toMatchObject({ code: 'ORG_EMPLOYEE_PREPROVISION_REQUIRED' });
    await expect(adapter.changeEmployeeStatus(statusCommand)).resolves.toEqual({
      externalId: 'user-a',
    });
    await expect(adapter.changeEmployeeStatus({
      ...statusCommand,
      status: 'terminated',
    })).resolves.toEqual({ externalId: 'user-a' });
    const patchCall: unknown = request.mock.calls[0]?.[0];
    expect(asRecord(patchCall).method).toBe('PATCH');
    expect(asRecord(asRecord(patchCall).body).is_frozen).toBe(false);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }));
  });

  it('飞书开户支持无联系方式和无 requestId 的最小身份返回', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { code: 0 },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          code: 0,
          data: {
            user: {
              user_id: provisionCommand.externalUserId,
              union_id: 'union-a',
              employee_no: provisionCommand.employeeNo,
            },
          },
        },
      });
    const adapter = new FeishuOrgPushAdapter(tokenService(), { request });

    await expect(adapter.provisionEmployee({
      ...provisionCommand,
      contact: {},
    })).resolves.toEqual({
      externalUserId: provisionCommand.externalUserId,
      unionId: 'union-a',
    });
    const firstCall: unknown = request.mock.calls[0]?.[0];
    const body = asRecord(asRecord(firstCall).body);
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('mobile');
  });

  it('开户创建的未知异常和可重试异常原样传播', async () => {
    const unknown = new Error('unexpected');
    await expect(new FeishuOrgPushAdapter(tokenService(), {
      request: vi.fn().mockRejectedValue(unknown),
    }).provisionEmployee(provisionCommand)).rejects.toBe(unknown);

    const retryable = new OrgPushError('FEISHU_TEMPORARY', 'retryable', '暂时失败');
    await expect(new FeishuOrgPushAdapter(tokenService(), {
      request: vi.fn().mockRejectedValue(retryable),
    }).provisionEmployee(provisionCommand)).rejects.toBe(retryable);
  });

  it('开户冲突仅恢复完全一致的确定性身份', async () => {
    const businessFailure = {
      status: 200,
      requestId: undefined,
      body: { code: 40001 },
    };
    const invalidIdentity = vi.fn()
      .mockResolvedValueOnce(businessFailure)
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          code: 0,
          data: {
            user: { user_id: 'other', union_id: 'union-a', employee_no: 'E001' },
          },
        },
      });
    await expect(new FeishuOrgPushAdapter(
      tokenService(),
      { request: invalidIdentity },
    ).provisionEmployee(provisionCommand)).rejects.toMatchObject({ code: 'FEISHU_40001' });

    const conflictingIdentity = vi.fn()
      .mockResolvedValueOnce(businessFailure)
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          code: 0,
          data: {
            user: {
              user_id: provisionCommand.externalUserId,
              union_id: 'union-a',
              employee_no: 'OTHER',
            },
          },
        },
      });
    await expect(new FeishuOrgPushAdapter(
      tokenService(),
      { request: conflictingIdentity },
    ).provisionEmployee(provisionCommand)).rejects.toMatchObject({
      code: 'FEISHU_PROVISIONING_IDENTITY_CONFLICT',
    });
  });

  it('快照拒绝受损部门、员工和不前进的分页令牌', async () => {
    const departmentInvalid = new FeishuOrgPushAdapter(tokenService(), {
      request: vi.fn().mockResolvedValue({
        status: 200,
        requestId: undefined,
        body: { code: 0, data: { has_more: 'invalid' } },
      }),
    });
    await expect(departmentInvalid.fetchSnapshot('tenant-a')).rejects.toMatchObject({
      code: 'FEISHU_SNAPSHOT_INVALID',
    });

    for (const pageToken of [undefined, 'same']) {
      const request = vi.fn().mockResolvedValue({
        status: 200,
        requestId: undefined,
        body: {
          code: 0,
          data: {
            has_more: true,
            page_token: pageToken,
            items: [],
          },
        },
      });
      if (pageToken === 'same') {
        request
          .mockResolvedValueOnce({
            status: 200,
            requestId: undefined,
            body: {
              code: 0,
              data: { has_more: true, page_token: 'same', items: [] },
            },
          })
          .mockResolvedValueOnce({
            status: 200,
            requestId: undefined,
            body: {
              code: 0,
              data: { has_more: true, page_token: 'same', items: [] },
            },
          });
      }
      await expect(new FeishuOrgPushAdapter(
        tokenService(),
        { request },
      ).fetchSnapshot('tenant-a')).rejects.toMatchObject({
        code: 'FEISHU_SNAPSHOT_CURSOR_INVALID',
      });
    }

    const employeeInvalidRequest = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { code: 0, data: { has_more: false, items: [] } },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { code: 0, data: { has_more: 'invalid' } },
      });
    await expect(new FeishuOrgPushAdapter(
      tokenService(),
      { request: employeeInvalidRequest },
    ).fetchSnapshot('tenant-a')).rejects.toMatchObject({ code: 'FEISHU_SNAPSHOT_INVALID' });
  });

  it('快照投影负责人、缺省员工字段并处理前进令牌', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          code: 0,
          data: {
            has_more: true,
            page_token: 'departments-next',
            items: [{
              department_id: 'department-a',
              parent_department_id: '0',
              name: '财务部',
              leader_user_id: 'manager-a',
            }],
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { code: 0, data: { has_more: false, items: [] } },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: {
          code: 0,
          data: {
            has_more: true,
            page_token: 'employees-next',
            items: [{ user_id: 'user-a', name: '张三' }],
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { code: 0, data: { has_more: false, items: [] } },
      })
      .mockResolvedValueOnce({
        status: 200,
        requestId: undefined,
        body: { code: 0, data: { has_more: false, items: [] } },
      });
    const snapshot = await new FeishuOrgPushAdapter(
      tokenService(),
      { request },
    ).fetchSnapshot('tenant-a');

    expect(snapshot.departments.get('department-a')).toEqual({
      externalId: 'department-a',
      parentExternalId: '0',
      name: '财务部',
      managerExternalId: 'manager-a',
    });
    expect(snapshot.employees.get('user-a')).toEqual({
      externalId: 'user-a',
      displayName: '张三',
      employeeNo: '',
      departmentExternalIds: [],
      frozen: false,
      suspended: false,
      resigned: false,
    });
    const secondCall: unknown = request.mock.calls[1]?.[0];
    const fourthCall: unknown = request.mock.calls[3]?.[0];
    expect(asRecord(asRecord(secondCall).query).page_token).toBe('departments-next');
    expect(asRecord(asRecord(fourthCall).query).page_token).toBe('employees-next');
  });

  it('部门与员工分页分别受全局安全上限约束', async () => {
    let departmentPage = 0;
    const departmentRequest = vi.fn().mockImplementation(() => {
      departmentPage += 1;
      return Promise.resolve({
        status: 200,
        requestId: undefined,
        body: {
          code: 0,
          data: {
            has_more: true,
            page_token: `department-page-${departmentPage}`,
            items: [],
          },
        },
      });
    });
    await expect(new FeishuOrgPushAdapter(
      tokenService(),
      { request: departmentRequest },
    ).fetchSnapshot('tenant-a')).rejects.toMatchObject({
      code: 'FEISHU_SNAPSHOT_PAGE_LIMIT',
    });
    expect(departmentRequest).toHaveBeenCalledTimes(400);

    let employeePage = 0;
    const employeeRequest = vi.fn().mockImplementation(() => {
      if (employeeRequest.mock.calls.length === 1) {
        return Promise.resolve({
          status: 200,
          requestId: undefined,
          body: { code: 0, data: { has_more: false, items: [] } },
        });
      }
      employeePage += 1;
      return Promise.resolve({
        status: 200,
        requestId: undefined,
        body: {
          code: 0,
          data: {
            has_more: true,
            page_token: `employee-page-${employeePage}`,
            items: [],
          },
        },
      });
    });
    await expect(new FeishuOrgPushAdapter(
      tokenService(),
      { request: employeeRequest },
    ).fetchSnapshot('tenant-a')).rejects.toMatchObject({
      code: 'FEISHU_SNAPSHOT_PAGE_LIMIT',
    });
    expect(employeeRequest).toHaveBeenCalledTimes(401);
  });
});

describe('OpOrgPushAdapter 可靠性边界', () => {
  function fixture(responseBody: unknown, requestId: string | null = 'request-a') {
    const credentials = {
      resolve: vi.fn().mockResolvedValue({
        clientId: 'erp-client',
        clientSecret: 'op-outbound-hmac-secret-at-least-32-characters',
        externalTenantId: 'op-tenant',
      }),
    };
    const request = vi.fn().mockResolvedValue({
      status: 200,
      requestId: requestId ?? undefined,
      body: responseBody,
    });
    return {
      adapter: new OpOrgPushAdapter(
        credentials as unknown as OrgPlatformCredentialService,
        { request },
      ),
      request,
    };
  }

  it('现有部门、员工和状态变更复用外部标识', async () => {
    const department = fixture({ code: 'OK', data: { externalId: 'external-department' } });
    await expect(department.adapter.pushDepartment({
      ...departmentCommand,
      currentExternalId: 'external-department',
    })).resolves.toMatchObject({ externalId: 'external-department' });
    expect(department.request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/erp/v1/org/departments/external-department',
    }));

    const employee = fixture({ code: 'OK', data: { externalId: 'external-employee' } });
    await expect(employee.adapter.pushEmployee({
      ...employeeCommand,
      currentExternalId: 'external-employee',
    })).resolves.toMatchObject({ externalId: 'external-employee' });
    await expect(employee.adapter.changeEmployeeStatus({
      ...statusCommand,
      externalId: 'external-employee',
      status: 'suspended',
    })).resolves.toMatchObject({ externalId: 'external-employee' });
    expect(employee.request).toHaveBeenCalledTimes(2);
  });

  it('无 requestId 时返回最小结果，并拒绝响应标识错配', async () => {
    const minimal = fixture(
      { code: 'OK', data: { externalId: 'department-a' } },
      null,
    );
    await expect(minimal.adapter.pushDepartment(departmentCommand)).resolves.toEqual({
      externalId: 'department-a',
    });

    for (const body of [
      { code: 'ERROR' },
      { code: 'OK', data: { externalId: 'other-department' } },
    ]) {
      await expect(fixture(body).adapter.pushDepartment(departmentCommand)).rejects.toMatchObject({
        code: 'OP_ORG_RESPONSE_INVALID',
        category: 'retryable',
      });
    }
  });

  it('幂等键与快照结构均严格校验', async () => {
    const invalidKey = fixture({ code: 'OK', data: { externalId: 'department-a' } });
    await expect(invalidKey.adapter.pushDepartment({
      ...departmentCommand,
      idempotencyKey: 'short',
    })).rejects.toMatchObject({ code: 'OP_IDEMPOTENCY_KEY_INVALID' });

    await expect(fixture({
      code: 'OK',
      data: {
        departments: [],
        employees: [{ externalId: 'employee-a', unexpected: true }],
      },
    }).adapter.fetchSnapshot('tenant-a')).rejects.toMatchObject({
      code: 'OP_ORG_SNAPSHOT_INVALID',
      category: 'retryable',
    });
  });
});
