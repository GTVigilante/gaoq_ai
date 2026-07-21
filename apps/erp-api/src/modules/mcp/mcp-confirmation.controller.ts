import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { BrowserRefreshCookieService } from '../identity/browser-refresh-cookie.service.js';
import { TokenGrantService } from '../identity/token-grant.service.js';
import { McpConfirmationService } from './mcp-confirmation.service.js';

/** ERP 浏览器确认端点；只接受 HttpOnly 会话 Cookie 与精确 Web Origin。 */
@Controller('mcp/confirmations')
@PublicRoute()
@RawResponse()
export class McpConfirmationController {
  constructor(
    private readonly confirmations: McpConfirmationService,
    private readonly grants: TokenGrantService,
    private readonly cookies: BrowserRefreshCookieService,
    private readonly audit: AuditService,
  ) {}

  @Get(':operationId')
  async describe(
    @Param('operationId') operationId: string,
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    this.cookies.assertTrustedOrigin(request);
    const identity = await this.grants.authenticateBrowserForOAuth(
      this.cookies.readRequired(request),
    );
    this.cookies.set(response, identity.refreshToken);
    response.status(200).json(await this.confirmations.describe(operationId, identity));
  }

  @Post(':operationId/confirm')
  async confirm(
    @Param('operationId') operationId: string,
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    this.cookies.assertTrustedOrigin(request);
    const identity = await this.grants.authenticateBrowserForOAuth(
      this.cookies.readRequired(request),
    );
    this.cookies.set(response, identity.refreshToken);
    const view = await this.confirmations.describe(operationId, identity);
    try {
      const result = await this.confirmations.confirm(operationId, identity);
      await this.audit.record({
        action: 'mcp.confirmation.confirm',
        resourceType: 'mcp_confirmation',
        resourceId: operationId,
        riskLevel: view.riskLevel,
        outcome: 'success',
      });
      response.status(200).json(result);
    } catch (error) {
      await this.audit.record({
        action: 'mcp.confirmation.confirm',
        resourceType: 'mcp_confirmation',
        resourceId: operationId,
        riskLevel: view.riskLevel,
        outcome: 'failure',
      });
      throw error;
    }
  }
}
