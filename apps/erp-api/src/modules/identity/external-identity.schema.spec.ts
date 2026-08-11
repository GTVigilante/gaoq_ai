import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  ExternalIdentitySchema,
  type ExternalIdentity,
} from './external-identity.schema.js';

const mongoose = new Mongoose();
const Identity = mongoose.model<ExternalIdentity>(
  'SpecExternalIdentityValidation',
  ExternalIdentitySchema,
);

const validIdentity = () => ({
  tenantId: 'tenant-001',
  provider: 'feishu',
  externalTenantId: 'external-tenant-001',
  unionId: 'union-001',
  externalUserId: 'external-user-001',
  actorId: 'actor-001',
  employeeId: 'employee-001',
  status: 'bound',
});

describe('ExternalIdentitySchema', () => {
  it('接受严格的租户内双标识映射', async () => {
    const identity = new Identity(validIdentity());
    await expect(identity.validate()).resolves.toBeUndefined();
    expect(identity.loginOpenId).toBeNull();
    await expect(new Identity({ ...validIdentity(), provider: 'dingtalk', loginOpenId: 'open-001' })
      .validate()).resolves.toBeUndefined();
  });

  it('拒绝操作符形态 ERP 标识与外部标识', async () => {
    for (const override of [
      { tenantId: '$where' },
      { actorId: '$ne' },
      { employeeId: '$gt' },
      { externalTenantId: '$bad' },
      { unionId: '$bad' },
      { externalUserId: '$bad' },
      { loginOpenId: '$bad' },
    ]) {
      await expect(new Identity({
        ...validIdentity(), ...override,
      }).validate()).rejects.toThrow();
    }
  });
});
