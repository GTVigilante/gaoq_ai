import type { Metadata } from 'next';

import { LoginClient } from './login-client';

export const metadata: Metadata = { title: '登录 · GaoQ-OS' };

export default function LoginPage() {
  return <LoginClient />;
}
