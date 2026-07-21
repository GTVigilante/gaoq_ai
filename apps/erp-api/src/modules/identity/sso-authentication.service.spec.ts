import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalIdentityRepository } from './external-identity.repository.js';
import type { SsoAdapter, SsoAdapterRegistry } from './sso-adapter.js';
import { SsoAuthenticationService } from './sso-authentication.service.js';
import type { SsoStateService } from './sso-state.service.js';

const createService = (externalTenantId = 'external-tenant-001', mapping: object | null = {
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  employeeId: 'employee-001',
}) => {
  const consume = vi.fn().mockResolvedValue({
    tenantId: 'tenant-001',
    provider: 'feishu',
    externalTenantId: 'external-tenant-001',
    codeVerifier: 'verifier-001',
    returnPath: '/',
  });
  const states = {
    consume,
  } as unknown as SsoStateService;
  const exchangeAuthorizationCode = vi.fn().mockResolvedValue({
    provider: 'feishu',
    externalTenantId,
    unionId: 'union-001',
    externalUserId: 'user-001',
    displayName: '员工甲',
  });
  const adapter = {
    provider: 'feishu',
    exchangeAuthorizationCode,
  } as unknown as SsoAdapter;
  const adapters = { get: () => adapter } as unknown as SsoAdapterRegistry;
  const findBoundByExternalProfile = vi.fn().mockResolvedValue(mapping);
  const identities = {
    findBoundByExternalProfile,
  } as unknown as ExternalIdentityRepository;
  return {
    service: new SsoAuthenticationService(states, adapters, identities),
    consume,
    exchangeAuthorizationCode,
    findBoundByExternalProfile,
  };
};

describe('SsoAuthenticationService', () => {
  it('只使用一次性 state 中的租户解析严格身份映射', async () => {
    const { service, consume, exchangeAuthorizationCode, findBoundByExternalProfile } =
      createService();

    await expect(
      service.verifyAuthorizationCode({ provider: 'feishu', state: 'state-001', code: 'code-001' }),
    ).resolves.toEqual({
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      employeeId: 'employee-001',
      provider: 'feishu',
      returnPath: '/',
    });
    expect(consume).toHaveBeenCalledWith('state-001', 'feishu');
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith({
      code: 'code-001',
      codeVerifier: 'verifier-001',
      expectedExternalTenantId: 'external-tenant-001',
    });
    expect(findBoundByExternalProfile).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({ unionId: 'union-001', externalUserId: 'user-001' }),
    );
  });

  it('外部平台租户与 state 不一致时在查询映射前拒绝', async () => {
    const { service, findBoundByExternalProfile } = createService('attacker-external-tenant');

    await expect(
      service.verifyAuthorizationCode({ provider: 'feishu', state: 'state-001', code: 'code-001' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findBoundByExternalProfile).not.toHaveBeenCalled();
  });

  it('没有显式 ERP 映射时拒绝登录，不按外部资料自动合并', async () => {
    const { service } = createService('external-tenant-001', null);

    await expect(
      service.verifyAuthorizationCode({ provider: 'feishu', state: 'state-001', code: 'code-001' }),
    ).rejects.toMatchObject({ response: { code: 'SSO_BINDING_REQUIRED' } });
  });
});
