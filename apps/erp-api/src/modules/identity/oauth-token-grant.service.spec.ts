import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AccessProfileRepository } from './access-profile.repository.js';
import type { AccessTokenSigner } from './access-token-signer.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { OAuthAuthorizationTransactionService } from './oauth-authorization-transaction.service.js';
import { OAuthTokenGrantService } from './oauth-token-grant.service.js';
import type { SessionService } from './session.service.js';

const authorization = {
  tenantId: 'tenant-001', actorId: 'actor-001', sessionId: 'session-001',
  clientId: 'mcp-client-001', scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
  resource: 'https://erp.example.com/mcp',
};

function fixture() {
  const exchange = vi.fn().mockResolvedValue(authorization);
  const resolveActive = vi.fn().mockResolvedValue({
    tenantId: 'tenant-001', actorId: 'actor-001', employeeId: 'employee-001',
    status: 'active', roleCodes: ['employee'], scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'],
    departmentIds: ['department-001'], version: 1,
  });
  const isActive = vi.fn().mockResolvedValue(true);
  const sign = vi.fn().mockResolvedValue({
    accessToken: 'signed-oauth-access-token', tokenType: 'Bearer', expiresIn: 600,
  });
  const recordTrustedUser = vi.fn().mockResolvedValue(undefined);
  const service = new OAuthTokenGrantService(
    { exchange } as unknown as OAuthAuthorizationTransactionService,
    { resolveActive } as unknown as AccessProfileRepository,
    { isActive } as unknown as SessionService,
    { sign } as unknown as AccessTokenSigner,
    { recordTrustedUser } as unknown as AuditService,
  );
  return { service, exchange, resolveActive, isActive, sign, recordTrustedUser };
}

describe('OAuthTokenGrantService', () => {
  it('重新校验会话和权限后以 OAuth clientId 与最小 scope 签发令牌', async () => {
    const store = fixture();

    await expect(store.service.exchange({
      code: `oc_${'A'.repeat(43)}`,
      clientId: 'mcp-client-001',
      redirectUri: 'https://client.example.com/oauth/callback',
      resource: 'https://erp.example.com/mcp',
      codeVerifier: 'B'.repeat(43),
      traceId: 'trace-token-001',
    })).resolves.toEqual({
      accessToken: 'signed-oauth-access-token', tokenType: 'Bearer', expiresIn: 600,
      scope: 'erp:mcp:server:connect erp:org:chart:read',
    });
    expect(store.sign).toHaveBeenCalledWith({
      tenantId: 'tenant-001', actorId: 'actor-001', sessionId: 'session-001',
      clientId: 'mcp-client-001', roleCodes: ['employee'],
      scopes: ['erp:mcp:server:connect', 'erp:org:chart:read'], departmentIds: ['department-001'],
    });
    expect(store.recordTrustedUser).toHaveBeenCalledWith('tenant-001', expect.objectContaining({
      actorId: 'actor-001', traceId: 'trace-token-001', outcome: 'success',
      resourceId: 'mcp-client-001',
    }));
  });

  it.each(['inactive session', 'disabled profile', 'scope revoked'])(
    '%s 时失败关闭且不签发令牌',
    async (scenario) => {
      const store = fixture();
      if (scenario === 'inactive session') store.isActive.mockResolvedValue(false);
      if (scenario === 'disabled profile') store.resolveActive.mockResolvedValue(null);
      if (scenario === 'scope revoked') {
        store.resolveActive.mockResolvedValue({
          tenantId: 'tenant-001', actorId: 'actor-001', employeeId: 'employee-001',
          status: 'active', roleCodes: ['employee'], scopes: ['erp:mcp:server:connect'],
          departmentIds: ['department-001'], version: 2,
        });
      }

      await expect(store.service.exchange({
        code: `oc_${'A'.repeat(43)}`,
        clientId: 'mcp-client-001',
        redirectUri: 'https://client.example.com/oauth/callback',
        resource: 'https://erp.example.com/mcp',
        codeVerifier: 'B'.repeat(43),
        traceId: 'trace-token-002',
      })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(store.sign).not.toHaveBeenCalled();
      expect(store.recordTrustedUser).toHaveBeenCalledWith('tenant-001', expect.objectContaining({
        traceId: 'trace-token-002', outcome: 'failure',
      }));
    },
  );
});
