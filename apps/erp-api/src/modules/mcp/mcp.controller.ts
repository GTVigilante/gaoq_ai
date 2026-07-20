import { All, Controller, ForbiddenException, Req, Res } from '@nestjs/common';
import type { Response } from 'express';

import type { ErpRequest } from '../../core/http/request-context.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { McpRuntimeService } from './mcp-runtime.service.js';

@Controller()
export class McpController {
  constructor(private readonly runtime: McpRuntimeService) {}

  /** MCP 2025-11-25 Streamable HTTP 单一端点。 */
  @All('mcp')
  @RequiredScopes('mcp:connect')
  async handle(@Req() request: ErpRequest, @Res() response: Response): Promise<void> {
    if (!this.runtime.isOriginAllowed(request.header('origin'))) {
      throw new ForbiddenException({ code: 'MCP_ORIGIN_REJECTED', message: 'MCP Origin 不受信任' });
    }
    await this.runtime.handle(request, response);
  }
}
