'use client';

import {
  CheckCircleFilled,
  ContactsOutlined,
  DingdingOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createIdempotencyKey,
  ErpApiError,
  erpFetch,
  isDefinitiveWriteRejection,
} from '../../lib/api-client';
import { parseIdentityProfile, type IdentityProfileView } from '../../lib/approval-contract';
import {
  buildDingTalkProvisioningInput,
  canProvisionDingTalk,
  canReadDingTalkBindings,
  parseDingTalkBindings,
  parseProvisioningResult,
  type ProvisioningInput,
} from '../../lib/contacts-contract';
import { parseOrgChart, type Employee, type OrgChart } from '../../lib/org-contract';

interface ProvisioningFormValues {
  readonly countryCode: string;
  readonly subscriberNumber: string;
  readonly email?: string;
}

interface PendingProvisioning {
  readonly actorId: string;
  readonly input: ProvisioningInput;
  readonly key: string;
}

/**
 * Intent: 员工快速找到同事，HR 管理员在同一上下文完成钉钉开户；整体应像可信的企业名册。
 * Hierarchy: 搜索和部门范围是主操作，员工身份与钉钉状态次之，敏感开户动作只在行尾出现。
 * Palette: 延续 GaoQ 深蓝/雾白；钉钉蓝只表达平台绑定，绿色只表达已完成。
 * Depth: 使用现有工作台的轻阴影卡片与低对比边界，避免额外层级噪音。
 * Surfaces: 页面底色 → 通讯录工作台 → 员工行三级浅色表面。
 * Typography: 复用 Ant Design 字体，以 14px 基础字号配合字重和灰阶建立层级。
 * Spacing: 4px 基准，员工高频查找采用 12–20px 的紧凑密度。
 */
export function ContactsConsole() {
  const { message, modal } = AntApp.useApp();
  const [chart, setChart] = useState<OrgChart>({ departments: [], employees: [] });
  const [profile, setProfile] = useState<IdentityProfileView | null>(null);
  const [boundEmployeeIds, setBoundEmployeeIds] = useState<ReadonlySet<string>>(new Set());
  const [bindingStatusAvailable, setBindingStatusAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bindingWarning, setBindingWarning] = useState<string | null>(null);
  const [error, setError] = useState<{ readonly message: string; readonly traceId: string | null } | null>(null);
  const [query, setQuery] = useState('');
  const [departmentId, setDepartmentId] = useState<string>('all');
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingAttempt, setPendingAttempt] = useState<PendingProvisioning | null>(null);
  const [pendingEmployees, setPendingEmployees] = useState<ReadonlySet<string>>(new Set());
  const [form] = Form.useForm<ProvisioningFormValues>();
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setError(null);
    setBindingWarning(null);
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
      setBindingStatusAvailable(false);
      setBoundEmployeeIds(new Set());
      if (canReadDingTalkBindings(nextProfile.scopes)) {
        try {
          const result = await erpFetch<unknown>(
            '/api/integrations/org-provisioning-requests/bindings/dingtalk',
          );
          const bindings = parseDingTalkBindings(result.data);
          if (generation !== loadGeneration.current) return;
          setBoundEmployeeIds(new Set(bindings.boundEmployeeIds));
          setBindingStatusAvailable(true);
        } catch (value) {
          const apiError = value instanceof ErpApiError ? value : null;
          setBindingWarning(apiError?.message ?? '钉钉绑定状态暂时不可用');
        }
      }
    } catch (value) {
      if (generation !== loadGeneration.current) return;
      const apiError = value instanceof ErpApiError ? value : null;
      setError({
        message: apiError?.message ?? '通讯录加载失败',
        traceId: apiError?.traceId ?? null,
      });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (profile === null || pendingAttempt === null) return;
    if (profile.actorId !== pendingAttempt.actorId || !canProvisionDingTalk(profile.scopes)) {
      setPendingAttempt(null);
      setSelectedEmployee(null);
      form.resetFields();
    }
  }, [form, pendingAttempt, profile]);

  const departments = useMemo(() => [...chart.departments]
    .filter((department) => department.status === 'active')
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)), [chart]);
  const departmentNames = useMemo(
    () => new Map(chart.departments.map((department) => [department.id, department.name])),
    [chart],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const employees = useMemo(() => chart.employees.filter((employee) => {
    const inDepartment = departmentId === 'all' || employee.departmentIds.includes(departmentId);
    const text = `${employee.displayName} ${employee.employeeNo}`.toLocaleLowerCase('zh-CN');
    return inDepartment && (normalizedQuery.length === 0 || text.includes(normalizedQuery));
  }), [chart.employees, departmentId, normalizedQuery]);
  const canProvision = profile !== null && canProvisionDingTalk(profile.scopes);

  const executeProvisioning = async (attempt: PendingProvisioning) => {
    if (
      profile === null ||
      profile.actorId !== attempt.actorId ||
      !canProvisionDingTalk(profile.scopes)
    ) {
      setPendingAttempt(null);
      modal.error({ title: '身份授权已变化', content: '请刷新通讯录后重新发起绑定。' });
      return;
    }
    setSubmitting(true);
    try {
      const result = await erpFetch<unknown>('/api/integrations/org-provisioning-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': attempt.key },
        body: JSON.stringify(attempt.input),
      });
      parseProvisioningResult(result.data);
      setPendingEmployees((current) => new Set([...current, attempt.input.employeeId]));
      setPendingAttempt(null);
      setSelectedEmployee(null);
      form.resetFields();
      void message.success('钉钉开户已提交；后台完成后员工即可扫码登录');
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPendingAttempt(null);
      const apiError = value instanceof ErpApiError ? value : null;
      modal.error({
        title: '钉钉开户未完成',
        content: apiError?.traceId === null || apiError?.traceId === undefined
          ? apiError?.message ?? '请稍后重试'
          : `${apiError.message}（追踪标识：${apiError.traceId}）`,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const submitProvisioning = (values: ProvisioningFormValues) => {
    if (profile === null || selectedEmployee === null || !canProvision) return;
    const attempt = Object.freeze({
      actorId: profile.actorId,
      input: buildDingTalkProvisioningInput(selectedEmployee.id, values),
      key: createIdempotencyKey('dingtalk-provision'),
    });
    setPendingAttempt(attempt);
    void executeProvisioning(attempt);
  };

  return <main className="contacts-console" aria-labelledby="contacts-title" aria-busy={loading}>
    <header className="contacts-heading">
      <div>
        <Typography.Text className="eyebrow"><ContactsOutlined /> People Directory</Typography.Text>
        <Typography.Title id="contacts-title" level={1}>企业通讯录</Typography.Title>
        <Typography.Paragraph>
          组织关系由 ERP 统一维护，联系方式由钉钉安全托管；员工完成绑定后可使用钉钉扫码登录。
        </Typography.Paragraph>
      </div>
      <Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void load(); }}>刷新</Button>
    </header>

    {error === null ? null : <Alert
      role="alert"
      type="error"
      showIcon
      title={error.message}
      description={error.traceId === null ? '请检查通讯录读取权限。' : `追踪标识：${error.traceId}`}
      className="contacts-alert"
    />}
    {bindingWarning === null ? null : <Alert
      type="warning"
      showIcon
      title="通讯录可用，但钉钉绑定状态暂不可见"
      description={bindingWarning}
      className="contacts-alert"
    />}

    <section className="contacts-trust-strip" aria-label="通讯录信任边界">
      <span><SafetyCertificateOutlined /><strong>可信组织范围</strong><small>仅展示当前身份可见部门</small></span>
      <span><DingdingOutlined /><strong>钉钉企业绑定</strong><small>双标识核验后才允许登录</small></span>
      <span><TeamOutlined /><strong>{chart.employees.length}</strong><small>当前可见员工</small></span>
    </section>

    <section className="contacts-workbench">
      <aside className="contacts-departments" aria-label="部门筛选">
        <Typography.Text>部门</Typography.Text>
        <button
          type="button"
          className={departmentId === 'all' ? 'is-active' : ''}
          onClick={() => setDepartmentId('all')}
        ><span>全部同事</span><b>{chart.employees.length}</b></button>
        {departments.map((department) => <button
          type="button"
          key={department.id}
          className={departmentId === department.id ? 'is-active' : ''}
          onClick={() => setDepartmentId(department.id)}
        ><span>{department.name}</span><b>{chart.employees.filter((employee) =>
            employee.departmentIds.includes(department.id)).length}</b></button>)}
      </aside>

      <div className="contacts-list-panel">
        <div className="contacts-command-bar">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索姓名或工号"
            aria-label="搜索姓名或工号"
          />
          <Typography.Text type="secondary">{employees.length} 位同事</Typography.Text>
        </div>
        {loading ? <Skeleton active paragraph={{ rows: 8 }} className="contacts-skeleton" />
          : employees.length === 0 ? <Empty description="没有匹配的同事" className="contacts-empty" />
          : <ul className="contacts-list">
          {employees.map((employee) => {
            const bound = bindingStatusAvailable && boundEmployeeIds.has(employee.id);
            const pending = pendingEmployees.has(employee.id);
            const eligible = employee.status === 'active' || employee.status === 'probation';
            return <li className="contacts-list-item" key={employee.id}>
              <Avatar className="contacts-avatar">{initials(employee.displayName)}</Avatar>
              <div className="contacts-list-main">
                <Space wrap size={8}>
                  <Typography.Text strong>{employee.displayName}</Typography.Text>
                  <Tag bordered={false}>{employeeStatus(employee.status)}</Tag>
                </Space>
                <span className="contacts-meta">
                  <span>{departmentNames.get(employee.primaryDepartmentId) ?? '范围外部门'}</span>
                  <span>工号 {employee.employeeNo}</span>
                </span>
              </div>
              <div className="contacts-list-action">
                {bound ? <Tag icon={<CheckCircleFilled />} color="success">已绑定钉钉</Tag>
                  : pending ? <Tag color="processing">绑定处理中</Tag>
                    : canProvision && eligible ? <Button
                        icon={<DingdingOutlined />}
                        onClick={() => {
                          setSelectedEmployee(employee);
                          setPendingAttempt(null);
                          form.setFieldsValue({ countryCode: '+86' });
                        }}
                      >开通钉钉</Button> : null}
              </div>
            </li>;
          })}
        </ul>}
      </div>
    </section>

    <Modal
      open={selectedEmployee !== null}
      title={selectedEmployee === null ? '开通钉钉' : `为 ${selectedEmployee.displayName} 开通钉钉`}
      okText={pendingAttempt === null ? '提交开户' : '重试原请求'}
      confirmLoading={submitting}
      cancelButtonProps={{ disabled: pendingAttempt !== null || submitting }}
      closable={pendingAttempt === null && !submitting}
      keyboard={pendingAttempt === null && !submitting}
      mask={{ closable: pendingAttempt === null && !submitting }}
      onCancel={() => {
        setSelectedEmployee(null);
        form.resetFields();
      }}
      onOk={() => {
        if (pendingAttempt === null) form.submit();
        else void executeProvisioning(pendingAttempt);
      }}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        title="联系方式仅用于本次钉钉开户"
        description="提交后立即加密并在 15 分钟内擦除；不会进入员工主数据、日志或审计正文。"
        className="contacts-modal-alert"
      />
      {pendingAttempt === null ? null : <Alert
        type="warning"
        showIcon
        title="上次结果尚未确认"
        description="重试将复用完全相同的内容和幂等键，不会重复创建钉钉账号。"
        className="contacts-modal-alert"
      />}
      <Form<ProvisioningFormValues>
        form={form}
        layout="vertical"
        initialValues={{ countryCode: '+86' }}
        disabled={submitting || pendingAttempt !== null}
        onFinish={submitProvisioning}
      >
        <Form.Item name="countryCode" hidden><Input /></Form.Item>
        <Form.Item
          name="subscriberNumber"
          label="员工手机号"
          rules={[
            { required: true, message: '请输入员工手机号' },
            { pattern: /^[1-9]\d{5,14}$/u, message: '请输入不含国家区号的有效手机号' },
          ]}
        ><Input addonBefore="+86" inputMode="tel" autoComplete="off" maxLength={15} /></Form.Item>
        <Form.Item
          name="email"
          label="企业邮箱（可选）"
          rules={[{ type: 'email', message: '请输入有效邮箱' }, { max: 254 }]}
        ><Input inputMode="email" autoComplete="off" maxLength={254} /></Form.Item>
      </Form>
    </Modal>
  </main>;
}

function initials(name: string): string {
  return Array.from(name.trim()).slice(-2).join('').toLocaleUpperCase('zh-CN');
}

function employeeStatus(status: Employee['status']): string {
  return { probation: '试用', active: '在职', suspended: '暂停', terminated: '离职' }[status];
}
