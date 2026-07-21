import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AccessTokenVerifier, RemoteJwksAccessTokenVerifier } from './access-token-verifier.js';
import { AccessProfile, AccessProfileSchema } from './access-profile.schema.js';
import { AccessProfileRepository } from './access-profile.repository.js';
import {
  AccessTokenSigner,
  SecretManagedRsaAccessTokenSigner,
} from './access-token-signer.js';
import { BearerAuthGuard } from './bearer-auth.guard.js';
import { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import { BrowserSsoStateCookieService } from './browser-sso-state-cookie.service.js';
import { OAuthClientCredentialsGrantService } from './oauth-client-credentials-grant.service.js';
import { DingTalkSsoAdapter } from './dingtalk-sso.adapter.js';
import { ExternalIdentityRepository } from './external-identity.repository.js';
import { ExternalIdentity, ExternalIdentitySchema } from './external-identity.schema.js';
import { FeishuSsoAdapter } from './feishu-sso.adapter.js';
import { OpSsoAdapter } from './op-sso.adapter.js';
import { IdentitySession, IdentitySessionSchema } from './session.schema.js';
import { IdentityLifecycleService } from './identity-lifecycle.service.js';
import { JwksController } from './jwks.controller.js';
import { OAuthAuthorizationServerMetadataController } from './oauth-authorization-server-metadata.controller.js';
import { OAuthAuthorizationTransactionService } from './oauth-authorization-transaction.service.js';
import { OAuthClientRegistry } from './oauth-client-registry.js';
import { OAuthController } from './oauth.controller.js';
import { OAuthRateLimitService } from './oauth-rate-limit.service.js';
import { OAuthServiceClientRegistry } from './oauth-service-client-registry.js';
import { OAuthTokenGrantService } from './oauth-token-grant.service.js';
import {
  IdentityRefreshToken,
  IdentityRefreshTokenSchema,
} from './refresh-token.schema.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { SessionController } from './session.controller.js';
import { SessionService } from './session.service.js';
import {
  DingTalkSsoAdapterToken,
  FeishuSsoAdapterToken,
  OpSsoAdapterToken,
  SsoAdapterRegistry,
} from './sso-adapter.js';
import { FetchSsoHttpClient, SsoHttpClient } from './sso-http-client.js';
import { SsoAuthenticationService } from './sso-authentication.service.js';
import { SsoStateService } from './sso-state.service.js';
import { SsoTenantBindingRepository } from './sso-tenant-binding.repository.js';
import {
  SsoTenantBinding,
  SsoTenantBindingSchema,
} from './sso-tenant-binding.schema.js';
import { SsoController } from './sso.controller.js';
import { TokenController } from './token.controller.js';
import { TokenGrantService } from './token-grant.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IdentitySession.name, schema: IdentitySessionSchema },
      { name: ExternalIdentity.name, schema: ExternalIdentitySchema },
      { name: SsoTenantBinding.name, schema: SsoTenantBindingSchema },
      { name: AccessProfile.name, schema: AccessProfileSchema },
      { name: IdentityRefreshToken.name, schema: IdentityRefreshTokenSchema },
    ]),
  ],
  controllers: [
    SessionController,
    SsoController,
    TokenController,
    JwksController,
    OAuthController,
    OAuthAuthorizationServerMetadataController,
  ],
  providers: [
    SessionService,
    IdentityLifecycleService,
    RefreshTokenService,
    TokenGrantService,
    OAuthClientRegistry,
    OAuthAuthorizationTransactionService,
    OAuthTokenGrantService,
    OAuthClientCredentialsGrantService,
    OAuthRateLimitService,
    OAuthServiceClientRegistry,
    BrowserRefreshCookieService,
    BrowserSsoStateCookieService,
    AccessProfileRepository,
    ExternalIdentityRepository,
    SsoTenantBindingRepository,
    SsoStateService,
    SsoAuthenticationService,
    BearerAuthGuard,
    SsoAdapterRegistry,
    { provide: SsoHttpClient, useClass: FetchSsoHttpClient },
    { provide: DingTalkSsoAdapterToken, useClass: DingTalkSsoAdapter },
    { provide: FeishuSsoAdapterToken, useClass: FeishuSsoAdapter },
    { provide: OpSsoAdapterToken, useClass: OpSsoAdapter },
    { provide: AccessTokenSigner, useClass: SecretManagedRsaAccessTokenSigner },
    { provide: AccessTokenVerifier, useClass: RemoteJwksAccessTokenVerifier },
  ],
  exports: [
    SessionService,
    IdentityLifecycleService,
    ExternalIdentityRepository,
    SsoAuthenticationService,
    SsoAdapterRegistry,
    BearerAuthGuard,
    AccessTokenVerifier,
    AccessProfileRepository,
    TokenGrantService,
    BrowserRefreshCookieService,
  ],
})
export class IdentityModule {}
