import type { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  createLocalJWKSet,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from 'jose';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { SecretManagedRsaAccessTokenSigner } from './access-token-signer.js';

const createConfig = (
  values: Readonly<Record<string, string | number | undefined>>,
): ConfigService<AppEnvironment, true> =>
  ({ get: (key: string): string | number | undefined => values[key] }) as unknown as ConfigService<
    AppEnvironment,
    true
  >;

const createSigningConfig = async (): Promise<ConfigService<AppEnvironment, true>> => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const pem = await exportPKCS8(privateKey);
  return createConfig({
    AUTH_SIGNING_PRIVATE_KEY_BASE64: Buffer.from(pem).toString('base64'),
    AUTH_SIGNING_KEY_ID: 'erp-signing-2026-01',
    AUTH_ACCESS_TOKEN_TTL_SECONDS: 600,
    AUTH_ISSUER: 'https://auth.example.internal',
    AUTH_AUDIENCE: 'gaoq-erp',
    AUTH_RESOURCE: 'https://erp.example.com/mcp',
  });
};

describe('SecretManagedRsaAccessTokenSigner', () => {
  it('签发可由公开 JWKS 验证的受众和资源约束访问令牌', async () => {
    const signer = new SecretManagedRsaAccessTokenSigner(await createSigningConfig());

    const result = await signer.sign({
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      actorType: 'user',
      sessionId: 'session-001',
      clientId: 'gaoq-web',
      roleCodes: ['employee'],
      scopes: ['erp:mcp:server:connect', 'erp:identity:profile:read'],
      departmentIds: ['department-001'],
    });
    const jwks = await signer.getPublicJwks();
    const { payload, protectedHeader } = await jwtVerify(
      result.accessToken,
      createLocalJWKSet(jwks),
      {
        issuer: 'https://auth.example.internal',
        audience: 'gaoq-erp',
        algorithms: ['RS256'],
        typ: 'at+jwt',
      },
    );

    expect(result).toMatchObject({ tokenType: 'Bearer', expiresIn: 600 });
    expect(protectedHeader).toMatchObject({ alg: 'RS256', typ: 'at+jwt', kid: 'erp-signing-2026-01' });
    expect(payload).toMatchObject({
      tenant_id: 'tenant-001',
      actor_id: 'actor-001',
      sid: 'session-001',
      client_id: 'gaoq-web',
      resource: 'https://erp.example.com/mcp',
    });
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('缺少 Secret Manager 私钥时失败关闭且不泄露配置', async () => {
    const signer = new SecretManagedRsaAccessTokenSigner(
      createConfig({ AUTH_ACCESS_TOKEN_TTL_SECONDS: 600 }),
    );

    await expect(
      signer.sign({
        tenantId: 'tenant-001',
        actorId: 'actor-001',
        actorType: 'user',
        sessionId: 'session-001',
        clientId: 'gaoq-web',
        roleCodes: [],
        scopes: [],
        departmentIds: [],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
