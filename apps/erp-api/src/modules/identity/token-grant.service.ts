import { randomUUID } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

import type { AppEnvironment } from '../../config/environment.js';
import { AccessProfileRepository, type AccessProfileSnapshot } from './access-profile.repository.js';
import { AccessTokenSigner, type SignedAccessToken } from './access-token-signer.js';
import { RefreshTokenService, type RotatedRefreshToken } from './refresh-token.service.js';
import { SessionService } from './session.service.js';
import { SsoAuthenticationService } from './sso-authentication.service.js';
import type { SsoProviderCode } from './auth.types.js';

export interface BrowserTokenGrant extends SignedAccessToken {
  readonly refreshToken: string;
  readonly scope: string;
  readonly returnPath: string;
}

interface RefreshGrantContext extends RotatedRefreshToken {
  readonly profile: AccessProfileSnapshot;
  readonly signed: SignedAccessToken;
}

interface ResolvedBrowserSession extends RotatedRefreshToken {
  readonly profile: AccessProfileSnapshot;
}

export interface BrowserOAuthIdentity {
  readonly refreshToken: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly roleCodes: readonly string[];
  readonly scopes: readonly string[];
  readonly departmentIds: readonly string[];
}

@Injectable()
export class TokenGrantService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly sso: SsoAuthenticationService,
    private readonly profiles: AccessProfileRepository,
    private readonly sessions: SessionService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly signer: AccessTokenSigner,
  ) {}

  /** 完成 SSO 回调后，以单个 Mongo 事务创建会话与首个刷新令牌。 */
  async issueFromSso(input: {
    readonly provider: SsoProviderCode;
    readonly state: string;
    readonly code: string;
  }): Promise<BrowserTokenGrant> {
    const identity = await this.sso.verifyAuthorizationCode(input);
    const profile = await this.profiles.resolveActive(identity.tenantId, identity.actorId);
    if (profile === null || profile.employeeId !== identity.employeeId) {
      throw this.invalidGrant();
    }
    const sessionId = randomUUID();
    const expiresAt = new Date(
      Date.now() + this.config.get('AUTH_REFRESH_TOKEN_TTL_SECONDS', { infer: true }) * 1000,
    );
    const signed = await this.signer.sign({
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      sessionId,
      clientId: 'gaoq-web',
      roleCodes: profile.roleCodes,
      scopes: profile.scopes,
      departmentIds: profile.departmentIds,
    });
    const refreshToken = await this.connection.transaction(async (mongoSession) => {
      await this.sessions.open(
        { tenantId: identity.tenantId, actorId: identity.actorId, sessionId, expiresAt },
        mongoSession,
      );
      return this.refreshTokens.issueInitial(
        {
          tenantId: identity.tenantId,
          actorId: identity.actorId,
          sessionId,
          clientId: 'gaoq-web',
          expiresAt,
        },
        mongoSession,
      );
    });
    return {
      ...signed,
      refreshToken: refreshToken.refreshToken,
      scope: profile.scopes.join(' '),
      returnPath: identity.returnPath,
    };
  }

  /** 轮换刷新令牌并在同一事务中重新读取授权快照；重放会提交整族吊销。 */
  async refresh(presentedToken: string): Promise<BrowserTokenGrant> {
    const resolved = await this.rotateAndResolveBrowserSession(presentedToken);
    const signed = await this.signer.sign({
      tenantId: resolved.tenantId,
      actorId: resolved.actorId,
      sessionId: resolved.sessionId,
      clientId: resolved.clientId,
      roleCodes: resolved.profile.roleCodes,
      scopes: resolved.profile.scopes,
      departmentIds: resolved.profile.departmentIds,
    });
    const result = { ...resolved, signed } satisfies RefreshGrantContext;
    return {
      ...result.signed,
      refreshToken: result.refreshToken,
      scope: result.profile.scopes.join(' '),
      returnPath: '/',
    };
  }

  /** OAuth 同意页通过轮换浏览器 Refresh Token 取得可信主体，禁止从同意请求读取租户。 */
  async authenticateBrowserForOAuth(presentedToken: string): Promise<BrowserOAuthIdentity> {
    const resolved = await this.rotateAndResolveBrowserSession(presentedToken);
    return Object.freeze({
      refreshToken: resolved.refreshToken,
      tenantId: resolved.tenantId,
      actorId: resolved.actorId,
      sessionId: resolved.sessionId,
      roleCodes: Object.freeze([...resolved.profile.roleCodes]),
      scopes: Object.freeze([...resolved.profile.scopes]),
      departmentIds: Object.freeze([...resolved.profile.departmentIds]),
    });
  }

  private async rotateAndResolveBrowserSession(
    presentedToken: string,
  ): Promise<ResolvedBrowserSession> {
    const result = await this.connection.transaction(async (mongoSession) => {
      const rotation = await this.refreshTokens.rotate(presentedToken, 'gaoq-web', mongoSession);
      if (rotation.status !== 'rotated') {
        return rotation;
      }
      const sessionActive = await this.sessions.isActive(
        rotation.tenantId,
        rotation.sessionId,
        true,
        mongoSession,
      );
      const profile = await this.profiles.resolveActive(
        rotation.tenantId,
        rotation.actorId,
        mongoSession,
      );
      if (!sessionActive || profile === null) {
        await this.refreshTokens.revokeBySession(rotation.tenantId, rotation.sessionId, mongoSession);
        await this.sessions.revoke(rotation.tenantId, rotation.sessionId, mongoSession);
        return { status: 'inactive' as const };
      }
      return { ...rotation, profile } satisfies ResolvedBrowserSession;
    });
    if (result.status !== 'rotated') {
      throw this.invalidGrant();
    }
    return result;
  }

  /** 吊销会话与全部刷新令牌，事务提交后当前 access token 立即因会话校验失效。 */
  async revokeSession(tenantId: string, sessionId: string): Promise<boolean> {
    return this.connection.transaction(async (mongoSession) => {
      await this.refreshTokens.revokeBySession(tenantId, sessionId, mongoSession);
      return this.sessions.revoke(tenantId, sessionId, mongoSession);
    });
  }

  private invalidGrant(): UnauthorizedException {
    return new UnauthorizedException({ code: 'AUTH_INVALID_GRANT', message: '登录凭据无效或已失效' });
  }
}
