export interface ApplicationSecurityHeader {
  readonly key: string;
  readonly value: string;
}

const LOCAL_API_ORIGIN = 'http://localhost:3001';
const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()';

/** 浏览器只连接部署时登记的 API 根 Origin，拒绝路径、凭据和动态参数。 */
export function parseApplicationApiOrigin(
  value: string | undefined,
  production: boolean,
): string {
  if (value === undefined || value.trim().length === 0) {
    if (production) throw new Error('APPLICATION_API_ORIGIN_REQUIRED');
    return LOCAL_API_ORIGIN;
  }
  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('APPLICATION_API_ORIGIN_INVALID');
  }
  const isLocalDevelopmentOrigin =
    !production &&
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (
    (url.protocol !== 'https:' && !isLocalDevelopmentOrigin) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.origin !== candidate.replace(/\/$/u, '')
  ) {
    throw new Error('APPLICATION_API_ORIGIN_INVALID');
  }
  return url.origin;
}

/** 生成全站 CSP；frameAncestors 已由调用方按部署白名单完成规范化。 */
export function applicationSecurityHeaders(
  apiOriginValue: string | undefined,
  production: boolean,
  frameAncestors = "'none'",
): readonly ApplicationSecurityHeader[] {
  const apiOrigin = parseApplicationApiOrigin(apiOriginValue, production);
  const scriptSources = production
    ? "'self' 'unsafe-inline'"
    : "'self' 'unsafe-inline' 'unsafe-eval'";
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
    "form-action 'self'",
    `script-src ${scriptSources}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "manifest-src 'self'",
    "media-src 'self'",
  ];
  if (production) directives.push('upgrade-insecure-requests');

  const headers: ApplicationSecurityHeader[] = [
    { key: 'Content-Security-Policy', value: directives.join('; ') },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
  ];
  if (production) {
    headers.push({
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000; includeSubDomains',
    });
  }
  return Object.freeze(headers.map((header) => Object.freeze(header)));
}
