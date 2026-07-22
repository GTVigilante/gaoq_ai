import { describe, expect, it } from 'vitest';

import { mobileContainerHeaders, parseMobileFrameAncestors } from './mobile-container-policy.js';

describe('移动平台容器策略', () => {
  it('默认仅允许同源并规范化精确 HTTPS Origin', () => {
    expect(parseMobileFrameAncestors(undefined)).toBe("'self'");
    expect(parseMobileFrameAncestors('https://open.dingtalk.com https://open.feishu.cn/'))
      .toBe("'self' https://open.dingtalk.com https://open.feishu.cn");
  });

  it('拒绝 HTTP、通配符、路径、查询、凭据和超量来源', () => {
    for (const value of [
      'http://open.dingtalk.com', 'https://*.example.com', 'https://example.com/container',
      'https://example.com?tenant=x', 'https://user@example.com',
      Array.from({ length: 11 }, (_, index) => `https://c${index}.example.com`).join(' '),
    ]) expect(() => parseMobileFrameAncestors(value)).toThrowError('MOBILE_FRAME_ANCESTORS_INVALID');
  });

  it('生产响应头关闭高风险浏览器能力且启用 HSTS', () => {
    const headers = mobileContainerHeaders('https://open.dingtalk.com', true);
    expect(headers.find((header) => header.key === 'Content-Security-Policy')?.value)
      .toContain("frame-ancestors 'self' https://open.dingtalk.com");
    expect(headers).toContainEqual({
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    });
    expect(headers).toContainEqual(expect.objectContaining({ key: 'Strict-Transport-Security' }));
  });
});
