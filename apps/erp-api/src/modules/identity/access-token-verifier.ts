import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import type { VerifiedAccessToken } from './auth.types.js';
import { SessionService } from './session.service.js';

const actorTypeSchema = z.enum(['user', 'service', 'mcp_client', 'system_job']);
const claimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  exp: z.number().int().positive(),
  tenant_id: z.string().min(1).max(128),
  actor_id: z.string().min(1).max(128),
  actor_type: actorTypeSchema,
  client_id: z.string().min(1).max(128),
  azp: z.string().min(1).max(128),
  roles: z.array(z.string().min(1).max(128)).max(100),
  scope: z.union([z.string(), z.array(z.string())]),
  department_ids: z.array(z.string().min(1).max(128)).max(500),
  sid: z.string().min(1).max(128),
  resource: z.union([z.string().url(), z.array(z.string().url()).min(1)]),
});

/** 访问令牌验证端口，HTTP 与 MCP 必须复用。 */
export abstract class AccessTokenVerifier {
  abstract verify(token: string): Promise<VerifiedAccessToken>;
}

@Injectable()
export class RemoteJwksAccessTokenVerifier extends AccessTokenVerifier {
  private readonly jwks;

  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly sessions: SessionService,
  ) {
    super();
    this.jwks = createRemoteJWKSet(new URL(this.config.get('AUTH_JWKS_URI', { infer: true })), {
      cooldownDuration: 30_000,
      timeoutDuration: 3_000,
    });
  }

  /** 验证签名、issuer、audience、resource、会话状态与业务声明。 */
  override async verify(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.get('AUTH_ISSUER', { infer: true }),
        audience: this.config.get('AUTH_AUDIENCE', { infer: true }),
        algorithms: ['RS256'],
        typ: 'at+jwt',
        clockTolerance: 5,
      });
      const verified = parseAndValidateClaims(
        payload,
        this.config.get('AUTH_RESOURCE', { infer: true }),
      );
      const requireExistingSession = verified.actorType === 'user';
      if (
        !(await this.sessions.isActive(
          verified.tenantId,
          verified.sessionId,
          requireExistingSession,
        ))
      ) {
        throw new UnauthorizedException({ code: 'AUTH_SESSION_INACTIVE', message: '会话不存在或已失效' });
      }
      return verified;
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException({ code: 'AUTH_INVALID_TOKEN', message: '访问令牌无效' });
    }
  }
}

/** 将已验签 JWT 声明收敛为 ERP 可信身份，并强制资源绑定。 */
export const parseAndValidateClaims = (
  payload: JWTPayload,
  requiredResource: string,
): VerifiedAccessToken => {
  const result = claimsSchema.safeParse(payload);
  if (!result.success) {
    throw new UnauthorizedException({ code: 'AUTH_INVALID_CLAIMS', message: '令牌声明不完整' });
  }
  const claims = result.data;
  const resources = typeof claims.resource === 'string' ? [claims.resource] : claims.resource;
  if (!resources.includes(requiredResource)) {
    throw new UnauthorizedException({ code: 'AUTH_WRONG_RESOURCE', message: '令牌资源不匹配' });
  }
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : claims.scope;
  if (claims.azp !== claims.client_id) {
    throw new UnauthorizedException({ code: 'AUTH_CLIENT_MISMATCH', message: '令牌客户端不匹配' });
  }

  return {
    issuer: claims.iss,
    subject: claims.sub,
    audience: typeof claims.aud === 'string' ? [claims.aud] : claims.aud,
    resource: resources,
    tenantId: claims.tenant_id,
    actorId: claims.actor_id,
    actorType: claims.actor_type,
    clientId: claims.client_id,
    roleCodes: claims.roles,
    scopes,
    departmentIds: claims.department_ids,
    sessionId: claims.sid,
    expiresAt: claims.exp,
  };
};
