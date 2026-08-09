import type { Metadata } from 'next';

import { MultidimensionalBaseDemo } from './multidimensional-base-demo';

export const metadata: Metadata = {
  title: '招聘运营中心 · GaoQ 多维表格演示',
  description: 'GaoQ OS 多维表格公开只读样例，展示表格、看板、仪表盘、日历和跨表关联。',
};

export default function MultidimensionalBaseDemoPage() {
  return <MultidimensionalBaseDemo />;
}
