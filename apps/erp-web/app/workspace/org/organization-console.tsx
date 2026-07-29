'use client';

import { ApartmentOutlined, PlusOutlined, ReloadOutlined, UserAddOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tree,
  Typography,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createIdempotencyKey, ErpApiError, erpFetch } from '../../lib/api-client';

interface Department {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
  readonly parentId: string | null;
  readonly managerId: string | null;
  readonly sortOrder: number;
  readonly version: number;
}

interface Employee {
  readonly id: string;
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: 'probation' | 'active' | 'suspended' | 'terminated';
  readonly departmentIds: readonly string[];
  readonly primaryDepartmentId: string;
  readonly positionIds: readonly string[];
  readonly jobLevelId: string | null;
  readonly version: number;
}

interface OrgChart { readonly departments: readonly Department[]; readonly employees: readonly Employee[] }
interface DepartmentResult { readonly department: Department }
interface EmployeeResult { readonly employee: Employee }

/** ERP 组织主数据控制台；不展示或提交 tenantId，外部平台只消费服务端 Outbox。 */
export function OrganizationConsole() {
  const { message, modal } = AntApp.useApp();
  const [chart, setChart] = useState<OrgChart>({ departments: [], employees: [] });
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [departmentOpen, setDepartmentOpen] = useState(false);
  const [employeeOpen, setEmployeeOpen] = useState(false);
  const [error, setError] = useState<{ readonly message: string; readonly traceId: string | null } | null>(null);
  const [departmentForm] = Form.useForm();
  const [employeeForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await erpFetch<OrgChart>('/api/org/chart');
      setChart(result.data);
    } catch (value) {
      const apiError = value instanceof ErpApiError ? value : null;
      setError({ message: apiError?.message ?? '组织数据加载失败', traceId: apiError?.traceId ?? null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createDepartment = async (values: { readonly code: string; readonly name: string; readonly parentId?: string; readonly sortOrder?: number }) => {
    setWriting(true);
    try {
      await erpFetch<DepartmentResult>('/api/org/departments', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('org-department-create') },
        body: JSON.stringify({ ...values, status: 'active', parentId: values.parentId || null }),
      });
      setDepartmentOpen(false);
      departmentForm.resetFields();
      void message.success('部门已创建；下游同步由版本化 Outbox 接管');
      await load();
    } catch (value) {
      showError(modal, value, '部门创建失败');
    } finally {
      setWriting(false);
    }
  };

  const createEmployee = async (values: { readonly employeeNo: string; readonly displayName: string; readonly primaryDepartmentId: string; readonly status: Employee['status'] }) => {
    setWriting(true);
    try {
      await erpFetch<EmployeeResult>('/api/org/employees', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('org-employee-create') },
        body: JSON.stringify({ ...values, departmentIds: [values.primaryDepartmentId], positionIds: [] }),
      });
      setEmployeeOpen(false);
      employeeForm.resetFields();
      void message.success('员工主数据已创建');
      await load();
    } catch (value) {
      showError(modal, value, '员工创建失败');
    } finally {
      setWriting(false);
    }
  };

  const departmentNames = useMemo(() => new Map(chart.departments.map((item) => [item.id, item.name])), [chart.departments]);
  const tree = useMemo(() => buildTree(chart.departments), [chart.departments]);
  const employeeColumns: ColumnsType<Employee> = [
    { title: '工号', dataIndex: 'employeeNo', width: 140 },
    { title: '姓名', dataIndex: 'displayName', width: 160, render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    { title: '主部门', dataIndex: 'primaryDepartmentId', render: (value: string) => departmentNames.get(value) ?? '范围外部门' },
    { title: '状态', dataIndex: 'status', width: 120, render: (value: Employee['status']) => <Tag color={value === 'active' ? 'green' : value === 'terminated' ? 'default' : 'gold'}>{employeeStatus(value)}</Tag> },
    { title: '版本', dataIndex: 'version', width: 90, render: (value: number) => `v${value}` },
  ];

  const departmentOptions = chart.departments.filter((item) => item.status === 'active').map((item) => ({ value: item.id, label: `${item.name}（${item.code}）` }));

  return <main aria-labelledby="org-title" aria-busy={loading}>
    <Flex className="console-page-heading" justify="space-between" align="flex-end" gap={20} wrap>
      <div><Typography.Text type="secondary"><ApartmentOutlined /> Master Data Authority</Typography.Text><Typography.Title id="org-title" level={1}>组织主数据</Typography.Title><Typography.Paragraph>ERP 是组织与员工的唯一事实源；当前视图已按令牌中的部门范围裁剪。</Typography.Paragraph></div>
      <Space><Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void load(); }}>刷新</Button><Button icon={<PlusOutlined />} onClick={() => setDepartmentOpen(true)}>新建部门</Button><Button type="primary" icon={<UserAddOutlined />} disabled={chart.departments.length === 0} onClick={() => setEmployeeOpen(true)}>新建员工</Button></Space>
    </Flex>
    {error === null ? null : <Alert role="alert" className="console-alert" type="error" showIcon message={error.message} description={error.traceId === null ? '请检查数据范围授权。' : `追踪标识：${error.traceId}`} />}
    <Row gutter={[18, 18]} className="console-stat-row">
      <Col xs={12} md={6}><Card bordered={false}><Statistic title="可见部门" value={chart.departments.length} /></Card></Col>
      <Col xs={12} md={6}><Card bordered={false}><Statistic title="可见员工" value={chart.employees.length} /></Card></Col>
      <Col xs={12} md={6}><Card bordered={false}><Statistic title="在职员工" value={chart.employees.filter((item) => item.status === 'active').length} /></Card></Col>
      <Col xs={12} md={6}><Card bordered={false}><Statistic title="待转正" value={chart.employees.filter((item) => item.status === 'probation').length} /></Card></Col>
    </Row>
    <Row gutter={[18, 18]}>
      <Col xs={24} xl={8}><Card bordered={false} title="部门树" loading={loading}>{tree.length === 0 ? <Empty description="当前范围内没有部门" /> : <Tree treeData={tree} defaultExpandAll showLine />}</Card></Col>
      <Col xs={24} xl={16}><Card bordered={false} title="员工名录"><Table rowKey="id" columns={employeeColumns} dataSource={[...chart.employees]} loading={loading} pagination={{ pageSize: 10 }} scroll={{ x: 720 }} locale={{ emptyText: <Empty description="当前范围内没有员工" /> }} /></Card></Col>
    </Row>
    <Modal title="新建部门" open={departmentOpen} confirmLoading={writing} okText="创建" onCancel={() => setDepartmentOpen(false)} onOk={() => departmentForm.submit()} destroyOnHidden>
      <Alert type="info" showIcon message="主数据创建后不可由外部平台反向覆盖" className="console-modal-alert" />
      <Form form={departmentForm} layout="vertical" onFinish={(values: unknown) => {
        if (isDepartmentValues(values)) void createDepartment(values);
      }} initialValues={{ sortOrder: 0 }}>
        <Form.Item name="code" label="部门编码" rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u }]}><Input /></Form.Item>
        <Form.Item name="name" label="部门名称" rules={[{ required: true, max: 128 }]}><Input /></Form.Item>
        <Form.Item name="parentId" label="上级部门"><Select allowClear showSearch optionFilterProp="label" options={departmentOptions} /></Form.Item>
        <Form.Item name="sortOrder" label="排序"><InputNumber min={0} precision={0} className="console-full-width" /></Form.Item>
      </Form>
    </Modal>
    <Modal title="新建员工" open={employeeOpen} confirmLoading={writing} okText="创建" onCancel={() => setEmployeeOpen(false)} onOk={() => employeeForm.submit()} destroyOnHidden>
      <Form form={employeeForm} layout="vertical" onFinish={(values: unknown) => {
        if (isEmployeeValues(values)) void createEmployee(values);
      }} initialValues={{ status: 'probation' }}>
        <Form.Item name="employeeNo" label="工号" rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u }]}><Input /></Form.Item>
        <Form.Item name="displayName" label="显示姓名" rules={[{ required: true, max: 128 }]}><Input /></Form.Item>
        <Form.Item name="primaryDepartmentId" label="主部门" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={departmentOptions} /></Form.Item>
        <Form.Item name="status" label="初始状态" rules={[{ required: true }]}><Select options={[{ value: 'probation', label: '试用' }, { value: 'active', label: '在职' }]} /></Form.Item>
      </Form>
    </Modal>
  </main>;
}

function buildTree(departments: readonly Department[]): DataNode[] {
  const children = new Map<string | null, Department[]>();
  for (const department of departments) {
    const parentId = departments.some((item) => item.id === department.parentId) ? department.parentId : null;
    children.set(parentId, [...(children.get(parentId) ?? []), department]);
  }
  const visit = (parentId: string | null, seen: ReadonlySet<string>): DataNode[] => (children.get(parentId) ?? [])
    .filter((item) => !seen.has(item.id))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code))
    .map((item) => ({
      key: item.id,
      title: <Space><span>{item.name}</span><Typography.Text type="secondary">{item.code}</Typography.Text>{item.status === 'inactive' ? <Tag>停用</Tag> : null}</Space>,
      children: visit(item.id, new Set([...seen, item.id])),
    }));
  return visit(null, new Set());
}

function employeeStatus(value: Employee['status']): string {
  return { probation: '试用', active: '在职', suspended: '停用', terminated: '离职' }[value];
}

function showError(modal: ReturnType<typeof AntApp.useApp>['modal'], value: unknown, fallback: string): void {
  const error = value instanceof ErpApiError ? value : null;
  modal.error({ title: fallback, content: `${error?.message ?? fallback}${error?.traceId === null || error === null ? '' : `\n追踪标识：${error.traceId}`}` });
}

function isDepartmentValues(value: unknown): value is { readonly code: string; readonly name: string; readonly parentId?: string; readonly sortOrder?: number } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.code === 'string' && typeof record.name === 'string' &&
    (record.parentId === undefined || typeof record.parentId === 'string') &&
    (record.sortOrder === undefined || typeof record.sortOrder === 'number');
}

function isEmployeeValues(value: unknown): value is { readonly employeeNo: string; readonly displayName: string; readonly primaryDepartmentId: string; readonly status: Employee['status'] } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.employeeNo === 'string' && typeof record.displayName === 'string' &&
    typeof record.primaryDepartmentId === 'string' &&
    (record.status === 'probation' || record.status === 'active' || record.status === 'suspended' || record.status === 'terminated');
}
