import type { NextConfig } from 'next';
import {
  parseWebsiteBuildEnvironment,
  websiteSecurityHeaders,
} from './app/lib/website-security-policy';

export interface WebsiteBuildEnvironment {
  readonly NODE_ENV?: string;
  readonly NEXT_PUBLIC_WEBSITE_ORIGIN?: string;
  readonly NEXT_PUBLIC_ERP_API_ORIGIN?: string;
  readonly NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN?: string;
  readonly NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL?: string;
}

export interface WebsiteBuildConfig {
  readonly production: boolean;
  readonly websiteOrigin: string;
  readonly erpApiOrigin: string;
  readonly captchaWidgetOrigin: string;
  readonly captchaWidgetUrl: string;
}

const LOCAL_DEFAULTS = Object.freeze({
  websiteOrigin: 'http://localhost:3002',
  erpApiOrigin: 'http://localhost:3001',
  captchaWidgetOrigin: 'http://localhost:3200',
  captchaWidgetUrl: 'http://localhost:3200/widget',
});

/** 解析并失败关闭 Website 构建期公开配置。 */
export const resolveWebsiteBuildConfig = (
  environment: WebsiteBuildEnvironment,
): WebsiteBuildConfig => {
  const production = environment.NODE_ENV === 'production';
  const websiteOrigin = parseOrigin(
    'NEXT_PUBLIC_WEBSITE_ORIGIN',
    environment.NEXT_PUBLIC_WEBSITE_ORIGIN,
    production,
    LOCAL_DEFAULTS.websiteOrigin,
  );
  const erpApiOrigin = parseOrigin(
    'NEXT_PUBLIC_ERP_API_ORIGIN',
    environment.NEXT_PUBLIC_ERP_API_ORIGIN,
    production,
    LOCAL_DEFAULTS.erpApiOrigin,
  );
  const captchaWidgetOrigin = parseOrigin(
    'NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN',
    environment.NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_ORIGIN,
    production,
    LOCAL_DEFAULTS.captchaWidgetOrigin,
  );
  const captchaWidgetUrl = parseWidgetUrl(
    environment.NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL,
    production,
    LOCAL_DEFAULTS.captchaWidgetUrl,
  );

  if (production && new Set([
    websiteOrigin,
    erpApiOrigin,
    captchaWidgetOrigin,
  ]).size !== 3) {
    throw new Error('WEBSITE_PUBLIC_ORIGINS_MUST_BE_ISOLATED');
  }
  if (new URL(captchaWidgetUrl).origin !== captchaWidgetOrigin) {
    throw new Error('WEBSITE_CAPTCHA_WIDGET_ORIGIN_MISMATCH');
  }
  return Object.freeze({
    production,
    websiteOrigin,
    erpApiOrigin,
    captchaWidgetOrigin,
    captchaWidgetUrl,
  });
};

/** 生成 Website 全路由统一安全响应头。 */
export const createWebsiteSecurityHeaders = (
  config: WebsiteBuildConfig,
): readonly Readonly<{ key: string; value: string }>[] => Object.freeze([
  Object.freeze({
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src 'self' ${config.erpApiOrigin}`,
      "font-src 'self' data:",
      `frame-src ${config.captchaWidgetOrigin}`,
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: https:",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      ...(config.production ? ['upgrade-insecure-requests'] : []),
    ].join('; '),
  }),
  Object.freeze({
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  }),
  Object.freeze({ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }),
  Object.freeze({
    key: 'Permissions-Policy',
    value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  }),
  Object.freeze({ key: 'X-Content-Type-Options', value: 'nosniff' }),
  Object.freeze({ key: 'X-Frame-Options', value: 'DENY' }),
  Object.freeze({ key: 'Cross-Origin-Opener-Policy', value: 'same-origin' }),
  Object.freeze({ key: 'Cross-Origin-Resource-Policy', value: 'same-origin' }),
  Object.freeze({ key: 'Origin-Agent-Cluster', value: '?1' }),
]);

const parseOrigin = (
  name: string,
  rawValue: string | undefined,
  production: boolean,
  localDefault: string,
): string => {
  const value = rawValue?.trim() || (production ? undefined : localDefault);
  if (value === undefined) throw new Error(`${name}_REQUIRED`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name}_INVALID`);
  }
  if (
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    (
      production &&
      (
        url.protocol !== 'https:' ||
        (url.port !== '' && url.port !== '443') ||
        isLoopbackHost(url.hostname)
      )
    ) ||
    (
      !production &&
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    )
  ) {
    throw new Error(`${name}_INVALID`);
  }
  return url.origin;
};

const parseWidgetUrl = (
  rawValue: string | undefined,
  production: boolean,
  localDefault: string,
): string => {
  const value = rawValue?.trim() || (production ? undefined : localDefault);
  if (value === undefined) {
    throw new Error('NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL_REQUIRED');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL_INVALID');
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (
      production &&
      (
        url.protocol !== 'https:' ||
        (url.port !== '' && url.port !== '443') ||
        isLoopbackHost(url.hostname)
      )
    ) ||
    (
      !production &&
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    ) ||
    value.length > 2_048
  ) {
    throw new Error('NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL_INVALID');
  }
  return url.toString();
};

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.endsWith('.localhost');
};

const buildConfig = resolveWebsiteBuildConfig(process.env);

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  typedRoutes: false,
  headers() {
    return Promise.resolve([{
      source: '/(.*)',
      headers: [...createWebsiteSecurityHeaders(buildConfig)],
    }]);
  },
};

export default nextConfig;
