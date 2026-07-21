import type { ConfigService } from '@nestjs/config';
import { OAuthMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { OAuthAuthorizationServerMetadataController } from './oauth-authorization-server-metadata.controller.js';
import type { OAuthClientRegistry } from './oauth-client-registry.js';

describe('OAuthAuthorizationServerMetadataController', () => {
  it('发布 RFC 8414 端点、PKCE S256 和实际支持的授权模式', () => {
    const controller = new OAuthAuthorizationServerMetadataController(
      { get: () => 'https://erp.example.com' } as unknown as ConfigService<AppEnvironment, true>,
      { listSupportedScopes: () => ['erp:mcp:server:connect', 'erp:org:chart:read'] } as unknown as OAuthClientRegistry,
    );

    const metadata = controller.metadata();
    expect(() => OAuthMetadataSchema.parse(metadata)).not.toThrow();
    expect(metadata).toEqual({
      issuer: 'https://erp.example.com',
      authorization_endpoint: 'https://erp.example.com/api/auth/oauth/authorize',
      token_endpoint: 'https://erp.example.com/api/auth/oauth/token',
      jwks_uri: 'https://erp.example.com/.well-known/jwks.json',
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['erp:mcp:server:connect', 'erp:org:chart:read'],
      client_id_metadata_document_supported: false,
      authorization_response_iss_parameter_supported: true,
    });
  });
});
