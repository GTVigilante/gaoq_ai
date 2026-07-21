import type { Metadata } from 'next';

import { ManagementDashboard } from './management-dashboard';

export const metadata: Metadata = {
  title: '管理驾驶舱 · GaoQ-OS',
  description: '组织、审批、招聘、学习、薪资周期与经营聚合指标',
};

/** 管理驾驶舱入口；所有指标权限与租户范围由 ERP API 判定。 */
export default function ManagementDashboardPage() {
  return <ManagementDashboard initialAsOf={todayInShanghai()} />;
}

function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
