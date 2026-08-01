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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createIdempotencyKey,
  ErpApiError,
  erpFetch,
  isDefinitiveWriteRejection,
} from '../../lib/api-client';
import {
  parseIdentityProfile,
  type IdentityProfileView,
} from '../../lib/approval-contract';
import {
  buildDepartmentCreateInput,
  buildEmployeeCreateInput,
  canExecuteOrgWrite,
  canWriteOrgMaster,
  parseDepartmentResult,
  parseEmployeeResult,
  parseOrgChart,
  type Department,
  type DepartmentCreateInput,
  type Employee,
  type EmployeeCreateInput,
  type OrgChart,
} from '../../lib/org-contract';

interface DepartmentFormValues {
  readonly code: string;
  readonly name: string;
  readonly parentId?: string;
  readonly sortOrder?: number;
}

interface EmployeeFormValues {
  readonly employeeNo: string;
  readonly displayName: string;
  readonly primaryDepartmentId: string;
  readonly status: EmployeeCreateInput['status'];
}

interface PendingWrite<T> {
  readonly actorId: string;
  readonly input: T;
  readonly key: string;
}

/** ERP 组织主数据控制台；不展示或提交 tenantId，外部平台只消费服务端 Outbox。 */
export function OrganizationConsole() {
  const { message, modal } = AntApp.useApp();
  const [chart, setChart] = useState<OrgChart>({ departments: [], employees: [] });
  const [profile, setProfile] = useState<IdentityProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [departmentOpen, setDepartmentOpen] = useState(false);
  const [employeeOpen, setEmployeeOpen] = useState(false);
  const [pendingDepartment, setPendingDepartment] =
    useState<PendingWrite<DepartmentCreateInput> | null>(null);
  const [pendingEmployee, setPendingEmployee] =
    useState<PendingWrite<EmployeeCreateInput> | null>(null);
  const [error, setError] = useState<{ readonly message: string; readonly traceId: string | null } | null>(null);
  const [departmentForm] = Form.useForm();
  const [employeeForm] = Form.useForm();
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setError(null);
    setChart({ departments: [], employees: [] });
    setProfile(null);
    try {
      const [chartResult, profileResult] = await Promise.all([
        erpFetch<unknown>('/api/org/chart'),
        erpFetch<unknown>('/api/auth/profile'),
      ]);
      const nextChart = parseOrgChart(chartResult.data);
      const nextProfile = parseIdentityProfile(profileResult.data);
      if (generation !== loadGeneration.current) return;
      setChart(nextChart);
      setProfile(nextProfile);
    } catch (value) {
      if (generation !== loadGeneration.current) return;
      const apiError = value instanceof ErpApiError ? value : null;
      setError({ message: apiError?.message ?? '组织数据加载失败', traceId: apiError?.traceId ?? null });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (profile === null) return;
    setPendingDepartment((current) =>
      current !== null && current.actorId !== profile.actorId ? null : current);
    setPendingEmployee((current) =>
      current !== null && current.actorId !== profile.actorId ? null : current);
  }, [profile]);

  const executeDepartment = async (attempt: PendingWrite<DepartmentCreateInput>) => {
    if (!canExecuteOrgWrite(profile, attempt.actorId)) {
      if (profile !== null) setPendingDepartment(null);
      modal.error({
        title: '身份授权已变化',
        content: profile === null ? '请先刷新并确认当前身份，再重试原请求。' : '原请求已清除，请按当前身份重新发起。',
      });
      return;
    }
    setWriting(true);
    try {
      const result = await erpFetch<unknown>('/api/org/departments', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': attempt.key },
        body: JSON.stringify(attempt.input),
      });
      parseDepartmentResult(result.data);
      setPendingDepartment(null);
      setDepartmentOpen(false);
      departmentForm.resetFields();
      void message.success('部门已创建；下游同步由版本化 Outbox 接管');
      await load();
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPendingDepartment(null);
      showWriteError(modal, value, '部门创建失败');
    } finally {
      setWriting(false);
    }
  };

  const createDepartment = async (values: DepartmentFormValues) => {
    if (profile === null || !canWriteOrgMaster(profile.scopes)) return;
    const attempt = Object.freeze({
      actorId: profile.actorId,
      input: buildDepartmentCreateInput(values),
      key: createIdempotencyKey('org-department-create'),
    });
    setPendingDepartment(attempt);
    await executeDepartment(attempt);
  };

  const executeEmployee = async (attempt: PendingWrite<EmployeeCreateInput>) => {
    if (!canExecuteOrgWrite(profile, attempt.actorId)) {
      if (profile !== null) setPendingEmployee(null);
      modal.error({
        title: '身份授权已变化',
        content: profile === null ? '请先刷新并确认当前身份，再重试原请求。' : '原请求已清除，请按当前身份重新发起。',
      });
      return;
    }
    setWriting(true);
    try {
      const result = await erpFetch<unknown>('/api/org/employees', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': attempt.key },
        body: JSON.stringify(attempt.input),
      });
      parseEmployeeResult(result.data);
      setPendingEmployee(null);
      setEmployeeOpen(false);
      employeeForm.resetFields();
      void message.success('员工主数据已创建');
      await load();
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPendingEmployee(null);
      showWriteError(modal, value, '员工创建失败');
    } finally {
      setWriting(false);
    }
  };

  const createEmployee = async (values: EmployeeFormValues) => {
    if (profile === null || !canWriteOrgMaster(profile.scopes)) return;
    const attempt = Object.freeze({
      actorId: profile.actorId,
      input: buildEmployeeCreateInput(values),
      key: createIdempotencyKey('org-employee-create'),
    });
    setPendingEmployee(attempt);
    await executeEmployee(attempt);
  };

  const canWrite = profile !== null && canWriteOrgMaster(profile.scopes);
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
      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void load(); }}>刷新</Button>
        {canWrite ? <Button icon={<PlusOutlined />} onClick={() => setDepartmentOpen(true)}>新建部门</Button> : null}
        {canWrite ? <Button type="primary" icon={<UserAddOutlined />} disabled={chart.departments.length === 0} onClick={() => setEmployeeOpen(true)}>新建员工</Button> : null}
      </Space>
    </Flex>
    {error === null ? null : <Alert role="alert" className="console-alert" type="error" showIcon message={error.message} description={error.traceId === null ? '请检查数据范围授权。' : `追踪标识：${error.traceId}`} />}
    {!loading && profile !== null && !canWrite ? <Alert className="console-alert" type="info" showIcon message="当前身份仅可查看组织主数据" description="创建入口需要 erp:org:master:write Scope。" /> : null}
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
    <Modal
      title="新建部门"
      open={departmentOpen}
      confirmLoading={writing}
      okText={pendingDepartment === null ? '创建' : '重试原请求'}
      cancelButtonProps={{ disabled: pendingDepartment !== null || writing }}
      closable={pendingDepartment === null && !writing}
      keyboard={pendingDepartment === null && !writing}
      maskClosable={pendingDepartment === null && !writing}
      onCancel={() => setDepartmentOpen(false)}
      onOk={() => {
        if (pendingDepartment === null) departmentForm.submit();
        else void executeDepartment(pendingDepartment);
      }}
      destroyOnHidden
    >
      <Alert type="info" showIcon message="主数据创建后不可由外部平台反向覆盖" className="console-modal-alert" />
      {pendingDepartment === null ? null : <Alert type="warning" showIcon message="上次结果尚未确认" description="重试会复用完全相同的请求内容和幂等键，不会创建第二条主数据。" className="console-modal-alert" />}
      <Form form={departmentForm} layout="vertical" disabled={writing || pendingDepartment !== null} onFinish={(values: unknown) => {
        if (isDepartmentValues(values)) void createDepartment(values);
      }} initialValues={{ sortOrder: 0 }}>
        <Form.Item name="code" label="部门编码" rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u }]}><Input /></Form.Item>
        <Form.Item name="name" label="部门名称" rules={[{ required: true, max: 128 }]}><Input /></Form.Item>
        <Form.Item name="parentId" label="上级部门"><Select allowClear showSearch optionFilterProp="label" options={departmentOptions} /></Form.Item>
        <Form.Item name="sortOrder" label="排序"><InputNumber min={0} precision={0} className="console-full-width" /></Form.Item>
      </Form>
    </Modal>
    <Modal
      title="新建员工"
      open={employeeOpen}
      confirmLoading={writing}
      okText={pendingEmployee === null ? '创建' : '重试原请求'}
      cancelButtonProps={{ disabled: pendingEmployee !== null || writing }}
      closable={pendingEmployee === null && !writing}
      keyboard={pendingEmployee === null && !writing}
      maskClosable={pendingEmployee === null && !writing}
      onCancel={() => setEmployeeOpen(false)}
      onOk={() => {
        if (pendingEmployee === null) employeeForm.submit();
        else void executeEmployee(pendingEmployee);
      }}
      destroyOnHidden
    >
      {pendingEmployee === null ? null : <Alert type="warning" showIcon message="上次结果尚未确认" description="重试会复用完全相同的请求内容和幂等键，不会创建第二条主数据。" className="console-modal-alert" />}
      <Form form={employeeForm} layout="vertical" disabled={writing || pendingEmployee !== null} onFinish={(values: unknown) => {
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

function showWriteError(
  modal: ReturnType<typeof AntApp.useApp>['modal'],
  value: unknown,
  fallback: string,
): void {
  const error = value instanceof ErpApiError ? value : null;
  const uncertain = !isDefinitiveWriteRejection(value);
  modal.error({
    title: uncertain ? '请求结果尚未确认' : fallback,
    content: `${error?.message ?? fallback}${error?.traceId === null || error === null ? '' : `\n追踪标识：${error.traceId}`}${uncertain ? '\n请使用“重试原请求”，系统将复用相同幂等键。' : ''}`,
  });
}

function isDepartmentValues(value: unknown): value is DepartmentFormValues {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.code === 'string' && typeof record.name === 'string' &&
    (record.parentId === undefined || typeof record.parentId === 'string') &&
    (record.sortOrder === undefined || typeof record.sortOrder === 'number');
}

function isEmployeeValues(value: unknown): value is EmployeeFormValues {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.employeeNo === 'string' && typeof record.displayName === 'string' &&
    typeof record.primaryDepartmentId === 'string' &&
    (record.status === 'probation' || record.status === 'active');
}
