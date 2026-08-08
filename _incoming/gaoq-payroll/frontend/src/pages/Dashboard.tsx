import { useEffect, useState } from 'react';
import { Row, Col, List, Typography, Spin, Empty } from 'antd';
import ReactECharts from 'echarts-for-react';
import StatCard from '@/components/StatCard';
import { listEmployees } from '@/services/employees';
import { listPayrollBatches } from '@/services/payroll';
import { listAttendance } from '@/services/attendance';
import type { PayrollBatch } from '@/types/api';

const { Title } = Typography;

const Dashboard = () => {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalEmployees: 0,
    monthlyPayroll: 0,
    pendingAttendance: 0,
    alerts: 0,
  });
  const [recentBatches, setRecentBatches] = useState<PayrollBatch[]>([]);
  const [deptCosts, setDeptCosts] = useState<{ name: string; cost: number }[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [empRes, batchRes, attRes] = await Promise.all([
          listEmployees({ pageSize: 1 }),
          listPayrollBatches({ pageSize: 5 }),
          listAttendance({ pageSize: 1, status: 'draft' }),
        ]);
        setStats({
          totalEmployees: empRes.total,
          monthlyPayroll: batchRes.items.reduce((sum, b) => sum + b.totalNet, 0),
          pendingAttendance: attRes.total,
          alerts: 0,
        });
        setRecentBatches(batchRes.items);
        setDeptCosts([
          { name: '技术部', cost: 450000 },
          { name: '销售部', cost: 320000 },
          { name: '人事部', cost: 120000 },
          { name: '财务部', cost: 150000 },
          { name: '运营部', cost: 200000 },
        ]);
      } catch {
        // errors handled by interceptor
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const barOption = {
    title: { text: '部门成本分布', left: 'center' },
    xAxis: { type: 'category', data: deptCosts.map((d) => d.name) },
    yAxis: { type: 'value' },
    series: [{ data: deptCosts.map((d) => d.cost), type: 'bar', itemStyle: { color: '#1890ff' } }],
    tooltip: { trigger: 'axis' },
  };

  return (
    <div>
      <Title level={4}>仪表盘</Title>
      <Row gutter={16}>
        <Col span={6}><StatCard title="员工总数" value={stats.totalEmployees} loading={loading} color="#1890ff" /></Col>
        <Col span={6}><StatCard title="本月待发薪" value={stats.monthlyPayroll} suffix="元" loading={loading} color="#52c41a" /></Col>
        <Col span={6}><StatCard title="待处理考勤" value={stats.pendingAttendance} loading={loading} color="#faad14" /></Col>
        <Col span={6}><StatCard title="异常预警" value={stats.alerts} loading={loading} color="#f5222d" /></Col>
      </Row>
      <div style={{ marginTop: 24, display: 'flex', gap: 16 }}>
        <div style={{ flex: 2, background: '#fff', padding: 16, borderRadius: 4 }}>
          {loading ? <Spin /> : deptCosts.length > 0 ? <ReactECharts option={barOption} style={{ height: 300 }} /> : <Empty />}
        </div>
        <div style={{ flex: 1, background: '#fff', padding: 16, borderRadius: 4 }}>
          <Title level={5}>最近 payroll 批次</Title>
          <List
            dataSource={recentBatches}
            loading={loading}
            renderItem={(item) => (
              <List.Item>
                <div>{item.name} <span style={{ color: '#888' }}>({item.year}-{item.month})</span></div>
                <div>¥{item.totalNet}</div>
              </List.Item>
            )}
            locale={{ emptyText: <Empty /> }}
          />
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
