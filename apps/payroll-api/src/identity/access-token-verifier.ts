import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PayrollIdentityContext } from '@gaoq/platform-contracts';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import type { AppEnvironment } from '../config/environment.js';

const claimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string().min(1).max(256),
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  exp: z.number().int().positive(),
  tenant_id: z.string().min(1).max(128),
  actor_id: z.string().min(1).max(128),
  actor_type: z.enum(['user', 'service', 'mcp_client', 'system_job']),
  client_id: z.string().min(1).max(128),
  azp: z.string().min(1).max(128),
  roles: z.array(z.string().min(1).max(128)).max(100),
  scope: z.union([z.string().min(1), z.array(z.string().min(1).max(128)).min(1).max(100)]),
  department_ids: z.array(z.string().min(1).max(128)).max(500),
  employee_id: z.string().min(1).max(128).nullable(),
  sid: z.string().min(1).max(128),
  resource: z.union([z.string().url(), z.array(z.string().url()).min(1)]),
});

/** 验证 GaoQ 访问令牌的签名、受众、资源和可信租户声明。 */
@Injectable()
export class AccessTokenVerifier {
  private readonly jwks;

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {
    this.jwks = createRemoteJWKSet(
      new URL(this.config.get('AUTH_JWKS_URI', { infer: true })),
      { cooldownDuration: 30_000, timeoutDuration: 3_000 },
    );
  }

  async verify(token: string): Promise<PayrollIdentityContext> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.get('AUTH_ISSUER', { infer: true }),
        audience: this.config.get('AUTH_AUDIENCE', { infer: true }),
        algorithms: ['RS256'],
        typ: 'at+jwt',
        clockTolerance: 5,
      });
      return parsePayrollClaims(
        payload,
        this.config.get('AUTH_RESOURCE', { infer: true }),
      );
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_TOKEN',
        message: 'GaoQ 访问令牌无效',
      });
    }
  }
}

/** 将已验签声明收敛为算薪可信身份并强制 resource/azp/scope 约束。 */
export const parsePayrollClaims = (
  payload: JWTPayload,
  requiredResource: string,
): PayrollIdentityContext => {
  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UnauthorizedException({
      code: 'AUTH_INVALID_CLAIMS',
      message: '访问令牌声明不完整',
    });
  }
  const claims = parsed.data;
  const resources = typeof claims.resource === 'string' ? [claims.resource] : claims.resource;
  if (!resources.includes(requiredResource)) {
    throw new UnauthorizedException({
      code: 'AUTH_WRONG_RESOURCE',
      message: '访问令牌未绑定算薪资源',
    });
  }
  if (claims.azp !== claims.client_id) {
    throw new UnauthorizedException({
      code: 'AUTH_CLIENT_MISMATCH',
      message: '访问令牌客户端不匹配',
    });
  }
  const scopes = typeof claims.scope === 'string'
    ? claims.scope.split(' ').filter(Boolean)
    : claims.scope;
  if (
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    !scopes.every((scope) => /^erp:payroll:[a-z0-9:_-]+$/.test(scope))
  ) {
    throw new UnauthorizedException({
      code: 'AUTH_INVALID_SCOPE',
      message: '算薪权限范围非法',
    });
  }
  return Object.freeze({
    issuer: claims.iss,
    subject: claims.sub,
    audience: typeof claims.aud === 'string' ? [claims.aud] : claims.aud,
    resource: resources,
    tenantId: claims.tenant_id,
    actorId: claims.actor_id,
    actorType: claims.actor_type,
    clientId: claims.client_id,
    roleCodes: Object.freeze([...claims.roles]),
    scopes: Object.freeze([...scopes]),
    departmentIds: Object.freeze([...claims.department_ids]),
    employeeId: claims.employee_id,
    sessionId: claims.sid,
    traceId: '',
    expiresAt: claims.exp,
  });
};
