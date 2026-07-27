import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTraceId } from '@gaoq/shared-utils';
import { IsBoolean } from 'class-validator';
import type { Request, Response } from 'express';
import { decodeJwt } from 'jose';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import type { ErpRequest } from '../../core/http/request-context.js';
import { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import { OAuthClientCredentialsGrantService } from './oauth-client-credentials-grant.service.js';
import { OAuthAuthorizationTransactionService } from './oauth-authorization-transaction.service.js';
import { OAuthClientRegistry } from './oauth-client-registry.js';
import { OAuthProtocolExceptionFilter } from './oauth-protocol-exception.filter.js';
import { OAuthRateLimitService } from './oauth-rate-limit.service.js';
import { OAuthTokenGrantService } from './oauth-token-grant.service.js';
import { TokenGrantService } from './token-grant.service.js';

export class OAuthDecisionRequest {
  @IsBoolean()
  approved!: boolean;
}

const authorizationCodeTokenRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  client_id: z.string().min(1).max(128),
  code: z.string().min(1).max(256),
  redirect_uri: z.string().min(1).max(2_048),
  resource: z.string().min(1).max(2_048),
  code_verifier: z.string().min(43).max(128),
}).strict();

const clientCredentialsTokenRequestSchema = z.object({
  grant_type: z.literal('client_credentials'),
  resource: z.string().min(1).max(2_048),
  scope: z.string().min(1).max(12_900).optional(),
  client_id: z.string().min(1).max(128).optional(),
  client_assertion_type: z.string().min(1).max(128).optional(),
  client_assertion: z.string().min(1).max(8_192).optional(),
}).strict();

const SAFE_STATE_PATTERN = /^[\x21-\x7E]{1,512}$/;

/** OAuth 2.1 人员代理授权端点：预注册客户端 + Authorization Code + PKCE S256。 */
@Controller('auth/oauth')
@PublicRoute()
@RawResponse()
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly transactions: OAuthAuthorizationTransactionService,
    private readonly browserGrants: TokenGrantService,
    private readonly tokenGrants: OAuthTokenGrantService,
    private readonly clientCredentialGrants: OAuthClientCredentialsGrantService,
    private readonly clients: OAuthClientRegistry,
    private readonly rateLimits: OAuthRateLimitService,
    private readonly cookies: BrowserRefreshCookieService,
    private readonly audit: AuditService,
  ) {}

  /** 校验 OAuth 请求后跳转 ERP 同意页；回调 URI 在跳转前必须精确匹配预注册值。 */
  @Get('authorize')
  async authorize(
    @Query('response_type') responseType: string | undefined,
    @Query('client_id') clientId: string | undefined,
    @Query('redirect_uri') redirectUri: string | undefined,
    @Query('scope') scope: string | undefined,
    @Query('state') state: string | undefined,
    @Query('code_challenge') codeChallenge: string | undefined,
    @Query('code_challenge_method') codeChallengeMethod: string | undefined,
    @Query('resource') resource: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const trustedRedirect = this.resolveTrustedRedirect(clientId, redirectUri);
    try {
      await this.rateLimits.assertAllowed('authorize_ip', this.requestAddress(request));
      if (clientId !== undefined) {
        await this.rateLimits.assertAllowed('authorize_client', clientId);
      }
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.respondAuthorizationError(
        response,
        this.authorizationError(error),
        trustedRedirect,
        state,
        error,
      );
      return;
    }
    if (
      responseType !== 'code' || codeChallengeMethod !== 'S256' ||
      clientId === undefined || redirectUri === undefined || scope === undefined ||
      state === undefined || codeChallenge === undefined || resource === undefined
    ) {
      this.respondAuthorizationError(
        response,
        responseType !== undefined && responseType !== 'code'
          ? 'unsupported_response_type'
          : 'invalid_request',
        trustedRedirect,
        state,
      );
      return;
    }
    try {
      const request = await this.transactions.begin({
        clientId,
        redirectUri,
        scopes: scope.split(' ').filter((item) => item.length > 0),
        resource,
        state,
        codeChallenge,
      });
      const consentUrl = new URL('/oauth/consent', this.config.get('WEB_ORIGIN', { infer: true }));
      consentUrl.searchParams.set('request_id', request.requestId);
      response.setHeader('Cache-Control', 'no-store');
      response.redirect(302, consentUrl.toString());
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.respondAuthorizationError(
        response,
        this.authorizationError(error),
        trustedRedirect,
        state,
        error,
      );
    }
  }

  /** 同意页只获取客户端名称、回调来源和 scope，不暴露主体、租户或 PKCE 数据。 */
  @Get('requests/:requestId')
  async describe(
    @Param('requestId') requestId: string,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      response.status(200).json(await this.transactions.describe(requestId));
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      response.status(400).json({ error: 'invalid_request' });
    }
  }

  /** 同意决策必须由 ERP HttpOnly Refresh Cookie 和精确 Web Origin 驱动。 */
  @Post('requests/:requestId/decisions')
  async decide(
    @Param('requestId') requestId: string,
    @Body() body: OAuthDecisionRequest,
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    if (typeof body.approved !== 'boolean') {
      throw new BadRequestException({ code: 'OAUTH_DECISION_INVALID', message: '授权决策非法' });
    }
    this.cookies.assertTrustedOrigin(request);
    const identity = await this.browserGrants.authenticateBrowserForOAuth(
      this.cookies.readRequired(request),
    );
    this.cookies.set(response, identity.refreshToken);
    const traceId = request.traceId ?? createTraceId();
    let decision;
    try {
      decision = await this.transactions.decide(requestId, body.approved, identity);
    } catch (error) {
      await this.recordDecisionAudit({
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        traceId,
        clientId: 'unknown',
        outcome: 'failure',
        approved: body.approved,
      });
      throw error;
    }
    await this.recordDecisionAudit({
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      traceId,
      clientId: decision.clientId,
      outcome: body.approved ? 'success' : 'denied',
      approved: body.approved,
      scopeCount: decision.scopes.length,
    });
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json({ redirect_to: decision.redirectTo });
  }

  /** OAuth token endpoint：人员代理使用授权码，服务代理使用标准客户端认证。 */
  @Post('token')
  @UseFilters(OAuthProtocolExceptionFilter)
  async token(
    @Body() rawBody: unknown,
    @Req() request: ErpRequest,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    try {
      await this.rateLimits.assertAllowed('token_ip', this.requestAddress(request));
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.respondTokenError(response, error);
      return;
    }
    if (!request.is('application/x-www-form-urlencoded')) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    if (typeof rawBody !== 'object' || rawBody === null) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    const grantType = (rawBody as Record<string, unknown>)['grant_type'];
    if (grantType !== 'authorization_code' && grantType !== 'client_credentials') {
      response.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    if (grantType === 'client_credentials') {
      await this.clientCredentialsToken(rawBody, request, response);
      return;
    }
    if (request.header('authorization') !== undefined) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    const parsed = authorizationCodeTokenRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = parsed.data;
    try {
      await this.rateLimits.assertAllowed('token_client', body.client_id);
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.respondTokenError(response, error);
      return;
    }
    try {
      const grant = await this.tokenGrants.exchange({
        code: body.code,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        resource: body.resource,
        codeVerifier: body.code_verifier,
        traceId: request.traceId ?? createTraceId(),
      });
      response.status(200).json({
        access_token: grant.accessToken,
        token_type: grant.tokenType,
        expires_in: grant.expiresIn,
        scope: grant.scope,
      });
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.respondTokenError(response, error);
    }
  }

  private async clientCredentialsToken(
    rawBody: unknown,
    request: ErpRequest,
    response: Response,
  ): Promise<void> {
    const parsed = clientCredentialsTokenRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = parsed.data;
    const authorization = request.header('authorization');
    const basicAttempt = authorization !== undefined;
    if (
      (authorization !== undefined && !authorization.startsWith('Basic ')) ||
      (authorization !== undefined && body.client_assertion !== undefined) ||
      (authorization === undefined && body.client_assertion === undefined)
    ) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    const rateLimitSubject = authorization === undefined
      ? this.assertionClientId(body.client_assertion) ?? 'unknown'
      : this.basicClientId(authorization) ?? 'unknown';
    try {
      await this.rateLimits.assertAllowed('token_client', rateLimitSubject);
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.respondTokenError(response, error, basicAttempt);
      return;
    }
    try {
      const grant = await this.clientCredentialGrants.issue({
        ...(authorization === undefined ? {} : { authorization }),
        ...(body.client_id === undefined ? {} : { clientId: body.client_id }),
        ...(body.client_assertion_type === undefined
          ? {}
          : { clientAssertionType: body.client_assertion_type }),
        ...(body.client_assertion === undefined ? {} : { clientAssertion: body.client_assertion }),
        resource: body.resource,
        ...(body.scope === undefined ? {} : { scopes: body.scope.split(' ') }),
        traceId: request.traceId ?? createTraceId(),
      });
      response.status(200).json({
        access_token: grant.accessToken,
        token_type: grant.tokenType,
        expires_in: grant.expiresIn,
        scope: grant.scope,
      });
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.respondTokenError(response, error, basicAttempt);
    }
  }

  private authorizationError(error: HttpException): string {
    const code = this.stableCode(error);
    if (code === 'OAUTH_RATE_LIMITED' || code.endsWith('_UNAVAILABLE')) {
      return 'temporarily_unavailable';
    }
    if (code.includes('CLIENT')) return 'unauthorized_client';
    if (code.includes('SCOPE')) return 'invalid_scope';
    return 'invalid_request';
  }

  private async recordDecisionAudit(input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly traceId: string;
    readonly clientId: string;
    readonly outcome: 'success' | 'denied' | 'failure';
    readonly approved: boolean;
    readonly scopeCount?: number;
  }): Promise<void> {
    try {
      await this.audit.recordTrustedUser(input.tenantId, {
        actorId: input.actorId,
        traceId: input.traceId,
        action: 'identity.oauth.authorize',
        resourceType: 'oauth_client',
        resourceId: input.clientId,
        riskLevel: 'R1',
        outcome: input.outcome,
        metadata: {
          approved: input.approved,
          ...(input.scopeCount === undefined ? {} : { scopeCount: input.scopeCount }),
        },
      });
    } catch {
      this.logger.error({
        code: input.outcome === 'failure'
          ? 'OAUTH_DECISION_FAILURE_AUDIT_FAILED'
          : 'OAUTH_DECISION_AUDIT_AFTER_COMMIT_FAILED',
        tenantId: input.tenantId,
        clientId: input.clientId,
      });
    }
  }

  private tokenError(error: HttpException): string {
    const code = this.stableCode(error);
    if (code === 'OAUTH_RATE_LIMITED' || code.endsWith('_UNAVAILABLE')) {
      return 'temporarily_unavailable';
    }
    if (code === 'OAUTH_INVALID_CLIENT') return 'invalid_client';
    if (code === 'OAUTH_INVALID_GRANT') return 'invalid_grant';
    if (code.includes('SCOPE')) return 'invalid_scope';
    return 'invalid_request';
  }

  private stableCode(error: HttpException): string {
    const response = error.getResponse();
    if (typeof response !== 'object' || response === null) return '';
    const code = (response as Record<string, unknown>)['code'];
    return typeof code === 'string' ? code : '';
  }

  private resolveTrustedRedirect(
    clientId: string | undefined,
    redirectUri: string | undefined,
  ): string | undefined {
    if (clientId === undefined || redirectUri === undefined) return undefined;
    const client = this.clients.resolveActive(clientId);
    if (client === undefined) return undefined;
    try {
      this.clients.assertRedirect(client, redirectUri);
      return redirectUri;
    } catch {
      return undefined;
    }
  }

  private respondAuthorizationError(
    response: Response,
    oauthError: string,
    trustedRedirect: string | undefined,
    state: string | undefined,
    exception?: HttpException,
  ): void {
    response.setHeader('Cache-Control', 'no-store');
    this.setRetryAfter(response, exception);
    if (trustedRedirect === undefined) {
      response.status(this.protocolErrorStatus(exception)).json({ error: oauthError });
      return;
    }
    const redirect = new URL(trustedRedirect);
    redirect.searchParams.set('error', oauthError);
    if (state !== undefined && SAFE_STATE_PATTERN.test(state)) {
      redirect.searchParams.set('state', state);
    }
    redirect.searchParams.set('iss', this.config.get('AUTH_ISSUER', { infer: true }));
    response.redirect(302, redirect.toString());
  }

  private respondTokenError(
    response: Response,
    exception: HttpException,
    basicAttempt = false,
  ): void {
    this.setRetryAfter(response, exception);
    const oauthError = this.tokenError(exception);
    if (basicAttempt && oauthError === 'invalid_client') {
      response.setHeader('WWW-Authenticate', 'Basic realm="oauth-token"');
      response.status(401).json({ error: oauthError });
      return;
    }
    response.status(this.protocolErrorStatus(exception)).json({ error: oauthError });
  }

  private basicClientId(authorization: string | undefined): string | undefined {
    if (authorization === undefined || authorization.length > 512) return undefined;
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(authorization);
    if (match === null) return undefined;
    try {
      const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      return separator > 0 ? decoded.slice(0, separator) : undefined;
    } catch {
      return undefined;
    }
  }

  private assertionClientId(assertion: string | undefined): string | undefined {
    if (assertion === undefined || assertion.length > 8_192) return undefined;
    try {
      const issuer = decodeJwt(assertion).iss;
      return typeof issuer === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(issuer)
        ? issuer
        : undefined;
    } catch {
      return undefined;
    }
  }

  private setRetryAfter(response: Response, exception: HttpException | undefined): void {
    if (exception === undefined) return;
    const payload = exception.getResponse();
    if (typeof payload !== 'object' || payload === null) return;
    const retryAfter = (payload as Record<string, unknown>)['retryAfter'];
    if (typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0) {
      response.setHeader('Retry-After', String(retryAfter));
    }
  }

  private requestAddress(request: Request): string {
    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  private protocolErrorStatus(exception: HttpException | undefined): number {
    const status = exception?.getStatus();
    return status === 429 || status === 503 ? status : 400;
  }
}
