import { Module } from '@nestjs/common';

import { OrgModule } from '../org/org.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { McpController } from './mcp.controller.js';
import { McpRuntimeService } from './mcp-runtime.service.js';
import { OauthMetadataController } from './oauth-metadata.controller.js';
import { McpOriginGuard } from './mcp-origin.guard.js';
import { McpToolService } from './mcp-tool.service.js';

@Module({
  imports: [ApprovalModule, OrgModule],
  controllers: [McpController, OauthMetadataController],
  providers: [McpRuntimeService, McpOriginGuard, McpToolService],
  exports: [McpOriginGuard, McpRuntimeService],
})
export class McpModule {}
