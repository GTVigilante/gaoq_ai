import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { PrivateKeyJwtProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { AccessTokenSigner } from './access-token-signer.js';
import { OAuthClientCredentialsGrantService } from './oauth-client-credentials-grant.service.js';
import { OAuthServiceClientRegistry } from './oauth-service-client-registry.js';

const ISSUER = 'https://erp.example.com';
const RESOURCE = 'https://erp.example.com/mcp';
const PAYROLL_RESOURCE = 'https://payroll.example.com/api';
const SECRET = 'A'.repeat(43);
const TRACE_ID = 'trace-service-001';

const config = (clients: unknown): ConfigService<AppEnvironment, true> => ({
  get: (key: keyof AppEnvironment) => {
    if (key === 'MCP_SERVICE_CLIENTS_JSON') return JSON.stringify(clients);
    if (key === 'AUTH_RESOURCE') return RESOURCE;
    if (key === 'AUTH_ADDITIONAL_RESOURCES_JSON') {
      return JSON.stringify([{ resource: PAYROLL_RESOURCE, audience: 'gaoq-payroll' }]);
    }
    if (key === 'AUTH_ISSUER') return ISSUER;
    return undefined;
  },
} as unknown as ConfigService<AppEnvironment, true>);

const commonClient = {
  clientId: 'service-client-001', clientName: '自动代理', tenantId: 'tenant-001',
  actorId: 'mcp-agent-001', allowedScopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
  allowedResources: [RESOURCE],
  roleCodes: ['service-reader'], departmentIds: ['department-001'], status: 'active',
} as const;

const commonCredential = {
  credentialId: 'credential-001', notBefore: '2025-01-01T00:00:00+00:00',
  expiresAt: '2030-01-01T00:00:00+00:00', status: 'active',
} as const;

const createService = (clients: unknown, redisSet = vi.fn().mockResolvedValue('OK')) => {
  const appConfig = config(clients);
  const signer = {
    sign: vi.fn().mockResolvedValue({ accessToken: 'signed', tokenType: 'Bearer', expiresIn: 600 }),
  };
  const audit = {
    recordTrustedService: vi.fn().mockResolvedValue(undefined),
  };
  const service = new OAuthClientCredentialsGrantService(
    appConfig,
    { set: redisSet } as unknown as Redis,
    new OAuthServiceClientRegistry(appConfig),
    signer as unknown as AccessTokenSigner,
    audit as unknown as AuditService,
  );
  return { service, signer, audit, redisSet };
};

const basicClient = () => ({
  ...commonClient,
  authentication: {
    method: 'client_secret_basic',
    credentials: [{
      ...commonCredential,
      secretSha256: createHash('sha256').update(SECRET).digest('base64url'),
    }],
  },
});

describe('OAuthClientCredentialsGrantService', () => {
  it('使用 Basic 摘要常量时间认证并签发 mcp_client 资源令牌', async () => {
    const store = createService([basicClient()]);
    const grant = await store.service.issue({
      authorization: `Basic ${Buffer.from(`service-client-001:${SECRET}`).toString('base64')}`,
      resource: RESOURCE,
      scopes: ['erp:org:chart:read'],
      traceId: TRACE_ID,
    });
    expect(grant).toEqual({ accessToken: 'signed', tokenType: 'Bearer', expiresIn: 600, scope: 'erp:org:chart:read' });
    expect(store.signer.sign).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'mcp_client', sessionId: 'credential-001', clientId: 'service-client-001',
      tenantId: 'tenant-001', scopes: ['erp:org:chart:read'],
    }));
    expect(store.audit.recordTrustedService).toHaveBeenCalledWith('tenant-001', expect.objectContaining({
      outcome: 'success', resourceId: 'service-client-001',
    }));
  });

  it('令牌已签名但成功审计失败时不得追加虚假的签名失败审计', async () => {
    const store = createService([basicClient()]);
    store.audit.recordTrustedService.mockRejectedValueOnce(new Error('审计不可用'));
    await expect(store.service.issue({
      authorization: `Basic ${Buffer.from(`service-client-001:${SECRET}`).toString('base64')}`,
      resource: RESOURCE,
      scopes: ['erp:org:chart:read'],
      traceId: TRACE_ID,
    })).rejects.toThrow('审计不可用');
    expect(store.audit.recordTrustedService).toHaveBeenCalledOnce();
    expect(store.audit.recordTrustedService).toHaveBeenCalledWith(
      'tenant-001', expect.objectContaining({ outcome: 'success' }),
    );
  });

  it.each([
    'wrong-secret-value-that-is-still-long-enough-1234567890',
    'short',
  ])('Basic 错误凭据统一返回 invalid_client：%s', async (secret) => {
    const store = createService([basicClient()]);
    await expect(store.service.issue({
      authorization: `Basic ${Buffer.from(`service-client-001:${secret}`).toString('base64')}`,
      resource: RESOURCE,
      traceId: TRACE_ID,
    })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('拒绝错误 resource、重复 scope 以及 Basic 与断言混用', async () => {
    const store = createService([basicClient()]);
    const authorization = `Basic ${Buffer.from(`service-client-001:${SECRET}`).toString('base64')}`;
    await expect(store.service.issue({ authorization, resource: 'https://attacker.example/mcp', traceId: TRACE_ID }))
      .rejects.toThrow('resource 非法');
    await expect(store.service.issue({
      authorization, resource: RESOURCE,
      scopes: ['erp:org:chart:read', 'erp:org:chart:read'], traceId: TRACE_ID,
    })).rejects.toThrow('scope 请求非法');
    await expect(store.service.issue({
      authorization, clientAssertion: 'jwt', resource: RESOURCE, traceId: TRACE_ID,
    })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('认证后拒绝未授权资源，并为显式授权资源传递正确 resource', async () => {
    const authorization = `Basic ${Buffer.from(`service-client-001:${SECRET}`).toString('base64')}`;
    const denied = createService([basicClient()]);
    await expect(denied.service.issue({
      authorization,
      resource: PAYROLL_RESOURCE,
      scopes: ['erp:org:chart:read'],
      traceId: TRACE_ID,
    })).rejects.toThrow('resource 超出客户端授权范围');
    expect(denied.signer.sign).not.toHaveBeenCalled();

    const allowed = createService([{
      ...basicClient(),
      allowedResources: [RESOURCE, PAYROLL_RESOURCE],
    }]);
    await expect(allowed.service.issue({
      authorization,
      resource: PAYROLL_RESOURCE,
      scopes: ['erp:org:chart:read'],
      traceId: TRACE_ID,
    })).resolves.toMatchObject({ accessToken: 'signed' });
    expect(allowed.signer.sign).toHaveBeenCalledWith(
      expect.objectContaining({ resource: PAYROLL_RESOURCE }),
    );
  });

  it('验证无 kid 的 private_key_jwt、接受 issuer audience 并阻断断言重放', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const client = {
      ...commonClient,
      authentication: {
        method: 'private_key_jwt',
        credentials: [{
          ...commonCredential,
          publicJwk: {
            ...publicJwk, kty: 'EC', crv: 'P-256', kid: 'service-key-001', alg: 'ES256',
            use: 'sig', key_ops: ['verify'],
          },
        }],
      },
    };
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setIssuer(commonClient.clientId).setSubject(commonClient.clientId).setAudience(ISSUER)
      .setJti('assertion-jti-001').setIssuedAt(now).setExpirationTime(now + 120)
      .sign(privateKey);
    const redisSet = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const store = createService([client], redisSet);
    const input = {
      clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      clientAssertion: assertion,
      resource: RESOURCE,
      traceId: TRACE_ID,
    };
    await expect(store.service.issue(input)).resolves.toMatchObject({ accessToken: 'signed' });
    expect(redisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^oauth:client-assertion:[A-Za-z0-9_-]{43}$/),
      '1', 'EX', expect.any(Number), 'NX',
    );
    await expect(store.service.issue(input)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('兼容官方 MCP PrivateKeyJwtProvider 不发送 body client_id 的请求形态', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const [publicJwk, privateJwk] = await Promise.all([exportJWK(publicKey), exportJWK(privateKey)]);
    const client = {
      ...commonClient,
      authentication: { method: 'private_key_jwt', credentials: [{
        ...commonCredential,
        publicJwk: { ...publicJwk, kty: 'EC', crv: 'P-256', kid: 'service-key-sdk-001', alg: 'ES256', use: 'sig', key_ops: ['verify'] },
      }] },
    };
    const provider = new PrivateKeyJwtProvider({
      clientId: commonClient.clientId,
      privateKey: { ...privateJwk },
      algorithm: 'ES256',
      jwtLifetimeSeconds: 120,
    });
    const params = provider.prepareTokenRequest();
    await provider.addClientAuthentication(
      new Headers(),
      params,
      `${ISSUER}/api/auth/oauth/token`,
    );
    expect(params.has('client_id')).toBe(false);
    const assertionType = params.get('client_assertion_type');
    const assertion = params.get('client_assertion');
    expect(assertionType).not.toBeNull();
    expect(assertion).not.toBeNull();
    const store = createService([client]);
    await expect(store.service.issue({
      clientAssertionType: assertionType ?? '',
      clientAssertion: assertion ?? '',
      resource: RESOURCE,
      traceId: TRACE_ID,
    })).resolves.toMatchObject({ accessToken: 'signed' });
  });

  it('拒绝 body client_id 与已验签断言主体不一致', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const client = {
      ...commonClient,
      authentication: { method: 'private_key_jwt', credentials: [{
        ...commonCredential,
        publicJwk: { ...publicJwk, kty: 'EC', crv: 'P-256', kid: 'service-key-003', alg: 'ES256', use: 'sig', key_ops: ['verify'] },
      }] },
    };
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setIssuer(commonClient.clientId).setSubject(commonClient.clientId).setAudience(ISSUER)
      .setJti('assertion-jti-003').setIssuedAt(now).setExpirationTime(now + 120).sign(privateKey);
    const store = createService([client]);
    await expect(store.service.issue({
      clientId: 'another-client-001',
      clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      clientAssertion: assertion, resource: RESOURCE, traceId: TRACE_ID,
    })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.signer.sign).not.toHaveBeenCalled();
  });

  it('断言防重放存储不可用时 fail closed', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const client = {
      ...commonClient,
      authentication: { method: 'private_key_jwt', credentials: [{
        ...commonCredential,
        publicJwk: { ...publicJwk, kty: 'EC', crv: 'P-256', kid: 'service-key-002', alg: 'ES256', use: 'sig', key_ops: ['verify'] },
      }] },
    };
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'service-key-002' })
      .setIssuer(commonClient.clientId).setSubject(commonClient.clientId).setAudience(`${ISSUER}/api/auth/oauth/token`)
      .setJti('assertion-jti-002').setIssuedAt(now).setExpirationTime(now + 120).sign(privateKey);
    const store = createService([client], vi.fn().mockRejectedValue(new Error('redis down')));
    await expect(store.service.issue({
      clientId: commonClient.clientId,
      clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      clientAssertion: assertion, resource: RESOURCE, traceId: TRACE_ID,
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
