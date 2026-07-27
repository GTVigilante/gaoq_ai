import { describe, expect, it } from 'vitest';

import {
  parseWebsiteBuildEnvironment,
  websiteSecurityHeaders,
} from './website-security-policy.js';

describe('营销官网生产安全策略', () => {
  const valid = {
    NEXT_PUBLIC_WEBSITE_ORIGIN: 'https://www.example.com',
    NEXT_PUBLIC_ERP_API_ORIGIN: 'https://erp.example.com',
    NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL: 'https://captcha.example.net/widget',
  };

  it('生产构建要求三个合法 HTTPS 公开地址', () => {
    expect(parseWebsiteBuildEnvironment(valid, true)).toMatchObject({
      websiteOrigin: 'https://www.example.com',
      apiOrigin: 'https://erp.example.com',
      captchaOrigin: 'https://captcha.example.net',
    });
    for (const environment of [
      {},
      { ...valid, NEXT_PUBLIC_WEBSITE_ORIGIN: 'http://localhost:3002' },
      { ...valid, NEXT_PUBLIC_ERP_API_ORIGIN: 'https://erp.example.com/api' },
      { ...valid, NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL: 'https://captcha.example.net/widget?tenant=x' },
      { ...valid, NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL: 'https://user@captcha.example.net/widget' },
    ]) {
      expect(() => parseWebsiteBuildEnvironment(environment, true)).toThrow();
    }
  });

  it('本地开发允许明确的 localhost 默认值', () => {
    expect(parseWebsiteBuildEnvironment({}, false)).toMatchObject({
      websiteOrigin: 'http://localhost:3002',
      apiOrigin: 'http://localhost:3001',
      captchaOrigin: 'http://localhost:3100',
    });
  });

  it('响应头精确绑定 API 与验证码 Origin，并隔离嵌入和浏览器能力', () => {
    const config = parseWebsiteBuildEnvironment(valid, true);
    const headers = websiteSecurityHeaders(config, true);
    const csp = headers.find((header) => header.key === 'Content-Security-Policy')?.value;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('connect-src \'self\' https://erp.example.com');
    expect(csp).toContain('frame-src https://captcha.example.net');
    expect(csp).toContain('upgrade-insecure-requests');
    expect(headers).toContainEqual(expect.objectContaining({
      key: 'Strict-Transport-Security',
    }));
    expect(headers).toContainEqual({
      key: 'X-Frame-Options',
      value: 'DENY',
    });
  });
});
