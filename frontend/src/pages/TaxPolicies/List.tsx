import { useEffect, useState } from 'react';
import { Card, Table, Button, Modal, Form, InputNumber, Input, message, Space, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { listTaxPolicies, createTaxPolicy, updateTaxPolicy, deleteTaxPolicy } from '@/services/taxPolicies';
import type { TaxPolicy } from '@/types/api';

const defaultTaxPolicies = [
  { level: 1, minAmount: 0, maxAmount: 3000, rate: 3, quickDeduction: 0 },
  { level: 2, minAmount: 3000, maxAmount: 12000, rate: 10, quickDeduction: 210 },
  { level: 3, minAmount: 12000, maxAmount: 25000, rate: 20, quickDeduction: 1410 },
  { level: 4, minAmount: 25000, maxAmount: 35000, rate: 25, quickDeduction: 2660 },
  { level: 5, minAmount: 35000, maxAmount: 55000, rate: 30, quickDeduction: 4410 },
  { level: 6, minAmount: 55000, maxAmount: 80000, rate: 35, quickDeduction: 7160 },
  { level: 7, minAmount: 80000, maxAmount: 999999999, rate: 45, quickDeduction: 15160 },
];

const TaxPolicyList = () => {
  const [data, setData] = useState<TaxPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<TaxPolicy | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await listTaxPolicies({ pageSize: 100 });
      if (res.items.length === 0) {
        // preload defaults
        for (const p of defaultTaxPolicies) {
          await createTaxPolicy({ name: `第${p.level}级`, ...p, effectiveDate: '2026-01-01' });
        }
        const reloaded = await listTaxPolicies({ pageSize: 100 });
        setData(reloaded.items);
      } else {
        setData(res.items);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        await updateTaxPolicy(editing.id, values);
        message.success('更新成功');
      } else {
        await createTaxPolicy(values);
        message.success('创建成功');
      }
      setModalVisible(false);
      fetchData();
    } catch {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteTaxPolicy(id);
      message.success('删除成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const columns = [
    { title: '级数', dataIndex: 'level', key: 'level' },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '下限', dataIndex: 'minAmount', key: 'minAmount', render: (v: number) => `¥${v}` },
    { title: '上限', dataIndex: 'maxAmount', key: 'maxAmount', render: (v: number) => `¥${v}` },
    { title: '税率', dataIndex: 'rate', key: 'rate', render: (v: number) => `${v}%` },
    { title: '速算扣除数', dataIndex: 'quickDeduction', key: 'quickDeduction', render: (v: number) => `¥${v}` },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: TaxPolicy) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => { setEditing(record); form.setFieldsValue(record); setModalVisible(true); }}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card title="个税政策" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModalVisible(true); }}>新增</Button>}>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading} pagination={false} />
      <Modal title={editing ? '编辑个税政策' : '新增个税政策'} open={modalVisible} onOk={handleSubmit} onCancel={() => setModalVisible(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="level" label="级数" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="minAmount" label="下限" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="maxAmount" label="上限" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="rate" label="税率" rules={[{ required: true }]}><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="quickDeduction" label="速算扣除数" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="effectiveDate" label="生效日期" rules={[{ required: true }]}><Input /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

export default TaxPolicyList;
