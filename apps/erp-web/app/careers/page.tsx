import type { Metadata } from 'next';

import { CareerPortal } from './career-portal';

export const metadata: Metadata = {
  title: '加入告趣｜与有趣的人，创造有影响力的事',
  description: '探索告趣的开放职位、团队文化与招聘流程。',
};

/** 公开招聘门户入口；职位与申请均经同源 BFF 连接 ERP。 */
export default function CareersPage() {
  return <CareerPortal />;
}
