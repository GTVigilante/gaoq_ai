import { redirect } from 'next/navigation';

/** 默认进入简体中文站点，语言切换始终由用户显式触发。 */
export default function RootPage() {
  redirect('/zh-CN');
}
