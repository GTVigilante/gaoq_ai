import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  OAUTH_REDIRECT_DENIED_CODE,
  OAUTH_SCOPE_DENIED_CODE,
  OAUTH_SCOPE_INVALID_CODE,
  OAUTH_TENANT_DENIED_CODE,
  OAuthClientRegistry,
} from './oauth-client-registry.js';

/** 构造仅携带 MCP_OAUTH_CLIENTS_JSON 的 ConfigService 替身。 */
const createConfig = (raw: string | undefined): ConfigService<AppEnvironment, true> =>
  ({ get: (): string | undefined => raw }) as unknown as ConfigService<AppEnvironment, true>;

const createRegistry = (raw: string | undefined): OAuthClientRegistry =>
  new OAuthClientRegistry(createConfig(raw));

const validClient = {
  clientId: 'mcp-client-001',
  clientName: 'MCP 公共客户端',
  redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:6274/callback'],
  allowedScopes: ['erp:mcp:server:connect', 'erp:org:chart:read', 'erp:identity:profile:read'],
  tenantIds: ['tenant-001', 'tenant-002'],
  status: 'active',
} as const;

const toJson = (clients: readonly unknown[]): string => JSON.stringify(clients);

/** 捕获构造阶段抛出的异常。 */
const captureConstructError = (raw: string | undefined): unknown => {
  try {
    createRegistry(raw);
  } catch (error) {
    return error;
  }
  throw new Error('预期构造失败但实际成功');
};

/** 捕获同步查询抛出的异常，便于断言稳定错误码。 */
const captureError = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常但实际成功');
};

/** 解析合法客户端，失败时直接让测试报错。 */
const resolveValidClient = (registry: OAuthClientRegistry) => {
  const client = registry.resolveActive('mcp-client-001');
  if (client === undefined) {
    throw new Error('预期客户端存在');
  }
  return client;
};

describe('OAuthClientRegistry 配置解析', () => {
  it('拒绝非法 JSON 字符串', () => {
    expect(captureConstructError('{not-json')).toBeInstanceOf(Error);
    expect((captureConstructError('{not-json') as Error).message).toContain(
      'MCP_OAUTH_CLIENTS_JSON 配置无效',
    );
  });

  it('拒绝非数组 JSON 与携带多余字段的配置', () => {
    expect(captureConstructError('{"clientId":"x"}')).toBeInstanceOf(Error);
    expect(
      captureConstructError(toJson([{ ...validClient, secret: 'should-not-exist' }])),
    ).toBeInstanceOf(Error);
  });

  it('拒绝非法 clientId、空 clientName 与非法 scope', () => {
    expect(captureConstructError(toJson([{ ...validClient, clientId: 'short' }]))).toBeInstanceOf(
      Error,
    );
    expect(
      captureConstructError(toJson([{ ...validClient, clientId: 'bad id with space' }])),
    ).toBeInstanceOf(Error);
    expect(captureConstructError(toJson([{ ...validClient, clientName: '' }]))).toBeInstanceOf(
      Error,
    );
    expect(
      captureConstructError(
        toJson([{ ...validClient, allowedScopes: ['erp:org:chart:read', 'bad scope'] }]),
      ),
    ).toBeInstanceOf(Error);
    expect(
      captureConstructError(
        toJson([{ ...validClient, allowedScopes: ['org:read'] }]),
      ),
    ).toBeInstanceOf(Error);
  });

  it('拒绝全局重复的 clientId', () => {
    const other = { ...validClient, clientName: '另一个客户端' };
    expect(captureConstructError(toJson([validClient, other]))).toBeInstanceOf(Error);
  });

  it('拒绝开放重定向风险配置：非 https、非回环 http、凭据与 fragment', () => {
    const evilUris = [
      'http://evil.example.com/callback',
      'ftp://example.com/callback',
      'https://user:pass@example.com/callback',
      'https://example.com/callback#fragment',
      'not-a-uri',
    ];
    for (const redirectUri of evilUris) {
      expect(
        captureConstructError(toJson([{ ...validClient, redirectUris: [redirectUri] }])),
        `应拒绝 ${redirectUri}`,
      ).toBeInstanceOf(Error);
    }
  });

  it('接受 https 与回环 http 回调地址', () => {
    const registry = createRegistry(
      toJson([
        {
          ...validClient,
          redirectUris: [
            'https://example.com/callback',
            'http://127.0.0.1:8080/callback',
            'http://localhost/callback',
            'http://[::1]:3000/callback',
          ],
        },
      ]),
    );
    expect(registry).toBeInstanceOf(OAuthClientRegistry);
  });

  it('未配置时解析为空注册表', () => {
    const registry = createRegistry(undefined);
    expect(registry.resolveActive('mcp-client-001')).toBeUndefined();
  });
});

describe('OAuthClientRegistry 只读查询', () => {
  it('解析合法 active 客户端并返回深冻结视图', () => {
    const registry = createRegistry(toJson([validClient]));
    const client = resolveValidClient(registry);

    expect(client.clientName).toBe('MCP 公共客户端');
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.redirectUris)).toBe(true);
    expect(Object.isFrozen(client.allowedScopes)).toBe(true);
    expect(Object.isFrozen(client.tenantIds)).toBe(true);
  });

  it('allowedScopes 解析时去重', () => {
    const registry = createRegistry(
      toJson([{ ...validClient, allowedScopes: ['erp:org:chart:read', 'erp:org:chart:read', 'erp:identity:profile:read'] }]),
    );
    const client = resolveValidClient(registry);
    expect(client.allowedScopes).toEqual(['erp:org:chart:read', 'erp:identity:profile:read']);
  });

  it('disabled 与未知客户端统一返回 undefined', () => {
    const registry = createRegistry(
      toJson([
        validClient,
        { ...validClient, clientId: 'mcp-client-002', status: 'disabled' },
      ]),
    );

    expect(registry.resolveActive('mcp-client-002')).toBeUndefined();
    expect(registry.resolveActive('not-registered')).toBeUndefined();
  });

  it('assertRedirect 仅接受精确匹配的预注册地址', () => {
    const registry = createRegistry(toJson([validClient]));
    const client = resolveValidClient(registry);

    expect(() =>
      registry.assertRedirect(client, 'https://claude.ai/api/mcp/auth_callback'),
    ).not.toThrow();
    expect(() => registry.assertRedirect(client, 'http://localhost:6274/callback')).not.toThrow();

    // 路径多一个字符也算未注册，必须是精确匹配。
    const error = captureError(() =>
      registry.assertRedirect(client, 'https://claude.ai/api/mcp/auth_callback/extra'),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: OAUTH_REDIRECT_DENIED_CODE,
    });
  });

  it('assertRedirect 拒绝开放重定向目标', () => {
    const registry = createRegistry(toJson([validClient]));
    const client = resolveValidClient(registry);

    const error = captureError(() =>
      registry.assertRedirect(client, 'https://evil.example.com/steal'),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: OAUTH_REDIRECT_DENIED_CODE,
    });
  });

  it('assertTenant 拒绝跨租户访问', () => {
    const registry = createRegistry(toJson([validClient]));
    const client = resolveValidClient(registry);

    expect(() => registry.assertTenant(client, 'tenant-001')).not.toThrow();

    const error = captureError(() => registry.assertTenant(client, 'tenant-999'));
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: OAUTH_TENANT_DENIED_CODE,
    });
  });

  it('filterAllowedScopes 通过合法请求并返回冻结数组', () => {
    const registry = createRegistry(toJson([validClient]));
    const client = resolveValidClient(registry);

    const granted = registry.filterAllowedScopes(client, ['erp:org:chart:read', 'erp:identity:profile:read']);
    expect(granted).toEqual(['erp:org:chart:read', 'erp:identity:profile:read']);
    expect(Object.isFrozen(granted)).toBe(true);
  });

  it('授权服务器发现只汇总 active 客户端的去重 scope', () => {
    const registry = createRegistry(toJson([
      validClient,
      { ...validClient, clientId: 'mcp-client-002', allowedScopes: ['erp:org:chart:read'], status: 'disabled' },
    ]));

    expect(registry.listSupportedScopes()).toEqual(['erp:identity:profile:read', 'erp:mcp:server:connect', 'erp:org:chart:read']);
    expect(Object.isFrozen(registry.listSupportedScopes())).toBe(true);
  });

  it('filterAllowedScopes 拒绝空请求与重复 scope（BadRequest）', () => {
    const registry = createRegistry(toJson([validClient]));
    const client = resolveValidClient(registry);

    for (const requested of [[], ['erp:org:chart:read', 'erp:org:chart:read']]) {
      const error = captureError(() => registry.filterAllowedScopes(client, requested));
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: OAUTH_SCOPE_INVALID_CODE,
      });
    }
  });

  it('filterAllowedScopes 拒绝越权 scope（Forbidden）', () => {
    const registry = createRegistry(toJson([validClient]));
    const client = resolveValidClient(registry);

    const error = captureError(() =>
      registry.filterAllowedScopes(client, ['erp:org:chart:read', 'erp:org:chart:read_all']),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: OAUTH_SCOPE_DENIED_CODE,
    });
  });
});
