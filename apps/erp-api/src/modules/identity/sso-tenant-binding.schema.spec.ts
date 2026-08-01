import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  SsoTenantBindingSchema,
  type SsoTenantBinding,
} from './sso-tenant-binding.schema.js';

const mongoose = new Mongoose();
const Binding = mongoose.model<SsoTenantBinding>('SpecOpSsoTenantBinding', SsoTenantBindingSchema);

describe('SsoTenantBindingSchema', () => {
  it('接受 OP 租户绑定且保留 provider 唯一索引边界', async () => {
    await expect(new Binding({
      tenantId: 'tenant-001', loginSlug: 'gaoq-group', provider: 'op',
      externalTenantId: 'op-tenant-001', status: 'active',
    }).validate()).resolves.toBeUndefined();
    expect(SsoTenantBindingSchema.indexes()).toContainEqual([
      { tenantId: 1, provider: 1 }, { unique: true },
    ]);
  });

  it('拒绝操作符形态租户、非规范别名与非法外部租户', async () => {
    for (const override of [
      { tenantId: '$where' },
      { loginSlug: '$ne' },
      { externalTenantId: '$bad' },
    ]) {
      await expect(new Binding({
        tenantId: 'tenant-001', loginSlug: 'gaoq-group', provider: 'op',
        externalTenantId: 'op-tenant-001', status: 'active', ...override,
      }).validate()).rejects.toThrow();
    }
  });
});
