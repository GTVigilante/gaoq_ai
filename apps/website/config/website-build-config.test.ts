import { describe, expect, it } from 'vitest';

import {
  createWebsiteSecurityHeaders,
  resolveWebsiteBuildConfig,
} from '../next.config.js';

const validProduction = Object.freeze({
  NODE_ENV: 'production',
  NEXT_PUBLIC_WEBSITE_ORIGIN: 'https://www.example.com',
  NEXT_PUBLIC_ERP_API_ORIGIN: 'https://api.example.com',
  NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN: 'https://captcha.example.net',
  NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL:
    'https://captcha.example.net/widget?site=gaoq',
});

describe('Website 构建期公开配置', () => {
  it('生产构建缺少任一公开端点时失败关闭', () => {
    for (const name of [
      'NEXT_PUBLIC_WEBSITE_ORIGIN',
      'NEXT_PUBLIC_ERP_API_ORIGIN',
      'NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN',
      'NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL',
    ] as const) {
      expect(() => resolveWebsiteBuildConfig({
        ...validProduction,
        [name]: undefined,
      })).toThrow();
    }
  });

  it('接受相互隔离的标准 HTTPS Origin 和同源验证码 URL', () => {
    expect(resolveWebsiteBuildConfig(validProduction)).toEqual({
      production: true,
      websiteOrigin: 'https://www.example.com',
      erpApiOrigin: 'https://api.example.com',
      captchaWidgetOrigin: 'https://captcha.example.net',
      captchaWidgetUrl: 'https://captcha.example.net/widget?site=gaoq',
    });
  });

  it('拒绝 HTTP、localhost、非标准端口、路径、凭据和 Origin 错配', () => {
    for (const value of [
      'http://www.example.com',
      'https://localhost',
      'https://www.example.com:8443',
      'https://www.example.com/path',
      'https://user:password@www.example.com',
    ]) {
      expect(() => resolveWebsiteBuildConfig({
        ...validProduction,
        NEXT_PUBLIC_WEBSITE_ORIGIN: value,
      })).toThrow('NEXT_PUBLIC_WEBSITE_ORIGIN_INVALID');
    }
    expect(() => resolveWebsiteBuildConfig({
      ...validProduction,
      NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN:
        'https://captcha-other.example.net',
    })).toThrow('WEBSITE_CAPTCHA_WIDGET_ORIGIN_MISMATCH');
    expect(() => resolveWebsiteBuildConfig({
      ...validProduction,
      NEXT_PUBLIC_ERP_API_ORIGIN: 'https://www.example.com',
    })).toThrow('WEBSITE_PUBLIC_ORIGINS_MUST_BE_ISOLATED');
  });

  it('开发环境允许显式本地回退，生产安全头绑定精确外部 Origin', () => {
    expect(resolveWebsiteBuildConfig({ NODE_ENV: 'development' })).toMatchObject({
      production: false,
      websiteOrigin: 'http://localhost:3002',
      erpApiOrigin: 'http://localhost:3001',
    });
    const headers = Object.fromEntries(
      createWebsiteSecurityHeaders(resolveWebsiteBuildConfig(validProduction))
        .map(({ key, value }) => [key, value]),
    );
    expect(headers['Content-Security-Policy']).toContain(
      'connect-src \'self\' https://api.example.com',
    );
    expect(headers['Content-Security-Policy']).toContain(
      'frame-src https://captcha.example.net',
    );
    expect(headers['Content-Security-Policy']).toContain(
      'upgrade-insecure-requests',
    );
    expect(headers['Strict-Transport-Security'])
      .toBe('max-age=63072000; includeSubDomains; preload');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
});
