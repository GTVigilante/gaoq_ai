import type { Model } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrgPlatformBindingDocument } from './org-platform-binding.schema.js';
import {
  EnvironmentOrgSecretResolver,
  OrgPlatformCredentialService,
} from './org-platform-credential.service.js';

const SECRET_NAME = 'GAOQ_ORG_PLATFORM_TENANT_A_DINGTALK';

function query(value: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

describe('OrgPlatformCredentialService', () => {
  afterEach(() => {
    delete process.env[SECRET_NAME];
  });

  it('只按租户与渠道读取绑定，并从受控秘密引用解析凭据', async () => {
    const findOne = vi.fn().mockReturnValue(query({
      externalTenantId: 'corp-001',
      credentialSecretRef: SECRET_NAME,
    }));
    process.env[SECRET_NAME] = JSON.stringify({ clientId: 'app-key', clientSecret: 'secret-value' });
    const service = new OrgPlatformCredentialService(
      { findOne } as unknown as Model<OrgPlatformBindingDocument>,
      new EnvironmentOrgSecretResolver(),
    );

    await expect(service.resolve('tenant-a', 'dingtalk')).resolves.toEqual({
      clientId: 'app-key',
      clientSecret: 'secret-value',
      externalTenantId: 'corp-001',
    });
    expect(findOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', channel: 'dingtalk', status: 'active' },
      { externalTenantId: 1, credentialSecretRef: 1, _id: 0 },
    );
  });

  it('拒绝 Mongo 操作符形态租户标识', async () => {
    const service = new OrgPlatformCredentialService(
      { findOne: vi.fn() } as unknown as Model<OrgPlatformBindingDocument>,
      { resolve: vi.fn() },
    );

    await expect(service.resolve('$ne', 'feishu')).rejects.toMatchObject({
      code: 'ORG_TENANT_ID_INVALID',
      category: 'conflict',
    });
  });

  it('秘密缺失和格式错误均失败关闭，异常不携带秘密正文', async () => {
    const findOne = vi.fn().mockReturnValue(query({
      externalTenantId: 'corp-001',
      credentialSecretRef: SECRET_NAME,
    }));
    const service = new OrgPlatformCredentialService(
      { findOne } as unknown as Model<OrgPlatformBindingDocument>,
      new EnvironmentOrgSecretResolver(),
    );

    await expect(service.resolve('tenant-a', 'dingtalk')).rejects.toMatchObject({
      code: 'ORG_CREDENTIAL_UNAVAILABLE',
    });
    process.env[SECRET_NAME] = '{"clientSecret":"leaked-value"';
    const error = await service.resolve('tenant-a', 'dingtalk').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ORG_CREDENTIAL_INVALID' });
    expect(String(error)).not.toContain('leaked-value');
  });
});
