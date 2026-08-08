import { useEffect, useState } from 'react';
import { Card, Table, Button, Modal, Form, InputNumber, Input, message, Space, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CalculatorOutlined } from '@ant-design/icons';
import { listSIPolicies, createSIPolicy, updateSIPolicy, deleteSIPolicy, calculateSI } from '@/services/siPolicies';
import type { SIPolicy } from '@/types/api';

const SIPolicyList = () => {
  const [data, setData] = useState<SIPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [calcVisible, setCalcVisible] = useState(false);
  const [editing, setEditing] = useState<SIPolicy | null>(null);
  const [form] = Form.useForm();
  const [calcForm] = Form.useForm();
  const [calcResult, setCalcResult] = useState<Record<string, number> | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await listSIPolicies({ pageSize: 100 });
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
        await updateSIPolicy(editing.id, values);
        message.success('更新成功');
      } else {
        await createSIPolicy(values);
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
      await deleteSIPolicy(id);
      message.success('删除成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const handleCalculate = async () => {
    try {
      const values = await calcForm.validateFields();
      const res = await calculateSI(values.city, values.baseSalary);
      setCalcResult(res);
    } catch {
      // ignore
    }
  };

  const columns = [
    { title: '城市', dataIndex: 'city', key: 'city' },
    { title: '养老(个人)', dataIndex: 'pensionEmployeeRate', key: 'pensionEmployeeRate', render: (v: number) => `${v}%` },
    { title: '养老(单位)', dataIndex: 'pensionEmployerRate', key: 'pensionEmployerRate', render: (v: number) => `${v}%` },
    { title: '医疗(个人)', dataIndex: 'medicalEmployeeRate', key: 'medicalEmployeeRate', render: (v: number) => `${v}%` },
    { title: '医疗(单位)', dataIndex: 'medicalEmployerRate', key: 'medicalEmployerRate', render: (v: number) => `${v}%` },
    { title: '公积金(个人)', dataIndex: 'housingFundEmployeeRate', key: 'housingFundEmployeeRate', render: (v: number) => `${v}%` },
    { title: '公积金(单位)', dataIndex: 'housingFundEmployerRate', key: 'housingFundEmployerRate', render: (v: number) => `${v}%` },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: SIPolicy) => (
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
    <Card title="社保政策" extra={
      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModalVisible(true); }}>新增</Button>
        <Button icon={<CalculatorOutlined />} onClick={() => setCalcVisible(true)}>计算器</Button>
      </Space>
    }>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading} pagination={false} scroll={{ x: 1200 }} />
      <Modal title={editing ? '编辑社保政策' : '新增社保政策'} open={modalVisible} onOk={handleSubmit} onCancel={() => setModalVisible(false)} destroyOnClose width={800}>
        <Form form={form} layout="vertical">
          <Form.Item name="city" label="城市" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="pensionEmployeeRate" label="养老保险个人比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="pensionEmployerRate" label="养老保险单位比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="medicalEmployeeRate" label="医疗保险个人比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="medicalEmployerRate" label="医疗保险单位比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="unemploymentEmployeeRate" label="失业保险个人比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="unemploymentEmployerRate" label="失业保险单位比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="injuryEmployerRate" label="工伤保险单位比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="maternityEmployerRate" label="生育保险单位比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="housingFundEmployeeRate" label="公积金个人比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="housingFundEmployerRate" label="公积金单位比例"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>
      <Modal title="社保计算器" open={calcVisible} onCancel={() => setCalcVisible(false)} footer={null}>
        <Form form={calcForm} layout="vertical">
          <Form.Item name="city" label="城市" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="baseSalary" label="基本工资" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Button type="primary" onClick={handleCalculate}>计算</Button>
        </Form>
        {calcResult && (
          <div style={{ marginTop: 16 }}>
            <p>个人合计: ¥{calcResult.totalEmployee}</p>
            <p>单位合计: ¥{calcResult.totalEmployer}</p>
          </div>
        )}
      </Modal>
    </Card>
  );
};

export default SIPolicyList;
