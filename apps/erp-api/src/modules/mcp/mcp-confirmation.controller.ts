import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Response } from 'express';

import { AuditService } from '../../core/audit/audit.service.js';
import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { MetricsService } from '../../core/observability/metrics.service.js';
import { BrowserRefreshCookieService } from '../identity/browser-refresh-cookie.service.js';
import { TokenGrantService } from '../identity/token-grant.service.js';
import type { BrowserOAuthIdentity } from '../identity/token-grant.service.js';
import { WebAuthnService } from '../identity/strong-auth/webauthn.service.js';
import { McpConfirmationService } from './mcp-confirmation.service.js';

/** ERP 浏览器确认端点；只接受 HttpOnly 会话 Cookie 与精确 Web Origin。 */
@Controller('mcp/confirmations')
@PublicRoute()
@RawResponse()
export class McpConfirmationController {
  private readonly logger = new Logger(McpConfirmationController.name);

  constructor(
    private readonly confirmations: McpConfirmationService,
    private readonly grants: TokenGrantService,
    private readonly cookies: BrowserRefreshCookieService,
    private readonly audit: AuditService,
    private readonly webauthn: WebAuthnService,
    private readonly metrics: MetricsService,
  ) {}

  @Get(':operationId')
  async describe(
    @Param('operationId') operationId: string,
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const identity = await this.authenticate(request, response);
    response.status(200).json(await this.confirmations.describe(operationId, identity));
  }

  @Post(':operationId/confirm')
  async confirm(
    @Param('operationId') operationId: string,
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const identity = await this.authenticate(request, response);
    const view = await this.confirmations.describe(operationId, identity);
    let result;
    try {
      result = await this.confirmations.confirm(operationId, identity);
    } catch (error) {
      await this.auditConfirmationSafe(
        identity, operationId, view.riskLevel, 'failure',
      );
      throw error;
    }
    await this.auditConfirmationSafe(
      identity, operationId, view.riskLevel, 'success',
    );
    response.status(200).json(result);
  }

  @Post(':operationId/webauthn/options')
  async strongAuthOptions(
    @Param('operationId') operationId: string,
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    const identity = await this.authenticate(request, response);
    const view = await this.confirmations.describe(operationId, identity);
    if (view.riskLevel !== 'R2' || view.status !== 'pending_confirmation') {
      this.metrics.recordMcpConfirmation('confirm', 'R2', 'denied');
      await this.auditStrongAuthSafe(identity, operationId, 'failure');
      throw new ConflictException({
        code: 'MCP_R2_CONFIRMATION_STATE_INVALID', message: '当前操作不需要或不能进行强认证',
      });
    }
    try {
      response.status(200).json(await this.webauthn.startAuthentication(identity, operationId));
    } catch (error) {
      this.metrics.recordMcpConfirmation('confirm', 'R2', 'denied');
      await this.auditStrongAuthSafe(identity, operationId, 'failure');
      throw error;
    }
  }

  @Post(':operationId/webauthn/verify')
  async strongAuthVerify(
    @Param('operationId') operationId: string,
    @Body() body: {
      readonly ceremonyId?: string;
      readonly response?: AuthenticationResponseJSON;
    },
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    const identity = await this.authenticate(request, response);
    const view = await this.confirmations.describe(operationId, identity);
    if (
      view.riskLevel !== 'R2' || view.status !== 'pending_confirmation' ||
      typeof body.ceremonyId !== 'string' || body.response === undefined
    ) {
      this.metrics.recordMcpConfirmation('confirm', 'R2', 'denied');
      await this.auditStrongAuthSafe(identity, operationId, 'failure');
      throw new BadRequestException({
        code: 'MCP_R2_ASSERTION_INVALID', message: 'R2 强认证响应不完整或状态无效',
      });
    }
    let result;
    let evidence;
    try {
      evidence = await this.webauthn.finishAuthentication(
        identity,
        operationId,
        body.ceremonyId,
        body.response,
      );
      result = await this.confirmations.confirmR2(operationId, identity, evidence);
    } catch (error) {
      this.metrics.recordMcpConfirmation('confirm', 'R2', 'denied');
      await this.auditStrongAuthSafe(identity, operationId, 'failure');
      throw error;
    }
    await this.auditStrongAuthSafe(
      identity, operationId, 'success', evidence.evidenceId,
    );
    response.status(200).json(result);
  }

  private async authenticate(
    request: ErpRequest,
    response: Response,
  ): Promise<BrowserOAuthIdentity> {
    response.setHeader('Cache-Control', 'no-store');
    this.cookies.assertTrustedOrigin(request);
    const identity = await this.grants.authenticateBrowserForOAuth(
      this.cookies.readRequired(request),
    );
    this.cookies.set(response, identity.refreshToken);
    return identity;
  }

  private async auditConfirmationSafe(
    identity: BrowserOAuthIdentity,
    operationId: string,
    riskLevel: 'R1' | 'R2',
    outcome: 'success' | 'failure',
  ): Promise<void> {
    try {
      await this.audit.recordTrustedUser(identity.tenantId, {
        action: 'mcp.confirmation.confirm',
        resourceType: 'mcp_confirmation',
        resourceId: operationId,
        riskLevel,
        outcome,
        actorId: identity.actorId,
        traceId: identity.sessionId,
      });
    } catch {
      this.logger.error({
        code: outcome === 'success'
          ? 'MCP_CONFIRMATION_AUDIT_AFTER_DECISION_FAILED'
          : 'MCP_CONFIRMATION_FAILURE_AUDIT_FAILED',
        tenantId: identity.tenantId,
      });
    }
  }

  private async auditStrongAuthSafe(
    identity: BrowserOAuthIdentity,
    operationId: string,
    outcome: 'success' | 'failure',
    evidenceId?: string,
  ): Promise<void> {
    try {
      await this.audit.recordTrustedUser(identity.tenantId, {
        action: 'mcp.confirmation.strong_auth',
        resourceType: 'mcp_confirmation',
        resourceId: operationId,
        riskLevel: 'R2',
        outcome,
        actorId: identity.actorId,
        traceId: identity.sessionId,
        metadata: {
          method: 'webauthn_uv',
          ...(evidenceId === undefined ? {} : { evidenceId }),
        },
      });
    } catch {
      this.logger.error({
        code: outcome === 'success'
          ? 'MCP_STRONG_AUTH_AUDIT_AFTER_DECISION_FAILED'
          : 'MCP_STRONG_AUTH_FAILURE_AUDIT_FAILED',
        tenantId: identity.tenantId,
      });
    }
  }
}
