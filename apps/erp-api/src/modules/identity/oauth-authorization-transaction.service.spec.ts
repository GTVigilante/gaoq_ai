import { createHash } from 'node:crypto';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { OAuthAuthorizationTransactionService } from './oauth-authorization-transaction.service.js';
import { OAuthClientRegistry } from './oauth-client-registry.js';
import type { BrowserOAuthIdentity } from './token-grant.service.js';

const RESOURCE = 'https://erp.example.com/mcp';
const REDIRECT_URI = 'https://client.example.com/oauth/callback';
const CLIENT_ID = 'mcp-client-001';
const CODE_VERIFIER = 'A'.repeat(43);
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');

class MemoryRedis {
  readonly records = new Map<string, string>();

  set(key: string, value: string): Promise<'OK'> {
    if (this.records.has(key)) return Promise.resolve('OK');
    this.records.set(key, value);
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.records.get(key) ?? null);
  }

  eval(_script: string, keyCount: number, ...values: string[]): Promise<number> {
    if (keyCount === 1) {
      const [key, expected] = values;
      if (key === undefined || expected === undefined || this.records.get(key) !== expected) {
        return Promise.resolve(0);
      }
      this.records.delete(key);
      return Promise.resolve(1);
    }
    const [requestKey, codeKey, expectedRequest, codePayload] = values;
    if (
      requestKey === undefined || codeKey === undefined || expectedRequest === undefined ||
      codePayload === undefined || this.records.get(requestKey) !== expectedRequest
    ) return Promise.resolve(0);
    if (this.records.has(codeKey)) return Promise.resolve(-1);
    this.records.set(codeKey, codePayload);
    this.records.delete(requestKey);
    return Promise.resolve(1);
  }
}

const clientConfig = JSON.stringify([{
  clientId: CLIENT_ID,
  clientName: '标准 MCP 客户端',
  redirectUris: [REDIRECT_URI],
  allowedScopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
  tenantIds: ['tenant-001'],
  status: 'active',
}]);

const identity: BrowserOAuthIdentity = Object.freeze({
  refreshToken: `rt_${'B'.repeat(64)}`,
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  sessionId: 'session-001',
  roleCodes: Object.freeze(['employee']),
  scopes: Object.freeze(['erp:mcp:server:connect', 'erp:org:chart:read']),
  departmentIds: Object.freeze(['department-001']),
});

function fixture() {
  const redis = new MemoryRedis();
  const config = {
    get: (key: string) => {
      if (key === 'AUTH_RESOURCE') return RESOURCE;
      if (key === 'AUTH_ISSUER') return 'https://erp.example.com';
      if (key === 'AUTH_ADDITIONAL_RESOURCES_JSON') return '[]';
      return clientConfig;
    },
  } as unknown as ConfigService<AppEnvironment, true>;
  const clients = new OAuthClientRegistry(config);
  const service = new OAuthAuthorizationTransactionService(
    redis as unknown as Redis,
    config,
    clients,
  );
  return { service, redis };
}

async function begin(service: OAuthAuthorizationTransactionService) {
  return service.begin({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
    resource: RESOURCE,
    state: 'client-state-001',
    codeChallenge: CODE_CHALLENGE,
  });
}

describe('OAuthAuthorizationTransactionService', () => {
  it('授权请求、同意、PKCE 交换形成一次性资源绑定闭环', async () => {
    const store = fixture();
    const request = await begin(store.service);
    expect(request).toMatchObject({
      clientName: '标准 MCP 客户端',
      redirectOrigin: 'https://client.example.com',
      scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
      expiresIn: 600,
    });
    expect([...store.redis.records.keys()].join(' ')).not.toContain(request.requestId);

    const decision = await store.service.decide(request.requestId, true, identity);
    const redirect = new URL(decision.redirectTo);
    const code = redirect.searchParams.get('code');
    expect(code).toMatch(/^oc_[A-Za-z0-9_-]{43}$/);
    expect(redirect.searchParams.get('state')).toBe('client-state-001');
    expect(redirect.searchParams.get('iss')).toBe('https://erp.example.com');
    expect([...store.redis.records.keys()].join(' ')).not.toContain(code);

    await expect(store.service.exchange({
      code: code ?? '', clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: RESOURCE, codeVerifier: CODE_VERIFIER,
    })).resolves.toEqual({
      tenantId: 'tenant-001', actorId: 'actor-001', sessionId: 'session-001',
      clientId: CLIENT_ID, scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'], resource: RESOURCE,
    });
    await expect(store.service.exchange({
      code: code ?? '', clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: RESOURCE, codeVerifier: CODE_VERIFIER,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('错误 verifier、redirect 或 resource 均不能消费有效授权码', async () => {
    const store = fixture();
    const request = await begin(store.service);
    const decision = await store.service.decide(request.requestId, true, identity);
    const code = new URL(decision.redirectTo).searchParams.get('code') ?? '';

    await expect(store.service.exchange({
      code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: RESOURCE, codeVerifier: 'B'.repeat(43),
    })).rejects.toMatchObject({ response: { code: 'OAUTH_INVALID_GRANT' } });
    await expect(store.service.exchange({
      code, clientId: CLIENT_ID, redirectUri: `${REDIRECT_URI}/evil`,
      resource: RESOURCE, codeVerifier: CODE_VERIFIER,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.service.exchange({
      code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: RESOURCE, codeVerifier: CODE_VERIFIER,
    })).resolves.toMatchObject({ clientId: CLIENT_ID });
  });

  it('客户端不能借同意请求跨租户或扩大主体权限', async () => {
    const store = fixture();
    const crossTenant = await begin(store.service);
    await expect(store.service.decide(crossTenant.requestId, true, {
      ...identity, tenantId: 'tenant-evil',
    })).rejects.toBeInstanceOf(ForbiddenException);

    const missingScope = await begin(store.service);
    await expect(store.service.decide(missingScope.requestId, true, {
      ...identity, scopes: ['erp:mcp:server:connect'],
    })).rejects.toMatchObject({ response: { code: 'OAUTH_SCOPE_NOT_GRANTED' } });
  });

  it('拒绝授权只返回注册回调和原 state，不创建授权码', async () => {
    const store = fixture();
    const request = await begin(store.service);

    const decision = await store.service.decide(request.requestId, false, identity);

    const redirect = new URL(decision.redirectTo);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('client-state-001');
    expect(redirect.searchParams.get('iss')).toBe('https://erp.example.com');
    expect(store.redis.records.size).toBe(0);
  });

  it('拒绝开放回调、重复 scope、错误资源和非 S256 challenge', async () => {
    const store = fixture();
    await expect(store.service.begin({
      clientId: CLIENT_ID,
      redirectUri: 'https://evil.example.com/callback',
      scopes: ['erp:mcp:server:connect'], resource: RESOURCE,
      state: 'client-state-001', codeChallenge: CODE_CHALLENGE,
    })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(store.service.begin({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      scopes: ['erp:mcp:server:connect', 'erp:mcp:server:connect'], resource: RESOURCE,
      state: 'client-state-001', codeChallenge: CODE_CHALLENGE,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.service.begin({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      scopes: ['erp:mcp:server:connect'], resource: 'https://other.example.com/mcp',
      state: 'client-state-001', codeChallenge: CODE_CHALLENGE,
    })).rejects.toMatchObject({ response: { code: 'OAUTH_RESOURCE_INVALID' } });
    await expect(store.service.begin({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      scopes: ['erp:mcp:server:connect'], resource: RESOURCE,
      state: 'client-state-001', codeChallenge: 'plain-verifier-not-s256',
    })).rejects.toMatchObject({ response: { code: 'OAUTH_PKCE_INVALID' } });
  });
});
