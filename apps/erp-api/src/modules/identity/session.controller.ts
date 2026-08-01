import { Controller, Logger, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { createTraceId } from '@gaoq/shared-utils';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import { TokenGrantService } from './token-grant.service.js';

@Controller('auth/sessions')
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

  constructor(
    private readonly grants: TokenGrantService,
    private readonly cookies: BrowserRefreshCookieService,
    private readonly audit: AuditService,
  ) {}

  /** 吊销当前人员会话；租户与 sessionId 只取自已经验签的令牌。 */
  @Post('current/revoke')
  async revokeCurrent(
    @Req() request: ErpRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly revoked: boolean }> {
    const token = request.verifiedAccessToken;
    if (token === undefined) {
      throw new UnauthorizedException({ code: 'AUTH_REQUIRED', message: '缺少已验证会话' });
    }
    const revoked = await this.grants.revokeSession(token.tenantId, token.sessionId);
    this.cookies.clear(response);
    try {
      await this.audit.recordTrustedUser(token.tenantId, {
        actorId: token.actorId,
        traceId: request.traceId ?? createTraceId(),
        action: 'identity.session.revoke',
        resourceType: 'identity_session',
        resourceId: token.sessionId,
        riskLevel: 'R1',
        outcome: revoked ? 'success' : 'failure',
      });
    } catch {
      this.logger.error({
        code: 'IDENTITY_SESSION_REVOKE_AUDIT_AFTER_COMMIT_FAILED',
        tenantId: token.tenantId,
      });
    }
    return { revoked };
  }
}
