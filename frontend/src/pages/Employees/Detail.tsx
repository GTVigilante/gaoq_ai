import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Tabs, Descriptions, Form, Input, Button, message, Table, Spin, Empty } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { getEmployee } from '@/services/employees';
import { listSalaryRecords } from '@/services/salaryRecords';
import { listAttendance } from '@/services/attendance';
import type { Employee, SalaryRecord, AttendanceRecord } from '@/types/api';

const EmployeeDetail = () => {
  const { id } = useParams<{ id: string }>();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [salaryRecords, setSalaryRecords] = useState<SalaryRecord[]>([]);
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!id) return;
    const fetch = async () => {
      setLoading(true);
      try {
        const [emp, sal, att] = await Promise.all([
          getEmployee(id),
          listSalaryRecords({ employeeId: id, pageSize: 12 }),
          listAttendance({ employeeId: id, pageSize: 12 }),
        ]);
        setEmployee(emp);
        setSalaryRecords(sal.items);
        setAttendanceRecords(att.items);
        form.setFieldsValue(emp);
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, [id]);

  const handleSave = async () => {
    if (!id) return;
    try {
      const values = await form.validateFields();
      const { updateEmployee } = await import('@/services/employees');
      await updateEmployee(id, values);
      message.success('保存成功');
    } catch {
      // ignore
    }
  };

  const salaryColumns = [
    { title: '年份', dataIndex: 'year', key: 'year' },
    { title: '月份', dataIndex: 'month', key: 'month' },
    { title: '应发', dataIndex: 'grossAmount', key: 'grossAmount', render: (v: number) => `¥${v}` },
    { title: '扣除', dataIndex: 'deductionAmount', key: 'deductionAmount', render: (v: number) => `¥${v}` },
    { title: '实发', dataIndex: 'netAmount', key: 'netAmount', render: (v: number) => `¥${v}` },
    { title: '状态', dataIndex: 'status', key: 'status' },
  ];

  const attendanceColumns = [
    { title: '年份', dataIndex: 'year', key: 'year' },
    { title: '月份', dataIndex: 'month', key: 'month' },
    { title: '应出勤', dataIndex: 'workDays', key: 'workDays' },
    { title: '实际出勤', dataIndex: 'actualWorkDays', key: 'actualWorkDays' },
    { title: '请假', dataIndex: 'leaveDays', key: 'leaveDays' },
    { title: '加班(小时)', dataIndex: 'overtimeHours', key: 'overtimeHours' },
    { title: '状态', dataIndex: 'status', key: 'status' },
  ];

  if (loading) return <Spin tip="加载中..." />;
  if (!employee) return <Empty description="员工不存在" />;

  return (
    <Card title={`${employee.name} - 员工详情`}>
      <Tabs
        items={[
          {
            key: 'basic',
            label: '基本信息',
            children: (
              <Form form={form} layout="vertical">
                <Descriptions bordered column={2}>
                  <Descriptions.Item label="工号">{employee.employeeNo}</Descriptions.Item>
                  <Descriptions.Item label="姓名">{employee.name}</Descriptions.Item>
                  <Descriptions.Item label="部门">{employee.departmentName}</Descriptions.Item>
                  <Descriptions.Item label="职位">{employee.position}</Descriptions.Item>
                  <Descriptions.Item label="入职日期">{employee.hireDate}</Descriptions.Item>
                  <Descriptions.Item label="状态">{employee.status}</Descriptions.Item>
                </Descriptions>
                <Form.Item name="phone" label="手机号" style={{ marginTop: 16 }}><Input /></Form.Item>
                <Form.Item name="email" label="邮箱"><Input /></Form.Item>
                <Form.Item name="bankAccount" label="银行卡号"><Input /></Form.Item>
                <Form.Item name="bankName" label="开户行"><Input /></Form.Item>
                <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>保存</Button>
              </Form>
            ),
          },
          {
            key: 'salary',
            label: '薪资记录',
            children: <Table columns={salaryColumns} dataSource={salaryRecords} rowKey="id" pagination={false} locale={{ emptyText: <Empty /> }} />,
          },
          {
            key: 'attendance',
            label: '考勤',
            children: <Table columns={attendanceColumns} dataSource={attendanceRecords} rowKey="id" pagination={false} locale={{ emptyText: <Empty /> }} />,
          },
        ]}
      />
    </Card>
  );
};

export default EmployeeDetail;
