import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../../config/environment.js';
import { PublicRoute, RawResponse } from '../../core/http/public-route.decorator.js';
import { OAuthClientRegistry } from './oauth-client-registry.js';

/** RFC 8414 OAuth 授权服务器元数据，供 MCP 客户端验证 PKCE 与端点能力。 */
@Controller('.well-known')
@PublicRoute()
@RawResponse()
export class OAuthAuthorizationServerMetadataController {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly clients: OAuthClientRegistry,
  ) {}

  @Get('oauth-authorization-server')
  metadata(): Record<string, unknown> {
    const issuer = this.config.get('AUTH_ISSUER', { infer: true });
    return {
      issuer,
      authorization_endpoint: new URL('/api/auth/oauth/authorize', issuer).toString(),
      token_endpoint: new URL('/api/auth/oauth/token', issuer).toString(),
      jwks_uri: new URL('/.well-known/jwks.json', issuer).toString(),
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: this.clients.listSupportedScopes(),
      client_id_metadata_document_supported: false,
      authorization_response_iss_parameter_supported: true,
    };
  }
}
