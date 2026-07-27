import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import { ERP_AUTHORIZATION_SCOPE_PATTERN } from './authorization-scope.js';
import {
  listAuthorizationResources,
  requireAuthorizationResource,
} from './authorization-resources.js';

const config = (additional: unknown): ConfigService<AppEnvironment, true> => ({
  get: (key: keyof AppEnvironment) => {
    if (key === 'AUTH_RESOURCE') return 'https://erp.example.com/mcp';
    if (key === 'AUTH_AUDIENCE') return 'gaoq-erp-api';
    if (key === 'AUTH_ADDITIONAL_RESOURCES_JSON') return JSON.stringify(additional);
    return undefined;
  },
} as unknown as ConfigService<AppEnvironment, true>);

describe('OAuth 多资源受众注册表', () => {
  it('为专业算薪资源绑定独立 audience', () => {
    const resources = listAuthorizationResources(config([{
      resource: 'https://payroll.example.com/api',
      audience: 'gaoq-payroll-api',
    }]));
    expect(resources).toHaveLength(2);
    expect(requireAuthorizationResource(
      config([{
        resource: 'https://payroll.example.com/api',
        audience: 'gaoq-payroll-api',
      }]),
      'https://payroll.example.com/api',
    )).toEqual({
      resource: 'https://payroll.example.com/api',
      audience: 'gaoq-payroll-api',
    });
  });

  it('拒绝未知或重复资源', () => {
    expect(() => requireAuthorizationResource(config([]), 'https://unknown.example.com/api'))
      .toThrow(BadRequestException);
    expect(() => listAuthorizationResources(config([{
      resource: 'https://erp.example.com/mcp',
      audience: 'duplicate',
    }]))).toThrow('重复');
  });

  it('权限范围只接受固定 ERP 域、资源和动作四段式格式', () => {
    expect(ERP_AUTHORIZATION_SCOPE_PATTERN.test('erp:approval:instance:read')).toBe(true);
    expect(ERP_AUTHORIZATION_SCOPE_PATTERN.test('approval:instance:read')).toBe(false);
    expect(ERP_AUTHORIZATION_SCOPE_PATTERN.test('erp:approval:*:read')).toBe(false);
  });

  it('拒绝损坏 JSON 和不符合资源契约的配置', () => {
    const malformed = {
      get: (key: keyof AppEnvironment) => {
        if (key === 'AUTH_RESOURCE') return 'https://erp.example.com/mcp';
        if (key === 'AUTH_AUDIENCE') return 'gaoq-erp-api';
        if (key === 'AUTH_ADDITIONAL_RESOURCES_JSON') return '{';
        return undefined;
      },
    } as unknown as ConfigService<AppEnvironment, true>;
    expect(() => listAuthorizationResources(malformed)).toThrow('不是合法 JSON');
    expect(() => listAuthorizationResources(config([{
      resource: 'not-a-url',
      audience: '',
    }]))).toThrow('配置无效');
  });
});
