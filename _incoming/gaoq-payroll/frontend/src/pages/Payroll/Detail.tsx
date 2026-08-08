import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Table, Descriptions, Button, Spin, Empty, Tag, message } from 'antd';
import { CalculatorOutlined, CheckOutlined, RollbackOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { getPayrollBatch, getPayrollPayslips, calculatePayroll, confirmPayroll, rollbackPayroll } from '@/services/payroll';
import type { PayrollBatch, PayrollPayslip } from '@/types/api';

const statusMap: Record<string, { color: string; text: string }> = {
  draft: { color: 'default', text: '草稿' },
  calculated: { color: 'processing', text: '已计算' },
  confirmed: { color: 'success', text: '已确认' },
  paid: { color: 'blue', text: '已发放' },
};

const PayrollDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [batch, setBatch] = useState<PayrollBatch | null>(null);
  const [payslips, setPayslips] = useState<PayrollPayslip[]>([]);
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);

  useEffect(() => {
    if (!id) return;
    const fetch = async () => {
      setLoading(true);
      try {
        const [b, p] = await Promise.all([
          getPayrollBatch(id),
          getPayrollPayslips(id),
        ]);
        setBatch(b);
        setPayslips(p);
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, [id]);

  const handleCalculate = async () => {
    if (!id) return;
    setCalculating(true);
    try {
      await calculatePayroll(id);
      message.success('计算完成');
      const [b, p] = await Promise.all([getPayrollBatch(id), getPayrollPayslips(id)]);
      setBatch(b);
      setPayslips(p);
    } catch {
      // ignore
    } finally {
      setCalculating(false);
    }
  };

  const handleConfirm = async () => {
    if (!id) return;
    try {
      await confirmPayroll(id);
      message.success('确认成功');
      const b = await getPayrollBatch(id);
      setBatch(b);
    } catch {
      // ignore
    }
  };

  const handleRollback = async () => {
    if (!id) return;
    try {
      await rollbackPayroll(id);
      message.success('回滚成功');
      const b = await getPayrollBatch(id);
      setBatch(b);
    } catch {
      // ignore
    }
  };

  const columns = [
    { title: '工号', dataIndex: 'employeeNo', key: 'employeeNo' },
    { title: '姓名', dataIndex: 'employeeName', key: 'employeeName' },
    { title: '部门', dataIndex: 'departmentName', key: 'departmentName' },
    { title: '应发', dataIndex: 'grossAmount', key: 'grossAmount', render: (v: number) => `¥${v}` },
    { title: '扣除', dataIndex: 'deductionAmount', key: 'deductionAmount', render: (v: number) => `¥${v}` },
    { title: '个税', dataIndex: 'taxAmount', key: 'taxAmount', render: (v: number) => `¥${v}` },
    { title: '实发', dataIndex: 'netAmount', key: 'netAmount', render: (v: number) => `¥${v}` },
  ];

  const expandedRowRender = (record: PayrollPayslip) => {
    return (
      <Table
        columns={[
          { title: '项目', dataIndex: 'payItemName', key: 'payItemName' },
          { title: '金额', dataIndex: 'amount', key: 'amount', render: (v: number) => `¥${v}` },
          { title: '分类', dataIndex: 'category', key: 'category' },
        ]}
        dataSource={record.items}
        rowKey="payItemId"
        pagination={false}
        size="small"
      />
    );
  };

  if (loading) return <Spin tip="加载中..." />;
  if (!batch) return <Empty description="批次不存在" />;

  return (
    <div>
      <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/payroll')} style={{ marginBottom: 16 }}>返回</Button>
      <Card title={batch.name} extra={
        <div style={{ display: 'flex', gap: 8 }}>
          <Tag color={statusMap[batch.status]?.color}>{statusMap[batch.status]?.text}</Tag>
          {batch.status === 'draft' && <Button type="primary" icon={<CalculatorOutlined />} loading={calculating} onClick={handleCalculate}>计算</Button>}
          {batch.status === 'calculated' && (
            <>
              <Button type="primary" icon={<CheckOutlined />} onClick={handleConfirm}>确认</Button>
              <Button icon={<RollbackOutlined />} onClick={handleRollback}>回滚</Button>
            </>
          )}
        </div>
      }>
        <Descriptions bordered column={4}>
          <Descriptions.Item label="年份">{batch.year}</Descriptions.Item>
          <Descriptions.Item label="月份">{batch.month}</Descriptions.Item>
          <Descriptions.Item label="人数">{batch.totalEmployees}</Descriptions.Item>
          <Descriptions.Item label="应发">¥{batch.totalGross}</Descriptions.Item>
          <Descriptions.Item label="扣除">¥{batch.totalDeduction}</Descriptions.Item>
          <Descriptions.Item label="实发">¥{batch.totalNet}</Descriptions.Item>
        </Descriptions>
        <Table
          style={{ marginTop: 24 }}
          columns={columns}
          dataSource={payslips}
          rowKey="id"
          expandable={{ expandedRowRender }}
          pagination={false}
          locale={{ emptyText: <Empty /> }}
        />
      </Card>
    </div>
  );
};

export default PayrollDetail;
