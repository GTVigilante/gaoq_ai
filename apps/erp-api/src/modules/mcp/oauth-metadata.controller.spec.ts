import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { OauthMetadataController } from './oauth-metadata.controller.js';

describe('OauthMetadataController', () => {
  it('返回 RFC 9728 必需的资源与授权服务器信息', () => {
    const config = new ConfigService<AppEnvironment, true>({
      AUTH_RESOURCE: 'https://erp.example.com/mcp',
      MCP_AUTHORIZATION_SERVER: 'https://auth.example.com',
    } as AppEnvironment);
    const metadata = new OauthMetadataController(config).metadata();

    expect(metadata).toMatchObject({
      resource: 'https://erp.example.com/mcp',
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: ['header'],
    });
  });
});
