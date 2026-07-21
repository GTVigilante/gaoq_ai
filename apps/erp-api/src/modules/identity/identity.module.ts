import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AccessTokenVerifier, RemoteJwksAccessTokenVerifier } from './access-token-verifier.js';
import { BearerAuthGuard } from './bearer-auth.guard.js';
import { DingTalkSsoAdapter } from './dingtalk-sso.adapter.js';
import { ExternalIdentityRepository } from './external-identity.repository.js';
import { ExternalIdentity, ExternalIdentitySchema } from './external-identity.schema.js';
import { FeishuSsoAdapter } from './feishu-sso.adapter.js';
import { IdentitySession, IdentitySessionSchema } from './session.schema.js';
import { SessionController } from './session.controller.js';
import { SessionService } from './session.service.js';
import {
  DingTalkSsoAdapterToken,
  FeishuSsoAdapterToken,
  SsoAdapterRegistry,
} from './sso-adapter.js';
import { FetchSsoHttpClient, SsoHttpClient } from './sso-http-client.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IdentitySession.name, schema: IdentitySessionSchema },
      { name: ExternalIdentity.name, schema: ExternalIdentitySchema },
    ]),
  ],
  controllers: [SessionController],
  providers: [
    SessionService,
    ExternalIdentityRepository,
    BearerAuthGuard,
    SsoAdapterRegistry,
    { provide: SsoHttpClient, useClass: FetchSsoHttpClient },
    { provide: DingTalkSsoAdapterToken, useClass: DingTalkSsoAdapter },
    { provide: FeishuSsoAdapterToken, useClass: FeishuSsoAdapter },
    { provide: AccessTokenVerifier, useClass: RemoteJwksAccessTokenVerifier },
  ],
  exports: [
    SessionService,
    ExternalIdentityRepository,
    SsoAdapterRegistry,
    BearerAuthGuard,
    AccessTokenVerifier,
  ],
})
export class IdentityModule {}
