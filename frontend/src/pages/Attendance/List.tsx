import { useEffect, useState } from 'react';
import { Card, Table, Button, Modal, Form, InputNumber, Select, message, Space, Popconfirm, Tag } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ImportOutlined } from '@ant-design/icons';
import { listAttendance, createAttendance, updateAttendance, deleteAttendance } from '@/services/attendance';
import { listEmployees } from '@/services/employees';
import ExcelUploader from '@/components/ExcelUploader';
import type { AttendanceRecord, Employee } from '@/types/api';

const AttendanceList = () => {
  const [data, setData] = useState<AttendanceRecord[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [importVisible, setImportVisible] = useState(false);
  const [editing, setEditing] = useState<AttendanceRecord | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const [records, emps] = await Promise.all([
        listAttendance({ pageSize: 100 }),
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
        await updateAttendance(editing.id, values);
        message.success('更新成功');
      } else {
        await createAttendance(values);
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
      await deleteAttendance(id);
      message.success('删除成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'confirmed': return 'green';
      case 'adjusted': return 'blue';
      default: return 'orange';
    }
  };

  const columns = [
    { title: '员工', dataIndex: 'employeeName', key: 'employeeName' },
    { title: '年份', dataIndex: 'year', key: 'year' },
    { title: '月份', dataIndex: 'month', key: 'month' },
    { title: '应出勤', dataIndex: 'workDays', key: 'workDays' },
    { title: '实际出勤', dataIndex: 'actualWorkDays', key: 'actualWorkDays' },
    { title: '请假', dataIndex: 'leaveDays', key: 'leaveDays' },
    { title: '病假', dataIndex: 'sickLeaveDays', key: 'sickLeaveDays' },
    { title: '事假', dataIndex: 'personalLeaveDays', key: 'personalLeaveDays' },
    { title: '旷工', dataIndex: 'absentDays', key: 'absentDays' },
    { title: '加班(小时)', dataIndex: 'overtimeHours', key: 'overtimeHours' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (v: string) => <Tag color={statusColor(v)}>{v}</Tag> },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: AttendanceRecord) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => { setEditing(record); form.setFieldsValue(record); setModalVisible(true); }}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const templateColumns = [
    { title: 'employeeId', dataIndex: 'employeeId', key: 'employeeId' },
    { title: 'year', dataIndex: 'year', key: 'year' },
    { title: 'month', dataIndex: 'month', key: 'month' },
    { title: 'workDays', dataIndex: 'workDays', key: 'workDays' },
    { title: 'actualWorkDays', dataIndex: 'actualWorkDays', key: 'actualWorkDays' },
    { title: 'leaveDays', dataIndex: 'leaveDays', key: 'leaveDays' },
    { title: 'overtimeHours', dataIndex: 'overtimeHours', key: 'overtimeHours' },
  ];

  const templateData = [{ employeeId: '', year: 2026, month: 1, workDays: 21, actualWorkDays: 21, leaveDays: 0, overtimeHours: 0 }];

  return (
    <Card title="考勤管理" extra={
      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModalVisible(true); }}>新增</Button>
        <Button icon={<ImportOutlined />} onClick={() => setImportVisible(true)}>导入</Button>
      </Space>
    }>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading} pagination={false} />
      <Modal title={editing ? '编辑考勤' : '新增考勤'} open={modalVisible} onOk={handleSubmit} onCancel={() => setModalVisible(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="employeeId" label="员工" rules={[{ required: true }]}>
            <Select>
              {employees.map((e) => <Select.Option key={e.id} value={e.id}>{e.name}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="year" label="年份" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="month" label="月份" rules={[{ required: true }]}><InputNumber min={1} max={12} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="workDays" label="应出勤天数"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="actualWorkDays" label="实际出勤天数"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="leaveDays" label="请假天数"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="sickLeaveDays" label="病假天数"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="personalLeaveDays" label="事假天数"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="absentDays" label="旷工天数"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="overtimeHours" label="加班小时"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="draft">草稿</Select.Option>
              <Select.Option value="confirmed">已确认</Select.Option>
              <Select.Option value="adjusted">已调整</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
      <Modal title="导入考勤" open={importVisible} onCancel={() => setImportVisible(false)} footer={null}>
        <ExcelUploader<Record<string, unknown>> columns={templateColumns} onUpload={async (data) => {
          const { importAttendance } = await import('@/services/attendance');
          const res = await importAttendance(data as any);
          message.success(`成功导入 ${res.imported} 条记录`);
          setImportVisible(false);
          fetchData();
        }} templateData={templateData} templateFilename="attendance_template.xlsx" />
      </Modal>
    </Card>
  );
};

export default AttendanceList;
