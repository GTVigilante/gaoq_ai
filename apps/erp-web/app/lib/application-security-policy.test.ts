import { describe, expect, it } from 'vitest';

import {
  applicationSecurityHeaders,
  parseApplicationApiOrigin,
} from './application-security-policy.js';

describe('Web 全站安全策略', () => {
  it('开发环境只额外接受本机 HTTP API Origin', () => {
    expect(parseApplicationApiOrigin(undefined, false)).toBe('http://localhost:3001');
    expect(parseApplicationApiOrigin('http://127.0.0.1:3011', false))
      .toBe('http://127.0.0.1:3011');
    expect(() => parseApplicationApiOrigin('http://erp.internal', false))
      .toThrowError('APPLICATION_API_ORIGIN_INVALID');
  });

  it('生产环境只接受精确 HTTPS 根 Origin', () => {
    expect(parseApplicationApiOrigin(undefined, true)).toBe('http://localhost:3001');
    expect(parseApplicationApiOrigin('https://erp.example.com/', true))
      .toBe('https://erp.example.com');
    for (const value of [
      'http://erp.example.com',
      'https://erp.example.com/api',
      'https://erp.example.com?tenant=x',
      'https://user@erp.example.com',
    ]) {
      expect(() => parseApplicationApiOrigin(value, true))
        .toThrowError('APPLICATION_API_ORIGIN_INVALID');
    }
  });

  it('生产响应头包含完整 CSP、浏览器权限隔离和 HSTS', () => {
    const headers = applicationSecurityHeaders('https://erp.example.com', true);
    const csp = headers.find((header) => header.key === 'Content-Security-Policy')?.value;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://erp.example.com");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain("'unsafe-eval'");
    expect(headers).toContainEqual({
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    });
    expect(headers).toContainEqual(
      expect.objectContaining({ key: 'Strict-Transport-Security' }),
    );
  });

  it('开发 CSP 仅为框架热更新增加 unsafe-eval 且不误发 HSTS', () => {
    const headers = applicationSecurityHeaders('http://localhost:3011', false);
    const csp = headers.find((header) => header.key === 'Content-Security-Policy')?.value;
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(headers).not.toContainEqual(
      expect.objectContaining({ key: 'Strict-Transport-Security' }),
    );
  });
});
