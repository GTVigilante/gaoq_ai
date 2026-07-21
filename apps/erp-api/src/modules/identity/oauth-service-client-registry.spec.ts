import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { OAuthServiceClientRegistry } from './oauth-service-client-registry.js';

const SECRET_DIGEST = 'A'.repeat(43);
const validClient = () => ({
  clientId: 'service-client-001',
  clientName: '自动对账代理',
  tenantId: 'tenant-001',
  actorId: 'mcp-agent-001',
  allowedScopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
  roleCodes: ['service-reader'],
  departmentIds: ['department-001'],
  status: 'active',
  authentication: {
    method: 'client_secret_basic',
    credentials: [{
      credentialId: 'credential-001',
      secretSha256: SECRET_DIGEST,
      notBefore: '2025-01-01T00:00:00+00:00',
      expiresAt: '2030-01-01T00:00:00+00:00',
      status: 'active',
    }],
  },
});

const createRegistry = (value: unknown): OAuthServiceClientRegistry =>
  new OAuthServiceClientRegistry({
    get: () => JSON.stringify(value),
  } as unknown as ConfigService<AppEnvironment, true>);

describe('OAuthServiceClientRegistry', () => {
  it('解析、深冻结并按有效期返回可轮换凭据', () => {
    const registry = createRegistry([validClient()]);
    const client = registry.resolveActive('service-client-001');
    expect(client).toBeDefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client?.authentication.credentials)).toBe(true);
    expect(registry.listCurrentCredentials(client!, new Date('2026-01-01T00:00:00Z')))
      .toHaveLength(1);
    expect(registry.listCurrentCredentials(client!, new Date('2031-01-01T00:00:00Z')))
      .toHaveLength(0);
  });

  it('默认最小权限全集并拒绝重复或越权 scope', () => {
    const registry = createRegistry([validClient()]);
    const client = registry.resolveActive('service-client-001')!;
    expect(registry.filterAllowedScopes(client)).toEqual(client.allowedScopes);
    expect(() => registry.filterAllowedScopes(client, ['erp:org:chart:write']))
      .toThrow('scope 超出客户端授权范围');
    expect(() => registry.filterAllowedScopes(client, [
      'erp:org:chart:read', 'erp:org:chart:read',
    ])).toThrow('scope 请求非法');
  });

  it('凭据吊销、客户端禁用、身份或 scope 变化会即时使既有令牌失效', () => {
    const registry = createRegistry([validClient()]);
    expect(registry.isActiveTokenIdentity({
      clientId: 'service-client-001', tenantId: 'tenant-001', actorId: 'mcp-agent-001',
      credentialId: 'credential-001', scopes: ['erp:org:chart:read'],
      roleCodes: ['service-reader'], departmentIds: ['department-001'],
    })).toBe(true);
    expect(registry.isActiveTokenIdentity({
      clientId: 'service-client-001', tenantId: 'tenant-002', actorId: 'mcp-agent-001',
      credentialId: 'credential-001', scopes: ['erp:org:chart:read'],
      roleCodes: ['service-reader'], departmentIds: ['department-001'],
    })).toBe(false);
    expect(registry.isActiveTokenIdentity({
      clientId: 'service-client-001', tenantId: 'tenant-001', actorId: 'mcp-agent-001',
      credentialId: 'credential-001', scopes: ['erp:org:chart:read'],
      roleCodes: ['legacy-admin'], departmentIds: ['department-001'],
    })).toBe(false);
    const disabled = validClient();
    disabled.status = 'disabled';
    expect(createRegistry([disabled]).resolveActive('service-client-001')).toBeUndefined();
  });

  it.each([
    { configuration: [{ ...validClient(), secret: 'plaintext' }] },
    { configuration: [validClient(), validClient()] },
    { configuration: [{ ...validClient(), allowedScopes: ['erp:org:chart:read', 'erp:org:chart:read'] }] },
    { configuration: [{ ...validClient(), authentication: {
      method: 'client_secret_basic', credentials: [{
        ...validClient().authentication.credentials[0],
        notBefore: '2030-01-01T00:00:00+00:00', expiresAt: '2029-01-01T00:00:00+00:00',
      }],
    } }] },
  ])('启动时拒绝重复、明文或非法有效期配置，且不回显敏感值', ({ configuration }) => {
    expect(() => createRegistry(configuration)).toThrow('MCP_SERVICE_CLIENTS_JSON 配置无效');
    try {
      createRegistry(configuration);
    } catch (error) {
      expect(String(error)).not.toContain('plaintext');
      expect(String(error)).not.toContain(SECRET_DIGEST);
    }
  });
});
