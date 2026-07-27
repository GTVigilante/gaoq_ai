import { describe, expect, it } from 'vitest';

import {
  buildAllowedCorsOrigins,
  isCorsOriginAllowed,
} from './cors-origin-policy.js';

describe('CORS Origin 精确策略', () => {
  const allowed = buildAllowedCorsOrigins({
    webOrigin: 'https://erp.example.com',
    marketingWebsiteOrigin: 'https://www.example.com',
    mcpAllowedOrigins: 'https://ai.example.net, https://desktop.example.net',
  });

  it('只接受配置中的完整 Origin 和无浏览器 Origin 的服务请求', () => {
    expect(isCorsOriginAllowed('https://www.example.com', allowed)).toBe(true);
    expect(isCorsOriginAllowed('https://erp.example.com', allowed)).toBe(true);
    expect(isCorsOriginAllowed('https://ai.example.net', allowed)).toBe(true);
    expect(isCorsOriginAllowed(undefined, allowed)).toBe(true);
  });

  it('拒绝后缀欺骗、HTTP、端口、路径和未登记 Origin', () => {
    for (const origin of [
      'https://www.example.com.evil.invalid',
      'http://www.example.com',
      'https://www.example.com:8443',
      'https://www.example.com/path',
      'https://unknown.example.com',
    ]) {
      expect(isCorsOriginAllowed(origin, allowed)).toBe(false);
    }
  });
});
