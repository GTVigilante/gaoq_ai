import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalIdentityDocument } from '../identity/external-identity.schema.js';
import {
  OrgExternalIdentityResolver,
} from './org-external-identity.resolver.js';
import type { OrgPlatformBindingDocument } from './org-platform-binding.schema.js';
import type {
  OrgPlatformHttpResponse,
} from './org-platform-http.client.js';
import type {
  OrgPlatformAccess,
  OrgPlatformTokenService,
} from './org-platform-token.service.js';

function query(value: unknown) {
  return {
    lean: () => ({
      exec: () => Promise.resolve(value),
    }),
  };
}

function fixture(options: {
  readonly binding?: unknown;
  readonly identity?: unknown;
  readonly access?: unknown;
  readonly response?: unknown;
} = {}) {
  const bindingFindOne = vi.fn().mockReturnValue(query(
    options.binding === undefined
      ? { externalTenantId: 'corp-id' }
      : options.binding,
  ));
  const identityFindOne = vi.fn().mockReturnValue(query(
    options.identity === undefined
      ? { externalUserId: 'external-user-id', unionId: 'union-id' }
      : options.identity,
  ));
  const getAccess = vi.fn().mockResolvedValue(
    options.access === undefined
      ? {
          accessToken: 'access-token',
          externalTenantId: 'corp-id',
          clientId: 'app-key',
        } satisfies OrgPlatformAccess
      : options.access,
  );
  const request = vi.fn().mockResolvedValue(
    options.response === undefined
      ? {
          status: 200,
          requestId: undefined,
          body: { errcode: 0, result: { userid: 'ding-user-id' } },
        } satisfies OrgPlatformHttpResponse
      : options.response,
  );
  const resolver = new OrgExternalIdentityResolver(
    { findOne: identityFindOne } as unknown as Model<ExternalIdentityDocument>,
    { findOne: bindingFindOne } as unknown as Model<OrgPlatformBindingDocument>,
    { getAccess } as unknown as OrgPlatformTokenService,
    { request },
  );
  return {
    bindingFindOne,
    getAccess,
    identityFindOne,
    request,
    resolver,
  };
}

describe('OrgExternalIdentityResolver', () => {
  it('只按可信租户、平台、员工与 bound 状态读取严格最小投影', async () => {
    const {
      bindingFindOne,
      getAccess,
      identityFindOne,
      request,
      resolver,
    } = fixture({
      binding: { externalTenantId: 'feishu-tenant' },
      identity: { externalUserId: 'user-001', unionId: 'union-001' },
    });

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'feishu', 'employee-a'),
    ).resolves.toBe('user-001');
    expect(bindingFindOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', channel: 'feishu', status: 'active' },
      { externalTenantId: 1, _id: 0 },
    );
    expect(identityFindOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-a',
        provider: 'feishu',
        externalTenantId: 'feishu-tenant',
        employeeId: 'employee-a',
        status: 'bound',
      },
      { externalUserId: 1, unionId: 1, _id: 0 },
    );
    expect(getAccess).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('OP 使用经验证的企业内 externalUserId 且不触达令牌服务', async () => {
    const { getAccess, request, resolver } = fixture({
      identity: { externalUserId: 'op-user-001', unionId: 'op-union-001' },
    });

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'op', 'employee-a'),
    ).resolves.toBe('op-user-001');
    expect(getAccess).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['$ne', 'dingtalk', 'employee-a'],
    ['tenant-a', 'unknown', 'employee-a'],
    ['tenant-a', 'feishu', ''],
    ['tenant-a', 'op', ' employee-a'],
  ])('非法标识或渠道失败关闭且不触发 Mongo 查询', async (
    tenantId,
    channel,
    employeeId,
  ) => {
    const { bindingFindOne, identityFindOne, resolver } = fixture();

    await expect(resolver.findBoundExternalUserId(
      tenantId,
      channel as 'dingtalk',
      employeeId,
    )).resolves.toBeNull();
    expect(bindingFindOne).not.toHaveBeenCalled();
    expect(identityFindOne).not.toHaveBeenCalled();
  });

  it('无活动平台绑定时返回未就绪且不查询身份仓储', async () => {
    const { identityFindOne, resolver } = fixture({ binding: null });

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'feishu', 'employee-a'),
    ).resolves.toBeNull();
    expect(identityFindOne).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { externalTenantId: '$bad' },
    { externalTenantId: 'corp-id', credentialSecretRef: 'forbidden' },
  ])('受损平台绑定失败关闭且不查询身份仓储 %#', async (binding) => {
    const { identityFindOne, resolver } = fixture({ binding });

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'feishu', 'employee-a'),
    ).rejects.toMatchObject({
      code: 'ORG_EXTERNAL_IDENTITY_STATE_INVALID',
      category: 'business',
      message: '组织外部身份状态无效',
    });
    expect(identityFindOne).not.toHaveBeenCalled();
  });

  it('无 bound 身份时返回未就绪且不触达平台', async () => {
    const { getAccess, request, resolver } = fixture({ identity: null });

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'dingtalk', 'employee-a'),
    ).resolves.toBeNull();
    expect(getAccess).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { externalUserId: '$bad', unionId: 'union-id' },
    { externalUserId: 'user-id', unionId: '' },
    {
      externalUserId: 'user-id',
      unionId: 'union-id',
      mobile: 'forbidden',
    },
  ])('受损身份投影失败关闭且不触达平台 %#', async (identity) => {
    const { getAccess, request, resolver } = fixture({ identity });

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'dingtalk', 'employee-a'),
    ).rejects.toMatchObject({
      code: 'ORG_EXTERNAL_IDENTITY_STATE_INVALID',
      category: 'business',
      message: '组织外部身份状态无效',
    });
    expect(getAccess).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('钉钉绑定用 unionId 换取通讯录 userid 并绑定同一外部租户', async () => {
    const {
      getAccess,
      request,
      resolver,
    } = fixture({
      identity: { externalUserId: 'open-id', unionId: 'union-id' },
    });

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'dingtalk', 'employee-a'),
    ).resolves.toBe('ding-user-id');
    expect(getAccess).toHaveBeenCalledWith('tenant-a', 'dingtalk');
    expect(request).toHaveBeenCalledWith({
      origin: 'https://oapi.dingtalk.com',
      path: '/topapi/user/getbyunionid',
      method: 'POST',
      sensitiveQuery: { access_token: 'access-token' },
      body: { unionid: 'union-id' },
    });
  });

  it.each([
    { accessToken: 'line\nbreak', externalTenantId: 'corp-id', clientId: 'app' },
    { accessToken: 'token', externalTenantId: 'other-corp', clientId: 'app' },
    { accessToken: 'token', externalTenantId: 'corp-id' },
  ])('令牌投影受损或外部租户漂移时禁止平台调用 %#', async (access) => {
    const { request, resolver } = fixture({ access });

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'dingtalk', 'employee-a'),
    ).rejects.toMatchObject({
      code: 'DINGTALK_TENANT_CONTEXT_MISMATCH',
      category: 'business',
      message: '钉钉租户上下文不一致',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('钉钉响应必须是成功且包含规范 userid 的运行时契约', async () => {
    const { request, resolver } = fixture();
    request
      .mockResolvedValueOnce({ status: 200, body: {} })
      .mockResolvedValueOnce({ status: 200, body: { errcode: 40001 } })
      .mockResolvedValueOnce({ status: 200, body: { errcode: 0 } })
      .mockResolvedValueOnce({
        status: 200,
        body: { errcode: 0, result: { userid: '$bad' } },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          errcode: 0,
          request_id: 'provider-metadata',
          result: { userid: 'ding-user-id', name: 'ignored' },
        },
      });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        resolver.findBoundExternalUserId(
          'tenant-a',
          'dingtalk',
          'employee-a',
        ),
      ).rejects.toMatchObject({
        code: 'DINGTALK_USER_ID_RESOLUTION_FAILED',
        category: 'retryable',
        message: '钉钉员工标识解析失败',
      });
    }
    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'dingtalk', 'employee-a'),
    ).resolves.toBe('ding-user-id');
  });
});
