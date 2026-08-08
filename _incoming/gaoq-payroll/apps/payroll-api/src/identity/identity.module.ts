import { Module } from '@nestjs/common';

import { AccessTokenVerifier } from './access-token-verifier.js';
import { BearerAuthGuard } from './bearer-auth.guard.js';
import { IdentityContextService } from './identity-context.service.js';

@Module({
  providers: [AccessTokenVerifier, BearerAuthGuard, IdentityContextService],
  exports: [BearerAuthGuard, IdentityContextService],
})
export class IdentityModule {}
