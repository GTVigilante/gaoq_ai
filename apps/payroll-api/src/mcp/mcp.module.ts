import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';
import { PayrollModule } from '../payroll/payroll.module.js';
import { McpController } from './mcp.controller.js';
import { McpMetadataController } from './mcp-metadata.controller.js';
import { McpRuntimeService } from './mcp-runtime.service.js';

@Module({
  imports: [IdentityModule, PayrollModule],
  controllers: [McpController, McpMetadataController],
  providers: [McpRuntimeService],
})
export class McpModule {}
