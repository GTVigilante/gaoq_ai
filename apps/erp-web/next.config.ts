import type { NextConfig } from 'next';

import { mobileContainerHeaders } from './app/lib/mobile-container-policy';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  headers() {
    return Promise.resolve([{
      source: '/mobile/:path*',
      headers: [...mobileContainerHeaders(
        process.env.ERP_MOBILE_FRAME_ANCESTORS,
        process.env.NODE_ENV === 'production',
      )],
    }]);
  },
};

export default nextConfig;
