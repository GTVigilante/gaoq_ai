import type { Metadata } from 'next';
import { Suspense } from 'react';

import { SsoCallbackClient } from './sso-callback-client';

export const metadata: Metadata = { title: '正在登录 · GaoQ-OS' };

export default function SsoCallbackPage() {
  return <Suspense fallback={<main className="sso-callback-shell">正在验证企业身份…</main>}>
    <SsoCallbackClient />
  </Suspense>;
}
