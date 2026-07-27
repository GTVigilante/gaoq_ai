import type { NextConfig } from 'next';
import {
  parseWebsiteBuildEnvironment,
  websiteSecurityHeaders,
} from './app/lib/website-security-policy';

const production = process.env.NODE_ENV === 'production';
const publicEnvironment = parseWebsiteBuildEnvironment(process.env, production);
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  typedRoutes: false,
  env: {
    NEXT_PUBLIC_WEBSITE_ORIGIN: publicEnvironment.websiteOrigin,
    NEXT_PUBLIC_ERP_API_ORIGIN: publicEnvironment.apiOrigin,
    NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL: publicEnvironment.captchaWidgetUrl,
  },
  headers: () => Promise.resolve([{
      source: '/(.*)',
      headers: [...websiteSecurityHeaders(publicEnvironment, production)],
    }]),
};

export default nextConfig;
