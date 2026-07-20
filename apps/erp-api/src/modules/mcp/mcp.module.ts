import { Module } from '@nestjs/common';

import { McpController } from './mcp.controller.js';
import { McpRuntimeService } from './mcp-runtime.service.js';
import { OauthMetadataController } from './oauth-metadata.controller.js';
import { McpOriginGuard } from './mcp-origin.guard.js';

@Module({
  controllers: [McpController, OauthMetadataController],
  providers: [McpRuntimeService, McpOriginGuard],
  exports: [McpOriginGuard, McpRuntimeService],
})
export class McpModule {}
