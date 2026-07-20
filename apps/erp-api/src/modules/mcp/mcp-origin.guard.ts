import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import type { ErpRequest } from '../../core/http/request-context.js';
import { McpRuntimeService } from './mcp-runtime.service.js';

@Injectable()
export class McpOriginGuard implements CanActivate {
  constructor(private readonly runtime: McpRuntimeService) {}

  /** 在身份验证前拒绝不可信 MCP Origin，防止 DNS rebinding。 */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ErpRequest>();
    if (request.path !== '/mcp') {
      return true;
    }
    if (!this.runtime.isOriginAllowed(request.header('origin'))) {
      throw new ForbiddenException({ code: 'MCP_ORIGIN_REJECTED', message: 'MCP Origin 不受信任' });
    }
    return true;
  }
}
