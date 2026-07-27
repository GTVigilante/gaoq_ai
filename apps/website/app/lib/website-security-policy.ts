export interface WebsiteBuildEnvironment {
  readonly websiteOrigin: string;
  readonly apiOrigin: string;
  readonly captchaWidgetUrl: string;
  readonly captchaOrigin: string;
}

interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

/** 解析官网构建期公开配置；生产环境禁止缺失、localhost、凭据和非 HTTPS 地址。 */
export function parseWebsiteBuildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  production: boolean,
): WebsiteBuildEnvironment {
  const websiteOrigin = parseOrigin(
    environment.NEXT_PUBLIC_WEBSITE_ORIGIN,
    production,
    'http://localhost:3002',
    'WEBSITE_PUBLIC_ORIGIN',
  );
  const apiOrigin = parseOrigin(
    environment.NEXT_PUBLIC_ERP_API_ORIGIN,
    production,
    'http://localhost:3001',
    'WEBSITE_ERP_API_ORIGIN',
  );
  const rawWidget = environment.NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL ??
    (production ? undefined : 'http://localhost:3100/widget');
  if (rawWidget === undefined) throw new Error('WEBSITE_CAPTCHA_WIDGET_URL_REQUIRED');
  let widget: URL;
  try {
    widget = new URL(rawWidget);
  } catch {
    throw new Error('WEBSITE_CAPTCHA_WIDGET_URL_INVALID');
  }
  if (
    widget.username !== '' ||
    widget.password !== '' ||
    widget.search !== '' ||
    widget.hash !== '' ||
    (production && (
      widget.protocol !== 'https:' ||
      isLocalHostname(widget.hostname) ||
      (widget.port !== '' && widget.port !== '443')
    )) ||
    (!production && !['http:', 'https:'].includes(widget.protocol))
  ) throw new Error('WEBSITE_CAPTCHA_WIDGET_URL_INVALID');
  return Object.freeze({
    websiteOrigin,
    apiOrigin,
    captchaWidgetUrl: widget.toString(),
    captchaOrigin: widget.origin,
  });
}

/** 官网浏览器安全策略；生产额外启用 HSTS 与不安全请求升级。 */
export function websiteSecurityHeaders(
  config: WebsiteBuildEnvironment,
  production: boolean,
): readonly SecurityHeader[] {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `connect-src 'self' ${config.apiOrigin}`,
    `frame-src ${config.captchaOrigin}`,
    "img-src 'self' data: https:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "manifest-src 'self'",
    "worker-src 'self'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  return Object.freeze([
    { key: 'Content-Security-Policy', value: csp },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
    ...(production ? [{
      key: 'Strict-Transport-Security',
      value: 'max-age=63072000; includeSubDomains; preload',
    }] : []),
  ]);
}

function parseOrigin(
  raw: string | undefined,
  production: boolean,
  developmentDefault: string,
  code: string,
): string {
  if (raw === undefined && production) throw new Error(`${code}_REQUIRED`);
  let parsed: URL;
  try {
    parsed = new URL(raw ?? developmentDefault);
  } catch {
    throw new Error(`${code}_INVALID`);
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (production && (
      parsed.protocol !== 'https:' ||
      isLocalHostname(parsed.hostname) ||
      (parsed.port !== '' && parsed.port !== '443')
    )) ||
    (!production && !['http:', 'https:'].includes(parsed.protocol))
  ) throw new Error(`${code}_INVALID`);
  return parsed.origin;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    ['::1', '[::1]'].includes(hostname) ||
    hostname.endsWith('.local');
}
