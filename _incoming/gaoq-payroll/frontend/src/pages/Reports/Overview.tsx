import { useEffect, useState } from 'react';
import { Card, Row, Col, Spin, Empty } from 'antd';
import ReactECharts from 'echarts-for-react';
import { getCostOverview } from '@/services/reports';
import type { ReportCostOverview } from '@/types/api';

const ReportOverview = () => {
  const [data, setData] = useState<ReportCostOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await getCostOverview();
        setData(res);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, []);

  const pieOption = data ? {
    title: { text: '成本结构', left: 'center' },
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie',
      radius: '50%',
      data: [
        { value: data.totalSalary, name: '基本工资' },
        { value: data.totalBonus, name: '奖金' },
        { value: data.totalSocial, name: '社保' },
        { value: data.totalTax, name: '个税' },
      ],
    }],
  } : {};

  const barOption = data ? {
    title: { text: '部门成本对比', left: 'center' },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: data.departmentCosts.map((d) => d.name) },
    yAxis: { type: 'value' },
    series: [{ data: data.departmentCosts.map((d) => d.cost), type: 'bar', itemStyle: { color: '#1890ff' } }],
  } : {};

  const lineOption = data ? {
    title: { text: '月度成本趋势', left: 'center' },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: data.monthlyTrends.map((d) => d.month) },
    yAxis: { type: 'value' },
    series: [{ data: data.monthlyTrends.map((d) => d.cost), type: 'line', smooth: true, itemStyle: { color: '#52c41a' } }],
  } : {};

  return (
    <div>
      <h2>报表分析</h2>
      <Row gutter={16}>
        <Col span={8}>
          <Card loading={loading}>
            {data ? <ReactECharts option={pieOption} style={{ height: 300 }} /> : <Empty />}
          </Card>
        </Col>
        <Col span={8}>
          <Card loading={loading}>
            {data ? <ReactECharts option={barOption} style={{ height: 300 }} /> : <Empty />}
          </Card>
        </Col>
        <Col span={8}>
          <Card loading={loading}>
            {data ? <ReactECharts option={lineOption} style={{ height: 300 }} /> : <Empty />}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default ReportOverview;
