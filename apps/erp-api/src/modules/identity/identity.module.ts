import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AccessTokenVerifier, RemoteJwksAccessTokenVerifier } from './access-token-verifier.js';
import { BearerAuthGuard } from './bearer-auth.guard.js';
import { IdentitySession, IdentitySessionSchema } from './session.schema.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: IdentitySession.name, schema: IdentitySessionSchema }]),
  ],
  providers: [
    SessionService,
    BearerAuthGuard,
    { provide: AccessTokenVerifier, useClass: RemoteJwksAccessTokenVerifier },
  ],
  exports: [SessionService, BearerAuthGuard, AccessTokenVerifier],
})
export class IdentityModule {}
