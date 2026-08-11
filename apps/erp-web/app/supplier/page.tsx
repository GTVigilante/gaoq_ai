import type { Metadata } from 'next';

import { SupplierSelfPortal } from './supplier-self-portal';

export const metadata: Metadata = {
  title: '我的合作档案 · GaoQ-OS',
  description: '个人兼职者与供应方成员的能力、价目和合作状态自助入口',
};

export default function SupplierSelfPage() { return <SupplierSelfPortal />; }
