import { describe, expect, it } from 'vitest';

import type { VerifiedAccessToken } from '../identity/auth.types.js';
import { buildMcpAuthInfo } from './mcp-auth-context.js';

const verifiedToken: VerifiedAccessToken = {
  issuer: 'https://auth.example.com',
  subject: 'tenant-001:employee-001',
  audience: ['gaoq-erp'],
  resource: ['https://erp.example.com/mcp'],
  tenantId: 'tenant-001',
  actorId: 'employee-001',
  actorType: 'user',
  clientId: 'mcp-client-001',
  roleCodes: ['employee'],
  scopes: ['erp:mcp:server:connect'],
  departmentIds: ['department-001'],
  sessionId: 'session-001',
  expiresAt: 2_000_000_000,
};

describe('MCP 可信身份转换', () => {
  it('从统一验证结果构建 SDK AuthInfo 且复制可变集合', () => {
    const authInfo = buildMcpAuthInfo(
      'verified-access-token',
      verifiedToken,
      'trace-mcp-001',
    );

    expect(authInfo).toMatchObject({
      token: 'verified-access-token',
      clientId: 'mcp-client-001',
      scopes: ['erp:mcp:server:connect'],
      resource: new URL('https://erp.example.com/mcp'),
      extra: {
        tenantId: 'tenant-001',
        actorId: 'employee-001',
        traceId: 'trace-mcp-001',
      },
    });
    expect(authInfo.scopes).not.toBe(verifiedToken.scopes);
  });

  it('已验证结果缺失 MCP resource 时仍失败关闭', () => {
    expect(() => buildMcpAuthInfo(
      'verified-access-token',
      { ...verifiedToken, resource: [] },
      'trace-mcp-001',
    )).toThrow();
  });
});
