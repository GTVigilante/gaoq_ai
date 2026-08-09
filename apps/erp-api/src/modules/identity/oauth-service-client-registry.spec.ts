import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { OAuthServiceClientRegistry } from './oauth-service-client-registry.js';

const SECRET_DIGEST = 'A'.repeat(43);
const RESOURCE = 'https://erp.example.com/mcp';
const PAYROLL_RESOURCE = 'https://payroll.example.com/api';
const validClient = () => ({
  clientId: 'service-client-001',
  clientName: '自动对账代理',
  tenantId: 'tenant-001',
  actorId: 'mcp-agent-001',
  allowedScopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
  allowedResources: [RESOURCE],
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

const jwtClient = () => ({
  ...validClient(),
  clientId: 'service-client-jwt',
  allowedScopes: ['erp:mcp:server:connect'],
  roleCodes: [],
  departmentIds: [],
  authentication: {
    method: 'private_key_jwt',
    credentials: [{
      credentialId: 'credential-jwt-001',
      notBefore: '2025-01-01T00:00:00+00:00',
      expiresAt: '2030-01-01T00:00:00+00:00',
      status: 'active',
      publicJwk: {
        kty: 'EC', kid: 'credential-jwk-001', alg: 'ES256', use: 'sig',
        key_ops: ['verify'], crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43),
      },
    }],
  },
});

const createRegistry = (value: unknown): OAuthServiceClientRegistry =>
  new OAuthServiceClientRegistry({
    get: (key: keyof AppEnvironment) => {
      if (key === 'MCP_SERVICE_CLIENTS_JSON') return JSON.stringify(value);
      if (key === 'AUTH_RESOURCE') return RESOURCE;
      if (key === 'AUTH_ADDITIONAL_RESOURCES_JSON') {
        return JSON.stringify([{ resource: PAYROLL_RESOURCE, audience: 'gaoq-payroll' }]);
      }
      return undefined;
    },
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
    expect(() => registry.assertResource(client, RESOURCE)).not.toThrow();
    expect(() => registry.assertResource(client, PAYROLL_RESOURCE))
      .toThrow('resource 超出客户端授权范围');
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
    expect(registry.isActiveTokenIdentity({
      clientId: 'service-client-001', tenantId: 'tenant-001', actorId: 'wrong-actor',
      credentialId: 'credential-001', scopes: ['erp:org:chart:read'],
      roleCodes: ['service-reader'], departmentIds: ['department-001'],
    })).toBe(false);
    expect(registry.isActiveTokenIdentity({
      clientId: 'service-client-001', tenantId: 'tenant-001', actorId: 'mcp-agent-001',
      credentialId: 'credential-001',
      scopes: ['erp:org:chart:read', 'erp:org:chart:read'],
      roleCodes: ['service-reader'], departmentIds: ['department-001'],
    })).toBe(false);
    expect(registry.isActiveTokenIdentity({
      clientId: 'service-client-001', tenantId: 'tenant-001', actorId: 'mcp-agent-001',
      credentialId: 'missing-credential', scopes: ['erp:org:chart:read'],
      roleCodes: ['service-reader'], departmentIds: ['department-001'],
    })).toBe(false);
  });

  it('枚举活动客户端能力并只返回登记的公开 JWK', () => {
    const registry = createRegistry([validClient(), jwtClient()]);
    expect(registry.listSupportedAuthMethods())
      .toEqual(['client_secret_basic', 'private_key_jwt']);
    expect(registry.listSupportedScopes())
      .toEqual(['erp:mcp:server:connect', 'erp:org:chart:read']);
    const client = registry.resolveActive('service-client-jwt')!;
    const credential = registry.listCurrentCredentials(
      client, new Date('2026-01-01T00:00:00Z'),
    )[0]!;
    expect(registry.getPublicJwk(credential as never)).toMatchObject({
      kty: 'EC', kid: 'credential-jwk-001',
    });
  });

  it('接受动态表单与多维 Base 的四段式最小权限集合', () => {
    const formClient = {
      ...validClient(),
      allowedScopes: [
        'erp:forms:definition:design',
        'erp:forms:definition:publish',
        'erp:forms:data:read',
        'erp:forms:data:write',
        'erp:bases:workspace:read',
        'erp:bases:workspace:design',
      ],
    };
    const registry = createRegistry([formClient]);
    expect(registry.resolveActive(formClient.clientId)?.allowedScopes)
      .toEqual(formClient.allowedScopes);
  });

  it('空配置安全解析为空注册表，非法 JSON 失败关闭', () => {
    const empty = new OAuthServiceClientRegistry({
      get: (key: keyof AppEnvironment) => key === 'MCP_SERVICE_CLIENTS_JSON' ? '' : undefined,
    } as unknown as ConfigService<AppEnvironment, true>);
    expect(empty.resolveActive('missing-client')).toBeUndefined();
    expect(() => new OAuthServiceClientRegistry({
      get: (key: keyof AppEnvironment) =>
        key === 'MCP_SERVICE_CLIENTS_JSON' ? '{invalid' : undefined,
    } as unknown as ConfigService<AppEnvironment, true>)).toThrow('不是合法 JSON');
  });

  it.each([
    { configuration: [{ ...validClient(), secret: 'plaintext' }] },
    { configuration: [validClient(), validClient()] },
    { configuration: [{ ...validClient(), allowedScopes: ['erp:org:chart:read', 'erp:org:chart:read'] }] },
    { configuration: [{ ...validClient(), allowedResources: [RESOURCE, RESOURCE] }] },
    { configuration: [{ ...validClient(), allowedResources: ['https://unknown.example.com/api'] }] },
    { configuration: [{ ...validClient(), allowedResources: undefined }] },
    { configuration: [{ ...validClient(), authentication: {
      method: 'client_secret_basic', credentials: [{
        ...validClient().authentication.credentials[0],
        notBefore: '2030-01-01T00:00:00+00:00', expiresAt: '2029-01-01T00:00:00+00:00',
      }],
    } }] },
    { configuration: [
      jwtClient(),
      {
        ...jwtClient(), clientId: 'service-client-jwt-2',
        authentication: {
          ...jwtClient().authentication,
          credentials: [{
            ...jwtClient().authentication.credentials[0],
            credentialId: 'credential-jwt-002',
          }],
        },
      },
    ] },
    { configuration: [
      validClient(),
      {
        ...validClient(), clientId: 'service-client-002',
        authentication: {
          ...validClient().authentication,
          credentials: [{
            ...validClient().authentication.credentials[0],
          }],
        },
      },
    ] },
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
