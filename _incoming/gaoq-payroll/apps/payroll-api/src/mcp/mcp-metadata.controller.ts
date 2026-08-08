import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Public } from '../common/public.decorator.js';
import type { AppEnvironment } from '../config/environment.js';

@Controller('.well-known/oauth-protected-resource/api/payroll/v1')
export class McpMetadataController {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  /** RFC 9728 OAuth 受保护资源元数据。 */
  @Public()
  @Get()
  metadata() {
    return Object.freeze({
      resource: this.config.get('AUTH_RESOURCE', { infer: true }),
      authorization_servers: [this.config.get('AUTH_ISSUER', { infer: true })],
      bearer_methods_supported: ['header'],
      scopes_supported: [
        'erp:payroll:mcp:connect',
        'erp:payroll:payslip:self',
        'erp:payroll:period:read',
        'erp:payroll:reconciliation:read',
        'erp:payroll:tax:read',
      ],
    });
  }
}
