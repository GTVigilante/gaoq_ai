import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../../config/environment.js';
import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';

@Controller('.well-known')
@PublicRoute()
@RawResponse()
export class OauthMetadataController {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  /** RFC 9728 受保护资源元数据，供 MCP 客户端发现授权服务器。 */
  @Get('oauth-protected-resource')
  metadata(): Record<string, unknown> {
    return {
      resource: this.config.get('AUTH_RESOURCE', { infer: true }),
      authorization_servers: [this.config.get('MCP_AUTHORIZATION_SERVER', { infer: true })],
      scopes_supported: ['mcp:connect', 'org:read', 'org:read:all', 'profile:read'],
      bearer_methods_supported: ['header'],
      resource_documentation: 'gaoq://mcp/guide',
    };
  }
}
