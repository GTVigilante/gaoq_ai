import type { Metadata } from 'next';

import { MobileWorkbench } from './mobile-workbench';

export const metadata: Metadata = {
  title: '移动工作台 · GaoQ-OS',
  description: '告趣 ERP 移动审批与员工服务入口',
};

/** 移动工作台页面；身份和数据范围仍由 ERP HttpOnly 会话及服务端权限判定。 */
export default function MobilePage() {
  return <MobileWorkbench />;
}
