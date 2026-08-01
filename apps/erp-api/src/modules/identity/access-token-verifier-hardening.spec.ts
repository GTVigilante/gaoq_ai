import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JWTPayload } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  RemoteJwksAccessTokenVerifier,
} from './access-token-verifier.js';
import type { OAuthServiceClientRegistry } from './oauth-service-client-registry.js';
import type { SessionService } from './session.service.js';

const joseMocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: joseMocks.createRemoteJWKSet,
  jwtVerify: joseMocks.jwtVerify,
}));

const validPayload = (
  overrides: Readonly<Record<string, unknown>> = {},
): JWTPayload => ({
  iss: 'https://auth.example.internal',
  sub: 'tenant-001:employee-001',
  aud: 'gaoq-erp',
  exp: 4_102_444_800,
  tenant_id: 'tenant-001',
  actor_id: 'employee-001',
  actor_type: 'user',
  client_id: 'gaoq-web',
  azp: 'gaoq-web',
  roles: ['employee'],
  scope: 'erp:mcp:server:connect erp:identity:profile:read',
  department_ids: ['department-001'],
  sid: 'session-001',
  resource: 'https://erp.example.com/mcp',
  ...overrides,
});

function fixture() {
  const config = {
    get: (key: string) => {
      if (key === 'AUTH_JWKS_URI') return 'https://auth.example.internal/.well-known/jwks.json';
      if (key === 'AUTH_ISSUER') return 'https://auth.example.internal';
      if (key === 'AUTH_AUDIENCE') return 'gaoq-erp';
      if (key === 'AUTH_RESOURCE') return 'https://erp.example.com/mcp';
      return undefined;
    },
  } as unknown as ConfigService<AppEnvironment, true>;
  const sessions = {
    isActive: vi.fn().mockResolvedValue(true),
  };
  const serviceClients = {
    isActiveTokenIdentity: vi.fn().mockReturnValue(true),
  };
  const verifier = new RemoteJwksAccessTokenVerifier(
    config,
    sessions as unknown as SessionService,
    serviceClients as unknown as OAuthServiceClientRegistry,
  );
  return { verifier, sessions, serviceClients };
}

describe('RemoteJwksAccessTokenVerifier 失败关闭', () => {
  beforeEach(() => {
    joseMocks.jwtVerify.mockReset();
  });

  it('人员令牌必须绑定已存在的活动会话', async () => {
    joseMocks.jwtVerify.mockResolvedValue({ payload: validPayload() });
    const { verifier, sessions, serviceClients } = fixture();

    await expect(verifier.verify('signed-user-token')).resolves.toMatchObject({
      actorType: 'user',
      tenantId: 'tenant-001',
    });
    expect(sessions.isActive).toHaveBeenCalledWith('tenant-001', 'session-001', true);
    expect(serviceClients.isActiveTokenIdentity).not.toHaveBeenCalled();
  });

  it('不存在或已失效的人员会话返回稳定未授权错误', async () => {
    joseMocks.jwtVerify.mockResolvedValue({ payload: validPayload() });
    const { verifier, sessions } = fixture();
    sessions.isActive.mockResolvedValue(false);

    await expect(verifier.verify('signed-user-token')).rejects.toMatchObject({
      response: { code: 'AUTH_SESSION_INACTIVE' },
    });
  });

  it('MCP 服务令牌同时绑定活动凭据及完整授权投影', async () => {
    joseMocks.jwtVerify.mockResolvedValue({
      payload: validPayload({
        sub: 'tenant-001:mcp-agent-001',
        actor_id: 'mcp-agent-001',
        actor_type: 'mcp_client',
        client_id: 'service-client-001',
        azp: 'service-client-001',
        sid: 'credential-001',
      }),
    });
    const { verifier, sessions, serviceClients } = fixture();

    await expect(verifier.verify('signed-service-token')).resolves.toMatchObject({
      actorType: 'mcp_client',
      clientId: 'service-client-001',
    });
    expect(sessions.isActive).toHaveBeenCalledWith('tenant-001', 'credential-001', false);
    expect(serviceClients.isActiveTokenIdentity).toHaveBeenCalledWith({
      clientId: 'service-client-001',
      tenantId: 'tenant-001',
      actorId: 'mcp-agent-001',
      credentialId: 'credential-001',
      scopes: ['erp:mcp:server:connect', 'erp:identity:profile:read'],
      roleCodes: ['employee'],
      departmentIds: ['department-001'],
    });
  });

  it('MCP 客户端或凭据已撤销时拒绝既有签名令牌', async () => {
    joseMocks.jwtVerify.mockResolvedValue({
      payload: validPayload({
        sub: 'tenant-001:mcp-agent-001',
        actor_id: 'mcp-agent-001',
        actor_type: 'mcp_client',
        client_id: 'service-client-001',
        azp: 'service-client-001',
        sid: 'credential-001',
      }),
    });
    const { verifier, serviceClients } = fixture();
    serviceClients.isActiveTokenIdentity.mockReturnValue(false);

    await expect(verifier.verify('signed-service-token')).rejects.toMatchObject({
      response: { code: 'AUTH_SERVICE_CLIENT_INACTIVE' },
    });
  });

  it('受信任内部服务令牌不要求人员会话存在', async () => {
    joseMocks.jwtVerify.mockResolvedValue({
      payload: validPayload({
        sub: 'tenant-001:internal-service',
        actor_id: 'internal-service',
        actor_type: 'service',
        client_id: 'internal-client',
        azp: 'internal-client',
        sid: 'service-session',
      }),
    });
    const { verifier, sessions } = fixture();

    await expect(verifier.verify('signed-internal-token')).resolves.toMatchObject({
      actorType: 'service',
    });
    expect(sessions.isActive).toHaveBeenCalledWith('tenant-001', 'service-session', false);
  });

  it('验签异常统一为 AUTH_INVALID_TOKEN 且不回显底层错误', async () => {
    joseMocks.jwtVerify.mockRejectedValue(new Error('remote key detail'));
    const { verifier } = fixture();

    await expect(verifier.verify('invalid-token')).rejects.toMatchObject({
      response: { code: 'AUTH_INVALID_TOKEN', message: '访问令牌无效' },
    });
  });

  it('已验签但声明非法时保留精确失败分类', async () => {
    joseMocks.jwtVerify.mockResolvedValue({
      payload: validPayload({ resource: 'https://other.example.com/api' }),
    });
    const { verifier } = fixture();

    await expect(verifier.verify('wrong-resource-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(verifier.verify('wrong-resource-token')).rejects.toMatchObject({
      response: { code: 'AUTH_WRONG_RESOURCE' },
    });
  });
});
