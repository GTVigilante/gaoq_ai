import { Controller, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import { TokenGrantService } from './token-grant.service.js';

@Controller('auth/sessions')
export class SessionController {
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
    await this.audit.record({
      action: 'identity.session.revoke',
      resourceType: 'identity_session',
      resourceId: token.sessionId,
      riskLevel: 'R1',
      outcome: revoked ? 'success' : 'failure',
    });
    return { revoked };
  }
}
