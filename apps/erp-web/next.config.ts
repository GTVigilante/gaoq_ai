import type { NextConfig } from 'next';

import { applicationSecurityHeaders } from './app/lib/application-security-policy';
import { mobileContainerHeaders } from './app/lib/mobile-container-policy';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  headers() {
    const production = process.env.NODE_ENV === 'production';
    const apiOrigin = process.env.NEXT_PUBLIC_ERP_API_ORIGIN;
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [...applicationSecurityHeaders(apiOrigin, production)],
      },
      {
        source: '/mobile/:path*',
        headers: [
          ...mobileContainerHeaders(
            process.env.ERP_MOBILE_FRAME_ANCESTORS,
            production,
            apiOrigin,
          ),
        ],
      },
    ]);
  },
};

export default nextConfig;
