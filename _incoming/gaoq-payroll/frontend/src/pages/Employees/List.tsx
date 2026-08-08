import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Button, Input, Select, Space, Modal, Form, message, Card, Popconfirm } from 'antd';
import { PlusOutlined, SearchOutlined, ImportOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { listEmployees, deleteEmployee } from '@/services/employees';
import { listDepartments } from '@/services/departments';
import type { Employee, Department } from '@/types/api';

const { Option } = Select;

const EmployeesList = () => {
  const [data, setData] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [form] = Form.useForm();
  const navigate = useNavigate();

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await listEmployees({
        page,
        pageSize,
        search,
        departmentId: deptFilter,
        status: statusFilter,
      });
      setData(res.items);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  };

  const fetchDepartments = async () => {
    try {
      const res = await listDepartments();
      setDepartments(res);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchDepartments();
  }, []);

  useEffect(() => {
    fetchData();
  }, [page, pageSize, search, deptFilter, statusFilter]);

  const handleDelete = async (id: string) => {
    try {
      await deleteEmployee(id);
      message.success('删除成功');
      fetchData();
    } catch {
      // ignore
    }
  };

  const handleAdd = () => {
    setEditing(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record: Employee) => {
    setEditing(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        const { updateEmployee } = await import('@/services/employees');
        await updateEmployee(editing.id, values);
        message.success('更新成功');
      } else {
        const { createEmployee } = await import('@/services/employees');
        await createEmployee(values);
        message.success('创建成功');
      }
      setModalVisible(false);
      fetchData();
    } catch {
      // ignore
    }
  };

  const columns = [
    { title: '工号', dataIndex: 'employeeNo', key: 'employeeNo' },
    { title: '姓名', dataIndex: 'name', key: 'name' },
    { title: '部门', dataIndex: 'departmentName', key: 'departmentName' },
    { title: '职位', dataIndex: 'position', key: 'position' },
    { title: '手机号', dataIndex: 'phone', key: 'phone' },
    { title: '基本工资', dataIndex: 'baseSalary', key: 'baseSalary', render: (v: number) => `¥${v}` },
    { title: '状态', dataIndex: 'status', key: 'status' },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: Employee) => (
        <Space>
          <Button type="link" onClick={() => navigate(`/employees/${record.id}`)}>查看</Button>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card title="员工管理">
        <Space style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap' }}>
          <Input placeholder="搜索姓名/工号" prefix={<SearchOutlined />} value={search} onChange={(e) => setSearch(e.target.value)} allowClear />
          <Select placeholder="部门" allowClear value={deptFilter} onChange={setDeptFilter} style={{ width: 150 }}>
            {departments.map((d) => <Option key={d.id} value={d.id}>{d.name}</Option>)}
          </Select>
          <Select placeholder="状态" allowClear value={statusFilter} onChange={setStatusFilter} style={{ width: 120 }}>
            <Option value="active">在职</Option>
            <Option value="inactive">离职</Option>
            <Option value="terminated">辞退</Option>
          </Select>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增</Button>
          <Button icon={<ImportOutlined />} onClick={() => navigate('/employees/import')}>导入</Button>
        </Space>
        <Table
          columns={columns}
          dataSource={data}
          rowKey="id"
          loading={loading}
          pagination={{ total, pageSize, current: page, onChange: (p, ps) => { setPage(p); setPageSize(ps || 10); } }}
        />
      </Card>
      <Modal title={editing ? '编辑员工' : '新增员工'} open={modalVisible} onOk={handleSubmit} onCancel={() => setModalVisible(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="employeeNo" label="工号" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="departmentId" label="部门" rules={[{ required: true }]}>
            <Select>
              {departments.map((d) => <Option key={d.id} value={d.id}>{d.name}</Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="position" label="职位" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="idCard" label="身份证号"><Input /></Form.Item>
          <Form.Item name="phone" label="手机号"><Input /></Form.Item>
          <Form.Item name="email" label="邮箱"><Input /></Form.Item>
          <Form.Item name="bankAccount" label="银行卡号"><Input /></Form.Item>
          <Form.Item name="bankName" label="开户行"><Input /></Form.Item>
          <Form.Item name="baseSalary" label="基本工资" rules={[{ required: true }]}><Input type="number" /></Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select>
              <Option value="active">在职</Option>
              <Option value="inactive">离职</Option>
              <Option value="terminated">辞退</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default EmployeesList;
