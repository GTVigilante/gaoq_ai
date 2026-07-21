import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OrgModule } from '../org/org.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { StrongAuthModule } from '../identity/strong-auth/strong-auth.module.js';
import { McpConfirmationController } from './mcp-confirmation.controller.js';
import {
  McpConfirmationRecord,
  McpConfirmationRecordSchema,
} from './mcp-confirmation.schema.js';
import { McpConfirmationService } from './mcp-confirmation.service.js';
import { McpController } from './mcp.controller.js';
import { McpRuntimeService } from './mcp-runtime.service.js';
import { OauthMetadataController } from './oauth-metadata.controller.js';
import { McpOriginGuard } from './mcp-origin.guard.js';
import { McpToolService } from './mcp-tool.service.js';

@Module({
  imports: [
    ApprovalModule,
    IdentityModule,
    StrongAuthModule,
    OrgModule,
    MongooseModule.forFeature([
      { name: McpConfirmationRecord.name, schema: McpConfirmationRecordSchema },
    ]),
  ],
  controllers: [McpController, McpConfirmationController, OauthMetadataController],
  providers: [McpConfirmationService, McpRuntimeService, McpOriginGuard, McpToolService],
  exports: [McpOriginGuard, McpRuntimeService],
})
export class McpModule {}
