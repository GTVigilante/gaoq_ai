import { Card, Statistic } from 'antd';
import type { ReactNode } from 'react';

interface StatCardProps {
  title: string;
  value: number | string;
  prefix?: ReactNode;
  suffix?: string;
  loading?: boolean;
  color?: string;
}

const StatCard = ({ title, value, prefix, suffix, loading, color = '#1890ff' }: StatCardProps) => {
  return (
    <Card style={{ borderTop: `3px solid ${color}` }} loading={loading}>
      <Statistic title={title} value={value} prefix={prefix} suffix={suffix} />
    </Card>
  );
};

export default StatCard;
