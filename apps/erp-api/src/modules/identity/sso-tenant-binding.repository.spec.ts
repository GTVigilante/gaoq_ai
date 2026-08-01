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

  it('拒绝未知平台且不访问数据库', async () => {
    const model = createModel(null);
    const repository = new SsoTenantBindingRepository(
      model as unknown as Model<SsoTenantBindingDocument>,
    );
    await expect(repository.resolveActive(
      'gaoq-group', 'unknown' as 'feishu',
    )).rejects.toMatchObject({ response: { code: 'SSO_PROVIDER_INVALID' } });
    expect(model.findOne).not.toHaveBeenCalled();
  });

  it('未找到启用绑定时返回 null', async () => {
    const repository = new SsoTenantBindingRepository(
      createModel(null) as unknown as Model<SsoTenantBindingDocument>,
    );
    await expect(repository.resolveActive('gaoq-group', 'op')).resolves.toBeNull();
  });

  it.each([
    { field: 'tenantId', value: '$bad' },
    { field: 'provider', value: 'dingtalk' },
    { field: 'externalTenantId', value: '$bad' },
  ])('拒绝受损租户绑定字段 $field', async ({ field, value }) => {
    const repository = new SsoTenantBindingRepository(
      createModel({
        tenantId: 'tenant-001', provider: 'feishu',
        externalTenantId: 'external-tenant-001', [field]: value,
      }) as unknown as Model<SsoTenantBindingDocument>,
    );
    await expect(repository.resolveActive('gaoq-group', 'feishu'))
      .rejects.toThrow('SSO_TENANT_BINDING_CORRUPT');
  });
});
