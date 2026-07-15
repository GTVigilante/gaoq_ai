import { useEffect, useState } from 'react';
import { Card, Table, Button, Modal, Form, Input, Select, message, Space, InputNumber } from 'antd';
import { PlusOutlined, EditOutlined } from '@ant-design/icons';
import { listSalaryRecords, createSalaryRecord, updateSalaryRecord } from '@/services/salaryRecords';
import { listEmployees } from '@/services/employees';
import type { SalaryRecord, Employee } from '@/types/api';

const SalaryRecordList = () => {
  const [data, setData] = useState<SalaryRecord[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<SalaryRecord | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const [records, emps] = await Promise.all([
        listSalaryRecords({ pageSize: 100 }),
        listEmployees({ pageSize: 1000 }),
      ]);
      setData(records.items);
      setEmployees(emps.items);
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
        await updateSalaryRecord(editing.id, values);
        message.success('更新成功');
      } else {
        await createSalaryRecord(values);
        message.success('创建成功');
      }
      setModalVisible(false);
      fetchData();
    } catch {
      // ignore
    }
  };

  const columns = [
    { title: '员工', dataIndex: 'employeeName', key: 'employeeName' },
    { title: '年份', dataIndex: 'year', key: 'year' },
    { title: '月份', dataIndex: 'month', key: 'month' },
    { title: '应发', dataIndex: 'grossAmount', key: 'grossAmount', render: (v: number) => `¥${v}` },
    { title: '扣除', dataIndex: 'deductionAmount', key: 'deductionAmount', render: (v: number) => `¥${v}` },
    { title: '实发', dataIndex: 'netAmount', key: 'netAmount', render: (v: number) => `¥${v}` },
    { title: '状态', dataIndex: 'status', key: 'status' },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: SalaryRecord) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => { setEditing(record); form.setFieldsValue(record); setModalVisible(true); }}>编辑</Button>
        </Space>
      ),
    },
  ];

  return (
    <Card title="薪资记录" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModalVisible(true); }}>新增</Button>}>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading} pagination={false} />
      <Modal title={editing ? '编辑薪资记录' : '新增薪资记录'} open={modalVisible} onOk={handleSubmit} onCancel={() => setModalVisible(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="employeeId" label="员工" rules={[{ required: true }]}>
            <Select>
              {employees.map((e) => <Select.Option key={e.id} value={e.id}>{e.name}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="year" label="年份" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="month" label="月份" rules={[{ required: true }]}><InputNumber min={1} max={12} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="grossAmount" label="应发金额" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="deductionAmount" label="扣除金额"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="netAmount" label="实发金额" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="draft">草稿</Select.Option>
              <Select.Option value="confirmed">已确认</Select.Option>
              <Select.Option value="paid">已发放</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

export default SalaryRecordList;
