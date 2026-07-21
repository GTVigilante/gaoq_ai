import { describe, expect, it, vi } from 'vitest';

import type { OrgPlatformCredentialService } from './org-platform-credential.service.js';
import { OrgPlatformTokenService } from './org-platform-token.service.js';

describe('OrgPlatformTokenService', () => {
  it('按租户渠道合并并发刷新并复用内存令牌', async () => {
    const resolve = vi.fn().mockResolvedValue({
      clientId: 'app-id',
      clientSecret: 'app-secret-value',
      externalTenantId: 'tenant-key',
    });
    const request = vi.fn().mockResolvedValue({
      status: 200,
      requestId: 'request-001',
      body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
    });
    const service = new OrgPlatformTokenService(
      { resolve } as unknown as OrgPlatformCredentialService,
      { request },
    );

    const [first, second] = await Promise.all([
      service.getAccess('tenant-a', 'feishu'),
      service.getAccess('tenant-a', 'feishu'),
    ]);
    expect(first).toEqual({
      accessToken: 'tenant-token', externalTenantId: 'tenant-key', clientId: 'app-id',
    });
    expect(second).toEqual(first);
    await service.getAccess('tenant-a', 'feishu');
    expect(resolve).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('钉钉使用官方应用令牌端点且不把令牌返回结构写入其他层', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      requestId: undefined,
      body: { accessToken: 'dingtalk-token', expireIn: 7200 },
    });
    const service = new OrgPlatformTokenService(
      {
        resolve: vi.fn().mockResolvedValue({
          clientId: 'app-key',
          clientSecret: 'app-secret-value',
          externalTenantId: 'corp-id',
        }),
      } as unknown as OrgPlatformCredentialService,
      { request },
    );

    await expect(service.getAccess('tenant-a', 'dingtalk')).resolves.toEqual({
      accessToken: 'dingtalk-token',
      externalTenantId: 'corp-id',
      clientId: 'app-key',
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://api.dingtalk.com',
      path: '/v1.0/oauth2/accessToken',
      body: { appKey: 'app-key', appSecret: 'app-secret-value' },
    }));
  });

  it('只允许持有当前值的失败请求使缓存令牌失效', async () => {
    const resolve = vi.fn().mockResolvedValue({
      clientId: 'app-id', clientSecret: 'app-secret-value', externalTenantId: 'tenant-key',
    });
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: { code: 0, tenant_access_token: 'token-v1', expire: 7200 },
      })
      .mockResolvedValueOnce({
        status: 200, requestId: undefined,
        body: { code: 0, tenant_access_token: 'token-v2', expire: 7200 },
      });
    const service = new OrgPlatformTokenService(
      { resolve } as unknown as OrgPlatformCredentialService,
      { request },
    );

    await service.getAccess('tenant-a', 'feishu');
    service.invalidate('tenant-a', 'feishu', 'stale-token');
    await expect(service.getAccess('tenant-a', 'feishu')).resolves.toMatchObject({
      accessToken: 'token-v1',
    });
    service.invalidate('tenant-a', 'feishu', 'token-v1');
    await expect(service.getAccess('tenant-a', 'feishu')).resolves.toMatchObject({
      accessToken: 'token-v2',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
