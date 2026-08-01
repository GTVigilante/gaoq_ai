import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdentityModule } from '../identity.module.js';
import { PasskeyRegistrationController } from './passkey-registration.controller.js';
import {
  WebAuthnCeremonyRecord,
  WebAuthnCeremonyRecordSchema,
  WebAuthnCredentialRecord,
  WebAuthnCredentialRecordSchema,
} from './webauthn.schemas.js';
import { WebAuthnService } from './webauthn.service.js';

/** WebAuthn 强认证独立模块；不依赖审批或 MCP，供高风险确认流程复用。 */
@Module({
  imports: [
    IdentityModule,
    MongooseModule.forFeature([
      { name: WebAuthnCredentialRecord.name, schema: WebAuthnCredentialRecordSchema },
      { name: WebAuthnCeremonyRecord.name, schema: WebAuthnCeremonyRecordSchema },
    ]),
  ],
  controllers: [PasskeyRegistrationController],
  providers: [WebAuthnService],
  exports: [WebAuthnService],
})
export class StrongAuthModule {}
