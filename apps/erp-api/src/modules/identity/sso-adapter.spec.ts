import { describe, expect, it } from 'vitest';

import type {
  DingTalkSsoAdapterToken,
} from './sso-adapter.js';
import { SsoAdapterRegistry } from './sso-adapter.js';

const adapter = (provider: 'dingtalk' | 'feishu' | 'op') => ({
  provider,
  buildAuthorizationUrl: () => 'https://example.com',
  exchangeAuthorizationCode: () => Promise.resolve({
    provider,
    externalTenantId: 'external-tenant-001',
    unionId: 'union-001',
    externalUserId: 'user-001',
    displayName: '员工甲',
  }),
});

describe('SsoAdapterRegistry', () => {
  it('只返回按固定槽位注册的平台适配器', () => {
    const dingtalk = adapter('dingtalk');
    const feishu = adapter('feishu');
    const op = adapter('op');
    const registry = new SsoAdapterRegistry(dingtalk, feishu, op);
    expect(registry.get('dingtalk')).toBe(dingtalk);
    expect(registry.get('feishu')).toBe(feishu);
    expect(registry.get('op')).toBe(op);
  });

  it('启动时拒绝错槽或重复平台注册', () => {
    expect(() => new SsoAdapterRegistry(
      adapter('feishu') as unknown as DingTalkSsoAdapterToken,
      adapter('feishu'),
      adapter('op'),
    )).toThrow('SSO_ADAPTER_REGISTRATION_INVALID');
  });

  it('运行时拒绝未注册平台编码', () => {
    const registry = new SsoAdapterRegistry(
      adapter('dingtalk'), adapter('feishu'), adapter('op'),
    );
    expect(() => registry.get('unknown' as 'op')).toThrow('未注册的 SSO 提供者');
  });
});
