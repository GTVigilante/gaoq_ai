import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'GaoQ 专业算薪',
  description: '与 GaoQ ERP 统一身份和组织主数据打通的专业算薪系统',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: '#f5f7fa' }}>
        {children}
      </body>
    </html>
  );
}
