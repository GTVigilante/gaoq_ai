import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { SsoAdapterRegistry } from './sso-adapter.js';
import type { SsoStateService } from './sso-state.service.js';
import type { SsoTenantBindingRepository } from './sso-tenant-binding.repository.js';
import { SsoController } from './sso.controller.js';

const createController = (binding: object | null) => {
  const resolveActive = vi.fn().mockResolvedValue(binding);
  const bindings = { resolveActive };
  const issue = vi.fn().mockResolvedValue({ state: 'state-001', codeChallenge: 'challenge-001' });
  const states = {
    issue,
  };
  const buildAuthorizationUrl = vi
    .fn()
    .mockReturnValue('https://accounts.example/authorize?state=state-001');
  const adapter = {
    buildAuthorizationUrl,
  };
  const adapters = { get: vi.fn().mockReturnValue(adapter) };
  return {
    controller: new SsoController(
      bindings as unknown as SsoTenantBindingRepository,
      states as unknown as SsoStateService,
      adapters as unknown as SsoAdapterRegistry,
    ),
    resolveActive,
    issue,
    buildAuthorizationUrl,
  };
};

describe('SsoController', () => {
  it('租户解析后签发 state 并生成固定供应商授权地址', async () => {
    const { controller, issue, buildAuthorizationUrl } = createController({
      tenantId: 'tenant-001',
      provider: 'feishu',
      externalTenantId: 'external-tenant-001',
    });

    await expect(
      controller.start('feishu', { tenantSlug: 'gaoq-group', returnPath: '/workspace' }),
    ).resolves.toEqual({
      authorizationUrl: 'https://accounts.example/authorize?state=state-001',
      expiresIn: 300,
    });
    expect(issue).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      provider: 'feishu',
      externalTenantId: 'external-tenant-001',
      returnPath: '/workspace',
    });
    expect(buildAuthorizationUrl).toHaveBeenCalledWith({
      state: 'state-001',
      codeChallenge: 'challenge-001',
    });
  });

  it('无租户绑定时使用通用错误拒绝', async () => {
    const { controller } = createController(null);

    await expect(
      controller.start('dingtalk', { tenantSlug: 'unknown-tenant', returnPath: '/' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('在访问任何仓储前拒绝非白名单 provider', async () => {
    const { controller, resolveActive } = createController(null);

    await expect(
      controller.start('custom', { tenantSlug: 'gaoq-group', returnPath: '/' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveActive).not.toHaveBeenCalled();
  });
});
