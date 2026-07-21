import { UnauthorizedException } from '@nestjs/common';
import type { JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';

import { parseAndValidateClaims } from './access-token-verifier.js';

const validPayload = (): JWTPayload => ({
  iss: 'https://auth.example.internal',
  sub: 'user-001',
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
});

describe('parseAndValidateClaims', () => {
  it('解析受资源约束的完整声明', () => {
    const token = parseAndValidateClaims(validPayload(), 'https://erp.example.com/mcp');
    expect(token).toMatchObject({
      tenantId: 'tenant-001',
      actorId: 'employee-001',
      scopes: ['erp:mcp:server:connect', 'erp:identity:profile:read'],
    });
  });

  it('拒绝错误 resource 的令牌', () => {
    expect(() =>
      parseAndValidateClaims(validPayload(), 'https://another.example.com/mcp'),
    ).toThrow(UnauthorizedException);
  });

  it('拒绝缺失 tenant、subject 或 session 的声明', () => {
    const payload = validPayload();
    delete payload['tenant_id'];
    expect(() => parseAndValidateClaims(payload, 'https://erp.example.com/mcp')).toThrow(
      UnauthorizedException,
    );
  });

  it('拒绝 azp 与 client_id 不一致的客户端混淆令牌', () => {
    expect(() =>
      parseAndValidateClaims(
        { ...validPayload(), azp: 'attacker-client' },
        'https://erp.example.com/mcp',
      ),
    ).toThrow(UnauthorizedException);
  });

  it.each([
    'org:read',
    'erp:mcp:server:connect erp:mcp:server:connect',
    [],
  ])('拒绝格式非法、重复或空 scope：%j', (scope) => {
    expect(() =>
      parseAndValidateClaims(
        { ...validPayload(), scope },
        'https://erp.example.com/mcp',
      ),
    ).toThrow(UnauthorizedException);
  });
});
