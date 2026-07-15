import { useEffect, useState } from 'react';
import { Card, Table, Button, Modal, Form, Input, Select, message, Popconfirm, Space, Switch } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { listPayItems, createPayItem, updatePayItem, deletePayItem, testFormula } from '@/services/payItems';
import type { PayItem } from '@/types/api';

const PayItemList = () => {
  const [data, setData] = useState<PayItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<PayItem | null>(null);
  const [form] = Form.useForm();
  const [testResult, setTestResult] = useState<string>('');
  const [testing, setTesting] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await listPayItems({ pageSize: 100 });
      setData(res.items);
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
        await updatePayItem(editing.id, values);
        message.success('更新成功');
      } else {
        await createPayItem(values);
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
      await deletePayItem(id);
      message.success('删除成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const handleTestFormula = async () => {
    const formula = form.getFieldValue('formula');
    if (!formula) { message.warning('请输入公式'); return; }
    setTesting(true);
    try {
      const result = await testFormula(formula, { baseSalary: 10000, workDays: 21, actualWorkDays: 21 });
      setTestResult(`结果: ${result}`);
    } catch (err: any) {
      setTestResult(`错误: ${err.message}`);
    } finally {
      setTesting(false);
    }
  };

  const columns = [
    { title: '编码', dataIndex: 'code', key: 'code' },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '分类', dataIndex: 'category', key: 'category' },
    { title: '类型', dataIndex: 'type', key: 'type' },
    { title: '公式', dataIndex: 'formula', key: 'formula', ellipsis: true },
    { title: '默认值', dataIndex: 'defaultValue', key: 'defaultValue' },
    { title: '应税', dataIndex: 'isTaxable', key: 'isTaxable', render: (v: boolean) => <Switch checked={v} disabled /> },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: PayItem) => (
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
    <Card title="薪酬项目" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModalVisible(true); }}>新增</Button>}>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading} pagination={false} />
      <Modal title={editing ? '编辑薪酬项目' : '新增薪酬项目'} open={modalVisible} onOk={handleSubmit} onCancel={() => setModalVisible(false)} destroyOnClose width={600}>
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="编码" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="basic">基本</Select.Option>
              <Select.Option value="allowance">津贴</Select.Option>
              <Select.Option value="bonus">奖金</Select.Option>
              <Select.Option value="deduction">扣款</Select.Option>
              <Select.Option value="social">社保</Select.Option>
              <Select.Option value="tax">个税</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="fixed">固定</Select.Option>
              <Select.Option value="formula">公式</Select.Option>
              <Select.Option value="manual">手动</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="formula" label="公式">
            <Input.TextArea placeholder="支持变量如 baseSalary, workDays 等" />
          </Form.Item>
          <Button onClick={handleTestFormula} loading={testing} style={{ marginBottom: 8 }}>测试公式</Button>
          {testResult && <div style={{ color: testResult.startsWith('错误') ? 'red' : 'green' }}>{testResult}</div>}
          <Form.Item name="defaultValue" label="默认值"><Input type="number" /></Form.Item>
          <Form.Item name="isTaxable" label="应税" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

export default PayItemList;
