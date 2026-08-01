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
const PAYROLL_RESOURCE = 'https://payroll.example.com/api';
const REDIRECT_URI = 'https://client.example.com/oauth/callback';
const CLIENT_ID = 'mcp-client-001';
const CODE_VERIFIER = 'A'.repeat(43);
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');

class MemoryRedis {
  readonly records = new Map<string, string>();
  readonly setResults: Array<'OK' | null> = [];
  readonly evalResults: number[] = [];

  set(key: string, value: string): Promise<'OK' | null> {
    const result = this.setResults.length === 0 ? 'OK' : this.setResults.shift() ?? null;
    if (result !== 'OK') return Promise.resolve(result);
    this.records.set(key, value);
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.records.get(key) ?? null);
  }

  eval(_script: string, keyCount: number, ...values: string[]): Promise<number> {
    const forced = this.evalResults.shift();
    if (forced !== undefined) return Promise.resolve(forced);
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
  allowedResources: [RESOURCE],
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
      if (key === 'AUTH_ADDITIONAL_RESOURCES_JSON') {
        return JSON.stringify([{ resource: PAYROLL_RESOURCE, audience: 'gaoq-payroll' }]);
      }
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

function replaceOnlyRecord(
  redis: MemoryRedis,
  mutate: (stored: Record<string, unknown>) => Record<string, unknown>,
): void {
  const entry = [...redis.records.entries()][0];
  if (entry === undefined) throw new Error('测试记录不存在');
  const [key, raw] = entry;
  redis.records.set(key, JSON.stringify(mutate(JSON.parse(raw) as Record<string, unknown>)));
}

describe('OAuthAuthorizationTransactionService 客户端资源授权', () => {
  it('在写入 Redis 前拒绝全局已注册但未授予客户端的资源', async () => {
    const { service, redis } = fixture();
    await expect(service.begin({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: ['erp:mcp:server:connect'],
      resource: PAYROLL_RESOURCE,
      state: 'client-state-001',
      codeChallenge: CODE_CHALLENGE,
    })).rejects.toThrow('该客户端无权访问目标 resource');
    expect(redis.records.size).toBe(0);
  });
});

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
      clientId: 'unknown-client', redirectUri: REDIRECT_URI,
      scopes: ['erp:mcp:server:connect'], resource: RESOURCE,
      state: 'client-state-001', codeChallenge: CODE_CHALLENGE,
    })).rejects.toMatchObject({ response: { code: 'OAUTH_INVALID_CLIENT' } });
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
    await expect(store.service.begin({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      scopes: ['erp:mcp:server:connect'], resource: RESOURCE,
      state: 'contains space', codeChallenge: CODE_CHALLENGE,
    })).rejects.toMatchObject({ response: { code: 'OAUTH_STATE_INVALID' } });
  });

  it.each([
    ['回调', { redirectUri: 'https://evil.example.com/callback' }],
    ['资源', { resource: PAYROLL_RESOURCE }],
    ['Scope', { scopes: ['erp:payroll:payslip:read'] }],
  ])('Redis 中的旧请求%s不再受当前客户端授权时拒绝展示和决策', async (_name, mutation) => {
    const store = fixture();
    const request = await begin(store.service);
    replaceOnlyRecord(store.redis, (stored) => ({ ...stored, ...mutation }));

    await expect(store.service.describe(request.requestId)).rejects.toMatchObject({
      response: { code: 'OAUTH_REQUEST_INVALID' },
    });
    await expect(store.service.decide(request.requestId, true, identity)).rejects.toMatchObject({
      response: { code: 'OAUTH_REQUEST_INVALID' },
    });
  });

  it.each([
    ['租户', { tenantId: 'tenant-evil' }],
    ['回调', { redirectUri: 'https://evil.example.com/callback' }],
    ['资源', { resource: PAYROLL_RESOURCE }],
    ['Scope', { scopes: ['erp:payroll:payslip:read'] }],
  ])('授权码中的%s绑定不再受当前客户端授权时拒绝交换', async (_name, mutation) => {
    const store = fixture();
    const request = await begin(store.service);
    const decision = await store.service.decide(request.requestId, true, identity);
    const code = new URL(decision.redirectTo).searchParams.get('code') ?? '';
    replaceOnlyRecord(store.redis, (stored) => ({ ...stored, ...mutation }));
    const untrustedMutation: Readonly<Record<string, unknown>> = mutation;
    const redirectUri = typeof untrustedMutation['redirectUri'] === 'string'
      ? untrustedMutation['redirectUri']
      : REDIRECT_URI;
    const resource = typeof untrustedMutation['resource'] === 'string'
      ? untrustedMutation['resource']
      : RESOURCE;

    await expect(store.service.exchange({
      code,
      clientId: CLIENT_ID,
      redirectUri,
      resource,
      codeVerifier: CODE_VERIFIER,
    })).rejects.toMatchObject({ response: { code: 'OAUTH_INVALID_GRANT' } });
  });

  it('请求与授权码随机值连续冲突三次时失败关闭', async () => {
    const requestStore = fixture();
    requestStore.redis.setResults.push(null, null, null);
    await expect(begin(requestStore.service)).rejects.toMatchObject({
      response: { code: 'OAUTH_REQUEST_UNAVAILABLE' },
    });

    const codeStore = fixture();
    const request = await begin(codeStore.service);
    codeStore.redis.evalResults.push(-1, -1, -1);
    await expect(codeStore.service.decide(request.requestId, true, identity)).rejects.toMatchObject({
      response: { code: 'OAUTH_CODE_UNAVAILABLE' },
    });
  });

  it('请求或授权码在原子消费前变更时拒绝继续', async () => {
    const denyStore = fixture();
    const denied = await begin(denyStore.service);
    denyStore.redis.evalResults.push(0);
    await expect(denyStore.service.decide(denied.requestId, false, identity)).rejects.toMatchObject({
      response: { code: 'OAUTH_REQUEST_INVALID' },
    });

    const approveStore = fixture();
    const approved = await begin(approveStore.service);
    approveStore.redis.evalResults.push(0);
    await expect(approveStore.service.decide(approved.requestId, true, identity)).rejects.toMatchObject({
      response: { code: 'OAUTH_REQUEST_INVALID' },
    });

    const exchangeStore = fixture();
    const exchangeRequest = await begin(exchangeStore.service);
    const decision = await exchangeStore.service.decide(exchangeRequest.requestId, true, identity);
    const code = new URL(decision.redirectTo).searchParams.get('code') ?? '';
    exchangeStore.redis.evalResults.push(0);
    await expect(exchangeStore.service.exchange({
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      codeVerifier: CODE_VERIFIER,
    })).rejects.toMatchObject({ response: { code: 'OAUTH_INVALID_GRANT' } });
  });

  it.each([
    ['非法 requestId', () => fixture().service.describe('invalid')],
    ['不存在 request', () => fixture().service.describe('A'.repeat(43))],
    ['非法 code', () => fixture().service.exchange({
      code: 'invalid',
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      codeVerifier: CODE_VERIFIER,
    })],
    ['非法 verifier', () => fixture().service.exchange({
      code: `oc_${'A'.repeat(43)}`,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      codeVerifier: 'short',
    })],
  ])('%s时返回稳定失败分类', async (_name, operation) => {
    await expect(operation()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('受损 JSON 和未知客户端请求不进入授权决策', async () => {
    const malformed = fixture();
    const malformedRequest = await begin(malformed.service);
    const malformedKey = [...malformed.redis.records.keys()][0];
    if (malformedKey === undefined) throw new Error('测试记录不存在');
    malformed.redis.records.set(malformedKey, '{bad-json');
    await expect(malformed.service.describe(malformedRequest.requestId)).rejects.toMatchObject({
      response: { code: 'OAUTH_REQUEST_INVALID' },
    });

    const unknown = fixture();
    const unknownRequest = await begin(unknown.service);
    replaceOnlyRecord(unknown.redis, (stored) => ({ ...stored, clientId: 'unknown-client' }));
    await expect(unknown.service.decide(unknownRequest.requestId, true, identity)).rejects.toMatchObject({
      response: { code: 'OAUTH_REQUEST_INVALID' },
    });
  });
});
