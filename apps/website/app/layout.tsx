import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_WEBSITE_ORIGIN ?? 'http://localhost:3002'),
  title: { default: '告趣 GaoQ｜AI 驱动的创作者服务商', template: '%s｜告趣 GaoQ' },
  description: '以 AI 与规范化运营，为创作者和品牌提供内容、设计、商务、财务、法务、投流与剪辑服务。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f3f0e8',
};

/** 公共官网根布局。 */
export default function WebsiteLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
