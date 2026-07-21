import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { SsoTenantBindingRepository } from './sso-tenant-binding.repository.js';
import type { SsoTenantBindingDocument } from './sso-tenant-binding.schema.js';

const createModel = (result: unknown) => ({
  findOne: vi.fn().mockReturnValue({
    lean: () => ({ exec: () => Promise.resolve(result) }),
  }),
});

describe('SsoTenantBindingRepository', () => {
  it('仅按白名单化登录别名解析启用绑定并返回最小字段', async () => {
    const model = createModel({
      tenantId: 'tenant-001',
      provider: 'feishu',
      externalTenantId: 'external-tenant-001',
      secret: 'must-not-return',
    });
    const repository = new SsoTenantBindingRepository(
      model as unknown as Model<SsoTenantBindingDocument>,
    );

    await expect(repository.resolveActive('gaoq-group', 'feishu')).resolves.toEqual({
      tenantId: 'tenant-001',
      provider: 'feishu',
      externalTenantId: 'external-tenant-001',
    });
    expect(model.findOne).toHaveBeenCalledWith(
      { loginSlug: 'gaoq-group', provider: 'feishu', status: 'active' },
      { tenantId: 1, provider: 1, externalTenantId: 1, _id: 0 },
    );
  });

  it('在查询前拒绝 Mongo 操作符与非规范别名', async () => {
    const model = createModel(null);
    const repository = new SsoTenantBindingRepository(
      model as unknown as Model<SsoTenantBindingDocument>,
    );

    await expect(repository.resolveActive('$ne', 'dingtalk')).rejects.toThrow();
    expect(model.findOne).not.toHaveBeenCalled();
  });
});
