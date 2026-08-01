import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AccessProfileRepository } from './access-profile.repository.js';
import { AccessProfile, AccessProfileSchema } from './access-profile.schema.js';
import { ExternalIdentityRepository } from './external-identity.repository.js';
import { ExternalIdentity, ExternalIdentitySchema } from './external-identity.schema.js';
import { IdentityLifecycleService } from './identity-lifecycle.service.js';
import {
  IdentityRefreshToken,
  IdentityRefreshTokenSchema,
} from './refresh-token.schema.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { IdentitySession, IdentitySessionSchema } from './session.schema.js';
import { SessionService } from './session.service.js';

/** 业务与 Worker 可复用的身份持久化边界；不装配 OAuth、SSO、HTTP 或远程 JWKS。 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IdentitySession.name, schema: IdentitySessionSchema },
      { name: ExternalIdentity.name, schema: ExternalIdentitySchema },
      { name: AccessProfile.name, schema: AccessProfileSchema },
      { name: IdentityRefreshToken.name, schema: IdentityRefreshTokenSchema },
    ]),
  ],
  providers: [
    SessionService,
    RefreshTokenService,
    IdentityLifecycleService,
    AccessProfileRepository,
    ExternalIdentityRepository,
  ],
  exports: [
    SessionService,
    RefreshTokenService,
    IdentityLifecycleService,
    AccessProfileRepository,
    ExternalIdentityRepository,
  ],
})
export class IdentityPersistenceModule {}
