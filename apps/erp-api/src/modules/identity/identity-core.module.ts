import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AccessTokenVerifier, RemoteJwksAccessTokenVerifier } from './access-token-verifier.js';
import {
  AccessTokenSigner,
  SecretManagedRsaAccessTokenSigner,
} from './access-token-signer.js';
import { BearerAuthGuard } from './bearer-auth.guard.js';
import { BrowserRefreshCookieService } from './browser-refresh-cookie.service.js';
import { BrowserSsoStateCookieService } from './browser-sso-state-cookie.service.js';
import { OAuthClientCredentialsGrantService } from './oauth-client-credentials-grant.service.js';
import { DingTalkSsoAdapter } from './dingtalk-sso.adapter.js';
import { FeishuSsoAdapter } from './feishu-sso.adapter.js';
import { OpSsoAdapter } from './op-sso.adapter.js';
import { IdentityPersistenceModule } from './identity-persistence.module.js';
import { OAuthAuthorizationTransactionService } from './oauth-authorization-transaction.service.js';
import { OAuthClientRegistry } from './oauth-client-registry.js';
import { OAuthRateLimitService } from './oauth-rate-limit.service.js';
import { OAuthServiceClientRegistry } from './oauth-service-client-registry.js';
import { OAuthTokenGrantService } from './oauth-token-grant.service.js';
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
import { TokenGrantService } from './token-grant.service.js';

@Module({
  imports: [
    IdentityPersistenceModule,
    MongooseModule.forFeature([
      { name: SsoTenantBinding.name, schema: SsoTenantBindingSchema },
    ]),
  ],
  providers: [
    TokenGrantService,
    OAuthClientRegistry,
    OAuthAuthorizationTransactionService,
    OAuthTokenGrantService,
    OAuthClientCredentialsGrantService,
    OAuthRateLimitService,
    OAuthServiceClientRegistry,
    BrowserRefreshCookieService,
    BrowserSsoStateCookieService,
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
    IdentityPersistenceModule,
    SsoAuthenticationService,
    SsoAdapterRegistry,
    BearerAuthGuard,
    AccessTokenVerifier,
    TokenGrantService,
    BrowserRefreshCookieService,
    BrowserSsoStateCookieService,
    AccessTokenSigner,
    OAuthAuthorizationTransactionService,
    OAuthClientCredentialsGrantService,
    OAuthClientRegistry,
    OAuthRateLimitService,
    OAuthServiceClientRegistry,
    OAuthTokenGrantService,
    SsoTenantBindingRepository,
    SsoStateService,
  ],
})
export class IdentityCoreModule {}
