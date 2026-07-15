import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Table, Button, Modal, Form, InputNumber, Input, Select, message, Space, Popconfirm, Tag, Input as AntInput } from 'antd';
import { PlusOutlined, CalculatorOutlined, CheckOutlined, RollbackOutlined, DeleteOutlined, EyeOutlined } from '@ant-design/icons';
import { listPayrollBatches, createPayrollBatch, calculatePayroll, confirmPayroll, rollbackPayroll, deletePayrollBatch } from '@/services/payroll';
import type { PayrollBatch } from '@/types/api';

const statusMap: Record<string, { color: string; text: string }> = {
  draft: { color: 'default', text: '草稿' },
  calculated: { color: 'processing', text: '已计算' },
  confirmed: { color: 'success', text: '已确认' },
  paid: { color: 'blue', text: '已发放' },
};

const PayrollList = () => {
  const [data, setData] = useState<PayrollBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [calculating, setCalculating] = useState<string | null>(null);
  const [form] = Form.useForm();
  const navigate = useNavigate();

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await listPayrollBatches({ pageSize: 100 });
      setData(res.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      await createPayrollBatch(values);
      message.success('创建成功');
      setModalVisible(false);
      fetchData();
    } catch {
      // ignore
    }
  };

  const handleCalculate = async (id: string) => {
    setCalculating(id);
    try {
      await calculatePayroll(id);
      message.success('计算完成');
      fetchData();
    } catch {
      // ignore
    } finally {
      setCalculating(null);
    }
  };

  const handleConfirm = async (id: string) => {
    try {
      await confirmPayroll(id);
      message.success('确认成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const handleRollback = async (id: string) => {
    try {
      await rollbackPayroll(id);
      message.success('回滚成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePayrollBatch(id);
      message.success('删除成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '年份', dataIndex: 'year', key: 'year' },
    { title: '月份', dataIndex: 'month', key: 'month' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (v: string) => <Tag color={statusMap[v]?.color}>{statusMap[v]?.text || v}</Tag> },
    { title: '人数', dataIndex: 'totalEmployees', key: 'totalEmployees' },
    { title: '应发', dataIndex: 'totalGross', key: 'totalGross', render: (v: number) => `¥${v}` },
    { title: '扣除', dataIndex: 'totalDeduction', key: 'totalDeduction', render: (v: number) => `¥${v}` },
    { title: '实发', dataIndex: 'totalNet', key: 'totalNet', render: (v: number) => `¥${v}` },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: PayrollBatch) => (
        <Space>
          <Button type="link" icon={<EyeOutlined />} onClick={() => navigate(`/payroll/${record.id}`)}>查看</Button>
          {record.status === 'draft' && (
            <Button type="link" icon={<CalculatorOutlined />} loading={calculating === record.id} onClick={() => handleCalculate(record.id)}>计算</Button>
          )}
          {record.status === 'calculated' && (
            <>
              <Button type="link" icon={<CheckOutlined />} onClick={() => handleConfirm(record.id)}>确认</Button>
              <Button type="link" icon={<RollbackOutlined />} onClick={() => handleRollback(record.id)}>回滚</Button>
            </>
          )}
          {record.status !== 'paid' && (
            <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
              <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card title="薪资计算" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setModalVisible(true); }}>新建批次</Button>}>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading} pagination={false} />
      <Modal title="新建薪资批次" open={modalVisible} onOk={handleCreate} onCancel={() => setModalVisible(false)}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="year" label="年份" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="month" label="月份" rules={[{ required: true }]}><InputNumber min={1} max={12} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

export default PayrollList;
