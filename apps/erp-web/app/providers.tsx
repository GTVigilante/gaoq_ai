'use client';

import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';

/** GaoQ-OS 统一设计令牌；业务权限仍完全由服务端决定。 */
export function AppProviders({ children }: { readonly children: ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#155eef', colorInfo: '#155eef', colorSuccess: '#178f5f',
          colorWarning: '#c77a06', colorError: '#c83d4f', borderRadius: 10,
          fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Layout: { headerBg: '#ffffff', siderBg: '#10223f', bodyBg: '#f3f6fb' },
          Menu: { darkItemBg: '#10223f', darkItemSelectedBg: '#2258c5' },
        },
      }}
    >
      <App>{children}</App>
    </ConfigProvider>
  );
}
