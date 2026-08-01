import { Module } from '@nestjs/common';

import { IdentityProfileController } from './identity-profile.controller.js';
import { IdentityCoreModule } from './identity-core.module.js';
import { JwksController } from './jwks.controller.js';
import { OAuthAuthorizationServerMetadataController } from './oauth-authorization-server-metadata.controller.js';
import { OAuthController } from './oauth.controller.js';
import { SessionController } from './session.controller.js';
import { SsoController } from './sso.controller.js';
import { TokenController } from './token.controller.js';

/** 身份 HTTP 外壳；后台进程只导入 IdentityCoreModule，禁止装配 OAuth/SSO Controller。 */
@Module({
  imports: [IdentityCoreModule],
  controllers: [
    SessionController,
    SsoController,
    TokenController,
    JwksController,
    OAuthController,
    OAuthAuthorizationServerMetadataController,
    IdentityProfileController,
  ],
  exports: [IdentityCoreModule],
})
export class IdentityModule {}
