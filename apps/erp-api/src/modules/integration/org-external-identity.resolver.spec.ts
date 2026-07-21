import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalIdentityDocument } from '../identity/external-identity.schema.js';
import { OrgExternalIdentityResolver } from './org-external-identity.resolver.js';

describe('OrgExternalIdentityResolver', () => {
  it('只按租户、平台、员工与 bound 状态精确查询最小字段', async () => {
    const bindingFindOne = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ externalTenantId: 'feishu-tenant' }) }),
    });
    const findOne = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ externalUserId: 'user-001', unionId: 'union-001' }) }),
    });
    const resolver = new OrgExternalIdentityResolver(
      { findOne } as unknown as Model<ExternalIdentityDocument>,
      { findOne: bindingFindOne } as never,
      {} as never,
      {} as never,
    );

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'feishu', 'employee-a'),
    ).resolves.toBe('user-001');
    expect(findOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-a', provider: 'feishu', externalTenantId: 'feishu-tenant',
        employeeId: 'employee-a', status: 'bound',
      },
      { externalUserId: 1, unionId: 1, _id: 0 },
    );
  });

  it('非法标识失败关闭且不触发 Mongo 查询', async () => {
    const findOne = vi.fn();
    const resolver = new OrgExternalIdentityResolver(
      { findOne } as unknown as Model<ExternalIdentityDocument>,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      resolver.findBoundExternalUserId('$ne', 'dingtalk', 'employee-a'),
    ).resolves.toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('钉钉绑定用 unionId 换取通讯录 userid，不误用 SSO openId', async () => {
    const identityFindOne = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ externalUserId: 'open-id', unionId: 'union-id' }) }),
    });
    const request = vi.fn().mockResolvedValue({
      status: 200, requestId: undefined,
      body: { errcode: 0, result: { userid: 'ding-user-id' } },
    });
    const resolver = new OrgExternalIdentityResolver(
      { findOne: identityFindOne } as never,
      { findOne: vi.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve({ externalTenantId: 'corp-id' }) }) }) } as never,
      { getAccess: vi.fn().mockResolvedValue({ accessToken: 'token', externalTenantId: 'corp-id' }) } as never,
      { request },
    );

    await expect(
      resolver.findBoundExternalUserId('tenant-a', 'dingtalk', 'employee-a'),
    ).resolves.toBe('ding-user-id');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/topapi/user/getbyunionid',
      sensitiveQuery: { access_token: 'token' },
      body: { unionid: 'union-id' },
    }));
  });
});
