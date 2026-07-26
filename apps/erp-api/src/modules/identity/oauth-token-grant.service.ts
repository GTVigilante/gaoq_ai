import { Injectable, UnauthorizedException } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { AccessProfileRepository } from './access-profile.repository.js';
import { AccessTokenSigner } from './access-token-signer.js';
import { OAuthAuthorizationTransactionService } from './oauth-authorization-transaction.service.js';
import { SessionService } from './session.service.js';

export interface OAuthAccessTokenGrant {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly scope: string;
}

/** 授权码交换应用服务：消费一次性码后重新校验会话和权限快照，再签发资源绑定令牌。 */
@Injectable()
export class OAuthTokenGrantService {
  constructor(
    private readonly transactions: OAuthAuthorizationTransactionService,
    private readonly profiles: AccessProfileRepository,
    private readonly sessions: SessionService,
    private readonly signer: AccessTokenSigner,
    private readonly audit: AuditService,
  ) {}

  async exchange(input: {
    readonly code: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly resource: string;
    readonly codeVerifier: string;
    readonly traceId: string;
  }): Promise<OAuthAccessTokenGrant> {
    const authorization = await this.transactions.exchange(input);
    const [profile, sessionActive] = await Promise.all([
      this.profiles.resolveActive(authorization.tenantId, authorization.actorId),
      this.sessions.isActive(
        authorization.tenantId,
        authorization.sessionId,
        true,
      ),
    ]);
    if (
      profile === null ||
      !sessionActive ||
      !authorization.scopes.every((scope) => profile.scopes.includes(scope))
    ) {
      await this.audit.recordTrustedUser(authorization.tenantId, {
        actorId: authorization.actorId,
        traceId: input.traceId,
        action: 'identity.oauth.token.issue',
        resourceType: 'oauth_client',
        resourceId: authorization.clientId,
        riskLevel: 'R1',
        outcome: 'failure',
        metadata: { reason: 'authorization_snapshot_inactive' },
      });
      throw new UnauthorizedException({
        code: 'OAUTH_INVALID_GRANT',
        message: '授权主体或权限已失效',
      });
    }
    let signed;
    try {
      signed = await this.signer.sign({
        tenantId: authorization.tenantId,
        actorId: authorization.actorId,
        actorType: 'user',
        sessionId: authorization.sessionId,
        clientId: authorization.clientId,
        roleCodes: profile.roleCodes,
        scopes: authorization.scopes,
        departmentIds: profile.departmentIds,
        employeeId: profile.employeeId,
        resource: authorization.resource,
      });
    } catch (error) {
      await this.audit.recordTrustedUser(authorization.tenantId, {
        actorId: authorization.actorId,
        traceId: input.traceId,
        action: 'identity.oauth.token.issue',
        resourceType: 'oauth_client',
        resourceId: authorization.clientId,
        riskLevel: 'R1',
        outcome: 'failure',
        metadata: { reason: 'signing_failed' },
      });
      throw error;
    }
    await this.audit.recordTrustedUser(authorization.tenantId, {
      actorId: authorization.actorId,
      traceId: input.traceId,
      action: 'identity.oauth.token.issue',
      resourceType: 'oauth_client',
      resourceId: authorization.clientId,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { scopeCount: authorization.scopes.length },
    });
    return {
      ...signed,
      scope: authorization.scopes.join(' '),
    };
  }
}
