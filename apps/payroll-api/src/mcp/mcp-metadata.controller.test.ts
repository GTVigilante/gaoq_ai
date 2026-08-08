import { PATH_METADATA } from '@nestjs/common/constants.js';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../config/environment.js';
import { McpMetadataController } from './mcp-metadata.controller.js';

describe('专业算薪 OAuth 受保护资源元数据', () => {
  it('使用 RFC 9728 对带路径 Resource 规定的根级 well-known 地址', () => {
    expect(Reflect.getMetadata(PATH_METADATA, McpMetadataController))
      .toBe('.well-known/oauth-protected-resource/api/payroll/v1');
  });

  it('逐字发布独立 Resource、授权服务器和 MCP 最小 Scope', () => {
    const values: Record<string, string> = {
      AUTH_RESOURCE: 'https://payroll.gaoq.com/api/payroll/v1',
      AUTH_ISSUER: 'https://aio.gaoq.com',
    };
    const config = {
      get: vi.fn((name: string) => values[name]),
    } as unknown as ConfigService<AppEnvironment, true>;

    expect(new McpMetadataController(config).metadata()).toEqual({
      resource: 'https://payroll.gaoq.com/api/payroll/v1',
      authorization_servers: ['https://aio.gaoq.com'],
      bearer_methods_supported: ['header'],
      scopes_supported: [
        'erp:payroll:mcp:connect',
        'erp:payroll:payslip:self',
        'erp:payroll:period:read',
        'erp:payroll:reconciliation:read',
        'erp:payroll:tax:read',
      ],
    });
  });
});
