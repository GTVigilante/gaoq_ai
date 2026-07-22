export interface MobileContainerHeader {
  readonly key: string;
  readonly value: string;
}

/** 平台容器只接受部署时登记的精确 HTTPS Origin；通配符、路径、凭据和动态参数均拒绝。 */
export function parseMobileFrameAncestors(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return "'self'";
  const tokens = value.trim().split(/\s+/u);
  if (tokens.length > 10) throw new Error('MOBILE_FRAME_ANCESTORS_INVALID');
  const origins = new Set<string>();
  for (const token of tokens) {
    let url: URL;
    try {
      url = new URL(token);
    } catch {
      throw new Error('MOBILE_FRAME_ANCESTORS_INVALID');
    }
    if (
      url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0 ||
      url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0 ||
      url.hostname.includes('*') || url.origin !== token.replace(/\/$/u, '')
    ) throw new Error('MOBILE_FRAME_ANCESTORS_INVALID');
    origins.add(url.origin);
  }
  return ["'self'", ...[...origins].sort()].join(' ');
}

/** H5 容器响应头；容器来源仅控制嵌入资格，不参与身份、租户或 Scope 判定。 */
export function mobileContainerHeaders(
  frameAncestors: string | undefined,
  production: boolean,
): readonly MobileContainerHeader[] {
  const headers: MobileContainerHeader[] = [
    {
      key: 'Content-Security-Policy',
      value: `base-uri 'self'; object-src 'none'; frame-ancestors ${parseMobileFrameAncestors(frameAncestors)}`,
    },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    },
  ];
  if (production) headers.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  });
  return Object.freeze(headers.map((header) => Object.freeze(header)));
}
