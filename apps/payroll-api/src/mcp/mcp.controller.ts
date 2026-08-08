import { All, Controller, ForbiddenException, Req, Res } from '@nestjs/common';
import type { Response } from 'express';

import type { AuthenticatedPayrollRequest } from '../identity/identity.types.js';
import { McpRuntimeService } from './mcp-runtime.service.js';

@Controller()
export class McpController {
  constructor(private readonly runtime: McpRuntimeService) {}

  /** 专业算薪 MCP 2025-11-25 Streamable HTTP 单一端点。 */
  @All('mcp')
  async handle(
    @Req() request: AuthenticatedPayrollRequest,
    @Res() response: Response,
  ): Promise<void> {
    if (!this.runtime.isOriginAllowed(request.header('origin'))) {
      throw new ForbiddenException({ code: 'MCP_ORIGIN_REJECTED', message: 'MCP Origin 不受信任' });
    }
    await this.runtime.handle(request, response);
  }
}
