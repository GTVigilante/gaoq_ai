import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'GaoQ-OS',
  description: '告趣企业运营系统',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f4f1e8',
};

interface RootLayoutProps {
  children: ReactNode;
}

/**
 * 提供应用级HTML骨架，业务页面必须在服务端权限结果基础上渲染。
 */
export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
