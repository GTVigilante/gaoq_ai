import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { ESignBindingSchema, type ESignBinding } from './esign-binding.schema.js';

const mongoose = new Mongoose();
const BindingModel = mongoose.model<ESignBinding>('SpecESignBinding', ESignBindingSchema);

describe('ESignBindingSchema', () => {
  it('只保存受控 Secret 引用，appId 在供应商内全局唯一', async () => {
    await new BindingModel({
      id: '01K00000000000000000000000', tenantId: 'tenant-001', provider: 'esign_cn',
      appId: 'app12345', credentialSecretRef: 'GAOQ_ESIGN_APP_TENANT_001', status: 'active',
    }).validate();
    expect(ESignBindingSchema.path('appSecret')).toBeUndefined();
    expect(ESignBindingSchema.path('token')).toBeUndefined();
    expect(ESignBindingSchema.indexes()).toContainEqual([
      { provider: 1, appId: 1 }, { unique: true },
    ]);
  });

  it('禁止任意环境变量引用', async () => {
    await expect(new BindingModel({
      id: '01K00000000000000000000000', tenantId: 'tenant-001', provider: 'esign_cn',
      appId: 'app12345', credentialSecretRef: 'DATABASE_URL', status: 'active',
    }).validate()).rejects.toThrow();
  });
});
