import type { Model } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrgPlatformBindingDocument } from './org-platform-binding.schema.js';
import {
  EnvironmentOrgSecretResolver,
  OrgPlatformCredentialService,
} from './org-platform-credential.service.js';

const SECRET_NAME = 'GAOQ_ORG_PLATFORM_TENANT_A_DINGTALK';
const PROVISIONING_SECRET_NAME = 'GAOQ_ORG_PROVISIONING_ENCRYPTION_KEYS';

function query(value: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

describe('OrgPlatformCredentialService', () => {
  afterEach(() => {
    delete process.env[SECRET_NAME];
    delete process.env[PROVISIONING_SECRET_NAME];
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

  it('开户编排只读外部租户标识且不解析客户端密钥', async () => {
    const findOne = vi.fn().mockReturnValue(query({ externalTenantId: 'corp-001' }));
    const resolve = vi.fn();
    const service = new OrgPlatformCredentialService(
      { findOne } as unknown as Model<OrgPlatformBindingDocument>,
      { resolve },
    );
    await expect(service.resolveExternalTenantId('tenant-a', 'feishu')).resolves.toBe('corp-001');
    expect(findOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', channel: 'feishu', status: 'active' },
      { externalTenantId: 1, _id: 0 },
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('通用 Secret 解析器允许受控开户密钥引用但拒绝任意环境变量', async () => {
    process.env[PROVISIONING_SECRET_NAME] = '{"redacted":true}';
    const resolver = new EnvironmentOrgSecretResolver();
    await expect(resolver.resolve(PROVISIONING_SECRET_NAME)).resolves.toBe('{"redacted":true}');
    expect(() => resolver.resolve('HOME')).toThrow('平台凭据引用无效');
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
