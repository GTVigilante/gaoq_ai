import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Response } from 'express';

import { AuditService } from '../../../core/audit/audit.service.js';
import { PublicRoute, RawResponse } from '../../../core/http/public-route.decorator.js';
import type { ErpRequest } from '../../../core/http/request-context.js';
import { BrowserRefreshCookieService } from '../browser-refresh-cookie.service.js';
import { TokenGrantService, type BrowserOAuthIdentity } from '../token-grant.service.js';
import { WebAuthnService } from './webauthn.service.js';

/** 当前 ERP 人员登记 WebAuthn 凭据；全程使用 HttpOnly 会话与精确 Origin。 */
@Controller('auth/passkeys')
@PublicRoute()
@RawResponse()
export class PasskeyRegistrationController {
  private readonly logger = new Logger(PasskeyRegistrationController.name);

  constructor(
    private readonly webauthn: WebAuthnService,
    private readonly grants: TokenGrantService,
    private readonly cookies: BrowserRefreshCookieService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    const identity = await this.authenticate(request, response);
    response.status(200).json({ items: await this.webauthn.listCredentials(identity) });
  }

  @Post('registration/options')
  async options(
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    const identity = await this.authenticate(request, response);
    response.status(200).json(await this.webauthn.startRegistration(identity));
  }

  @Post('registration/verify')
  async verify(
    @Body() body: {
      readonly ceremonyId?: string;
      readonly response?: RegistrationResponseJSON;
    },
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    const identity = await this.authenticate(request, response);
    if (typeof body.ceremonyId !== 'string' || body.response === undefined) {
      throw new BadRequestException({
        code: 'PASSKEY_REGISTRATION_RESPONSE_INVALID', message: 'Passkey 登记响应不完整',
      });
    }
    try {
      const result = await this.webauthn.finishRegistration(
        identity, body.ceremonyId, body.response,
      );
      await this.auditRegistration(identity, 'success');
      response.status(200).json(result);
    } catch (error) {
      await this.auditRegistration(identity, 'failure');
      throw error;
    }
  }

  @Delete(':credentialId')
  async revoke(
    @Param('credentialId') credentialId: string,
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    const identity = await this.authenticate(request, response);
    try {
      await this.webauthn.revokeCredential(identity, credentialId);
      await this.auditCredentialRevocation(identity, credentialId, 'success');
      response.status(204).send();
    } catch (error) {
      await this.auditCredentialRevocation(identity, credentialId, 'failure');
      throw error;
    }
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

  private async auditRegistration(
    identity: BrowserOAuthIdentity,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    try {
      await this.audit.recordTrustedUser(identity.tenantId, {
        action: 'identity.passkey.register',
        resourceType: 'identity_actor',
        resourceId: identity.actorId,
        riskLevel: 'R2',
        outcome,
        actorId: identity.actorId,
        traceId: identity.sessionId,
        metadata: { method: 'webauthn_uv' },
      });
    } catch {
      this.logger.error({
        code: outcome === 'success'
          ? 'PASSKEY_REGISTRATION_AUDIT_AFTER_COMMIT_FAILED'
          : 'PASSKEY_REGISTRATION_FAILURE_AUDIT_FAILED',
        tenantId: identity.tenantId,
      });
    }
  }

  private async auditCredentialRevocation(
    identity: BrowserOAuthIdentity,
    credentialId: string,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    try {
      await this.audit.recordTrustedUser(identity.tenantId, {
        action: 'identity.passkey.revoke',
        resourceType: 'identity_passkey',
        resourceId: credentialId,
        riskLevel: 'R2',
        outcome,
        actorId: identity.actorId,
        traceId: identity.sessionId,
        metadata: { method: 'webauthn_uv' },
      });
    } catch {
      this.logger.error({
        code: outcome === 'success'
          ? 'PASSKEY_REVOCATION_AUDIT_AFTER_COMMIT_FAILED'
          : 'PASSKEY_REVOCATION_FAILURE_AUDIT_FAILED',
        tenantId: identity.tenantId,
      });
    }
  }
}
