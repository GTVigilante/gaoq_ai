'use client';

import {
  CheckCircleOutlined, ClockCircleOutlined, DollarOutlined, FileDoneOutlined,
  PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, SendOutlined,
} from '@ant-design/icons';
import {
  Alert, Button, Card, Empty, Form, Input, List, Modal, Select, Skeleton, Space,
  Statistic, Tabs, Tag, Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createIdempotencyKey, erpFetch, getBrowserSession, isDefinitiveWriteRejection, strongEtag,
  type BrowserSessionSnapshot,
} from '../../lib/api-client';
import { formatCnyMinor, yuanToMinor } from '../../lib/money';
import {
  parseEngagementOperationsSearch, parseEngagementOperationsWrite,
  parsePayableOperationsSearch, parsePayableOperationsWrite,
  type EngagementOperationsView, type PayableOperationsView,
} from '../../lib/supplier-operations-contract';

const { Title, Paragraph, Text } = Typography;
const ENGAGEMENT_LABEL = {
  draft: '草稿', pending_approval: '待审批', pending_signature: '待签署', active: '履约中',
  delivered: '待验收', accepted: '已验收', disputed: '争议中', cancelled: '已取消',
} as const;
const PAYABLE_LABEL = {
  prepared: '待提交', pending_approval: '待财务审批', approved: '待付款指令',
  submitted: '支付处理中', paid: '已支付', failed: '支付失败', frozen: '已冻结',
} as const;
const STATUS_COLOR: Readonly<Record<string, string>> = {
  active: 'blue', delivered: 'gold', accepted: 'green', paid: 'green',
  pending_approval: 'gold', pending_signature: 'purple', approved: 'cyan',
  submitted: 'blue', disputed: 'red', failed: 'red', frozen: 'volcano', cancelled: 'default',
};

type ActionKind = 'create_engagement' | 'engagement_submit' | 'engagement_approve' |
  'engagement_activate' | 'engagement_accept' | 'materialize_payable' | 'payable_submit' |
  'payable_approve' | 'payable_bind' | 'payable_settle';
interface ActionState { readonly kind: ActionKind; readonly engagement?: EngagementOperationsView; readonly payable?: PayableOperationsView }
interface ActionForm {
  readonly sourcingRequestId?: string; readonly performerRefs?: string; readonly evidenceRef?: string;
  readonly withholdingYuan?: string; readonly taxTreatmentCode?: string;
  readonly treasuryInstructionRef?: string; readonly outcome?: 'paid' | 'failed' | 'frozen';
  readonly failureCode?: string;
}
interface PendingWrite {
  readonly label: string; readonly path: string; readonly method: 'POST';
  readonly key: string; readonly scope: string; readonly version?: number;
  readonly body?: Readonly<Record<string, unknown>>; readonly parser: 'engagement' | 'payable';
}

/** 供应方履约与应付的统一运营台；所有权限、版本和终态仍由服务端裁决。 */
export function FulfillmentConsole() {
  const [engagements, setEngagements] = useState<readonly EngagementOperationsView[]>([]);
  const [payables, setPayables] = useState<readonly PayableOperationsView[]>([]);
  const [session, setSession] = useState<BrowserSessionSnapshot | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ActionForm>();

  const load = useCallback(async () => {
    setState('loading'); setError(null);
    try {
      const browser = await getBrowserSession();
      const canReadEngagements = browser.scopes.includes('erp:engagement:management:read');
      const canReadPayables = browser.scopes.includes('erp:payables:management:read');
      const [engagementResult, payableResult] = await Promise.all([
        canReadEngagements ? erpFetch<unknown>('/api/engagements?limit=100') : Promise.resolve(null),
        canReadPayables ? erpFetch<unknown>('/api/payables?limit=100') : Promise.resolve(null),
      ]);
      if (!canReadEngagements && !canReadPayables) throw new Error('FULFILLMENT_WORKSPACE_SCOPE_MISSING');
      setSession(browser);
      setEngagements(engagementResult === null ? [] : parseEngagementOperationsSearch(engagementResult.data).items);
      setPayables(payableResult === null ? [] : parsePayableOperationsSearch(payableResult.data).items);
      setState('ready');
    } catch (value) { setState('error'); setError(message(value, '履约与结算工作台暂时不可用')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const metrics = useMemo(() => ({
    active: engagements.filter((item) => item.status === 'active').length,
    acceptance: engagements.filter((item) => item.status === 'delivered').length,
    payable: payables.filter((item) => ['prepared', 'pending_approval', 'approved', 'submitted'].includes(item.status)).length,
    paid: payables.filter((item) => item.status === 'paid').reduce((sum, item) => sum + BigInt(item.netAmountMinor), 0n).toString(),
  }), [engagements, payables]);
  const has = (scope: string) => session?.scopes.includes(scope) === true;

  async function execute(request: PendingWrite): Promise<void> {
    if (!has(request.scope)) { setPending(null); setError('当前授权已变化，原操作已清除。'); return; }
    setSaving(true); setError(null);
    try {
      const result = await erpFetch<unknown>(request.path, {
        method: request.method,
        headers: {
          'idempotency-key': request.key,
          ...(request.version === undefined ? {} : { 'if-match': strongEtag(request.version) }),
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      if (request.parser === 'engagement') parseEngagementOperationsWrite(result.data);
      else parsePayableOperationsWrite(result.data);
      setPending(null); setAction(null); form.resetFields(); await load();
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPending(null);
      setError(isDefinitiveWriteRejection(value) ? message(value, `${request.label}失败`) : `${request.label}结果尚未确认；可使用原幂等编号重试。`);
    } finally { setSaving(false); }
  }

  async function submitAction(values: ActionForm): Promise<void> {
    if (action === null || pending !== null) return;
    const request = buildRequest(action, values);
    if (!has(request.scope)) { setError('当前身份没有执行此操作的权限。'); return; }
    setPending(request); await execute(request);
  }

  function open(next: ActionState): void {
    form.resetFields();
    if (next.kind === 'payable_settle') form.setFieldsValue({ outcome: 'paid' });
    setAction(next);
  }

  return <main className="fulfillment-console" aria-labelledby="fulfillment-title" aria-busy={state === 'loading'}>
    <header className="supplier-heading">
      <div><Text className="supplier-eyebrow"><FileDoneOutlined /> SERVICE OPERATIONS</Text><Title id="fulfillment-title" level={1}>履约与结算</Title><Paragraph>从选定到签署、交付、验收和支付，全程保留独立状态与证据，不建立钱包余额。</Paragraph></div>
      <Space><Button icon={<ReloadOutlined />} loading={state === 'loading'} onClick={() => { void load(); }}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!has('erp:engagement:management:write')} onClick={() => open({ kind: 'create_engagement' })}>建立履约委托</Button></Space>
    </header>
    {error === null ? null : <Alert type="error" showIcon title={error} action={pending === null ? undefined : <Button size="small" onClick={() => { void execute(pending); }}>按原编号重试</Button>} />}
    <section className="fulfillment-metrics">
      <Card><Statistic title="履约中" value={metrics.active} prefix={<ClockCircleOutlined />} /></Card>
      <Card><Statistic title="待验收" value={metrics.acceptance} prefix={<CheckCircleOutlined />} /></Card>
      <Card><Statistic title="结算处理中" value={metrics.payable} prefix={<SendOutlined />} /></Card>
      <Card><Statistic title="已支付净额" value={formatCnyMinor(metrics.paid)} prefix={<DollarOutlined />} /></Card>
    </section>
    {state === 'loading' ? <Skeleton active paragraph={{ rows: 10 }} /> : <Tabs items={[
      { key: 'engagements', label: `履约委托 ${engagements.length}`, children: <OperationsList empty="暂无履约委托" items={engagements.map((item) => ({
        key: item.id, title: item.engagementNumber, amount: formatCnyMinor(item.agreedAmountMinor),
        subtitle: `${item.serviceCategoryCode} · 供应方 ${item.supplierId.slice(-8)}`,
        status: ENGAGEMENT_LABEL[item.status], color: STATUS_COLOR[item.status] ?? 'default',
        detail: `${item.performerRefs.length} 位履约者 · ${item.deliveries.length} 次交付 · 版本 ${item.version}`,
        actions: engagementActions(item, has, open),
      }))} /> },
      { key: 'payables', label: `应付事项 ${payables.length}`, children: <OperationsList empty="暂无应付事项" items={payables.map((item) => ({
        key: item.id, title: item.payableNumber, amount: formatCnyMinor(item.netAmountMinor),
        subtitle: `含税 ${formatCnyMinor(item.grossAmountMinor)} · 扣缴 ${formatCnyMinor(item.withholdingAmountMinor)}`,
        status: PAYABLE_LABEL[item.status], color: STATUS_COLOR[item.status] ?? 'default',
        detail: `${item.taxTreatmentCode} · 版本 ${item.version}`,
        actions: payableActions(item, has, open),
      }))} /> },
    ]} />}
    <Modal open={action !== null} title={action === null ? '' : actionTitle(action.kind)} okText="确认提交" cancelText="取消" confirmLoading={saving} onCancel={() => setAction(null)} onOk={() => form.submit()} destroyOnHidden>
      <Alert type="info" showIcon title="系统将校验权限、强版本、幂等键及当前业务状态。" icon={<SafetyCertificateOutlined />} />
      <Form form={form} layout="vertical" onFinish={(values) => { void submitAction(values); }} style={{ marginTop: 16 }}>
        {action === null ? null : <ActionFields action={action} />}
      </Form>
    </Modal>
  </main>;
}

function OperationsList({ items, empty }: { readonly items: readonly { readonly key: string; readonly title: string; readonly amount: string; readonly subtitle: string; readonly status: string; readonly color: string; readonly detail: string; readonly actions: React.ReactNode }[]; readonly empty: string }) {
  if (items.length === 0) return <Empty description={empty} />;
  return <List className="fulfillment-list" dataSource={[...items]} renderItem={(item) => <List.Item actions={[item.actions]}><List.Item.Meta title={<Space><strong>{item.title}</strong><Tag color={item.color}>{item.status}</Tag></Space>} description={<><Text>{item.subtitle}</Text><br /><Text type="secondary">{item.detail}</Text></>} /><Text strong>{item.amount}</Text></List.Item>} />;
}

function engagementActions(item: EngagementOperationsView, has: (scope: string) => boolean, open: (action: ActionState) => void): React.ReactNode {
  if (item.status === 'draft' && has('erp:engagement:management:write')) return <Button onClick={() => open({ kind: 'engagement_submit', engagement: item })}>提交审批</Button>;
  if (item.status === 'pending_approval' && has('erp:engagement:management:decide')) return <Button type="primary" onClick={() => open({ kind: 'engagement_approve', engagement: item })}>批准并发起签署</Button>;
  if (item.status === 'pending_signature' && has('erp:engagement:management:decide')) return <Button type="primary" onClick={() => open({ kind: 'engagement_activate', engagement: item })}>登记签署回执</Button>;
  if (item.status === 'delivered' && has('erp:engagement:management:accept')) return <Button type="primary" onClick={() => open({ kind: 'engagement_accept', engagement: item })}>验收交付</Button>;
  if (item.status === 'accepted' && has('erp:payables:materialize')) return <Button onClick={() => open({ kind: 'materialize_payable', engagement: item })}>形成应付</Button>;
  return <Text type="secondary">暂无待办</Text>;
}

function payableActions(item: PayableOperationsView, has: (scope: string) => boolean, open: (action: ActionState) => void): React.ReactNode {
  if (item.status === 'prepared' && has('erp:payables:management:write')) return <Button onClick={() => open({ kind: 'payable_submit', payable: item })}>提交财务审批</Button>;
  if (item.status === 'pending_approval' && has('erp:payables:management:decide')) return <Button type="primary" onClick={() => open({ kind: 'payable_approve', payable: item })}>批准并发起付款</Button>;
  if (item.status === 'approved' && has('erp:payables:treasury:bind')) return <Button onClick={() => open({ kind: 'payable_bind', payable: item })}>绑定付款指令</Button>;
  if (item.status === 'submitted' && has('erp:payables:treasury:settle')) return <Button type="primary" onClick={() => open({ kind: 'payable_settle', payable: item })}>登记支付结果</Button>;
  return <Text type="secondary">暂无待办</Text>;
}

function ActionFields({ action }: { readonly action: ActionState }) {
  if (action.kind === 'create_engagement') return <><Form.Item name="sourcingRequestId" label="已选定寻源需求 ID" rules={[{ required: true, pattern: /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/ }]}><Input /></Form.Item><Form.Item name="performerRefs" label="履约者引用（逗号分隔）" rules={[{ required: true }]}><Input placeholder="person-001, person-002" /></Form.Item></>;
  if (['engagement_approve', 'engagement_activate', 'engagement_accept', 'payable_approve'].includes(action.kind)) return <Form.Item name="evidenceRef" label="证据引用" rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ }]}><Input /></Form.Item>;
  if (action.kind === 'materialize_payable') return <><Form.Item name="withholdingYuan" label="代扣金额（元）" rules={[{ required: true, pattern: /^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/ }]}><Input inputMode="decimal" /></Form.Item><Form.Item name="taxTreatmentCode" label="税务处理编码" rules={[{ required: true, pattern: /^[a-z][a-z0-9_.:-]{1,63}$/ }]}><Input placeholder="individual_service" /></Form.Item></>;
  if (action.kind === 'payable_bind') return <Form.Item name="treasuryInstructionRef" label="Treasury 指令引用" rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ }]}><Input /></Form.Item>;
  if (action.kind === 'payable_settle') return <><Form.Item name="outcome" label="支付结果" rules={[{ required: true }]}><Select options={[{ label: '已支付', value: 'paid' }, { label: '失败', value: 'failed' }, { label: '冻结', value: 'frozen' }]} /></Form.Item><Form.Item name="evidenceRef" label="结算证据引用" rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ }]}><Input /></Form.Item><Form.Item noStyle shouldUpdate>{({ getFieldValue }) => getFieldValue('outcome') === 'paid' ? null : <Form.Item name="failureCode" label="稳定失败原因码" rules={[{ required: true, pattern: /^[a-z][a-z0-9_.:-]{1,63}$/ }]}><Input /></Form.Item>}</Form.Item></>;
  return null;
}

function buildRequest(action: ActionState, values: ActionForm): PendingWrite {
  const base = { method: 'POST' as const, key: createIdempotencyKey(`fulfillment.${action.kind}`) };
  if (action.kind === 'create_engagement') return { ...base, label: '建立履约委托', path: '/api/engagements', scope: 'erp:engagement:management:write', parser: 'engagement', body: { sourcingRequestId: values.sourcingRequestId, performerRefs: splitRefs(values.performerRefs) } };
  const engagement = action.engagement;
  if (engagement !== undefined) {
    if (action.kind === 'engagement_submit') return { ...base, label: '提交履约审批', path: `/api/engagements/${engagement.id}/submit`, scope: 'erp:engagement:management:write', parser: 'engagement', version: engagement.version };
    if (action.kind === 'engagement_approve') return { ...base, label: '批准履约委托', path: `/api/engagements/${engagement.id}/approve`, scope: 'erp:engagement:management:decide', parser: 'engagement', version: engagement.version, body: { evidenceRef: values.evidenceRef } };
    if (action.kind === 'engagement_activate') return { ...base, label: '登记签署回执', path: `/api/engagements/${engagement.id}/activate`, scope: 'erp:engagement:management:decide', parser: 'engagement', version: engagement.version, body: { evidenceRef: values.evidenceRef } };
    if (action.kind === 'engagement_accept') return { ...base, label: '验收交付', path: `/api/engagements/${engagement.id}/accept`, scope: 'erp:engagement:management:accept', parser: 'engagement', version: engagement.version, body: { evidenceRef: values.evidenceRef } };
    if (action.kind === 'materialize_payable') return { ...base, label: '形成应付事项', path: '/api/payables/materialize', scope: 'erp:payables:materialize', parser: 'payable', body: { engagementId: engagement.id, withholdingAmountMinor: yuanToMinor(values.withholdingYuan ?? ''), taxTreatmentCode: values.taxTreatmentCode } };
  }
  const payable = action.payable;
  if (payable !== undefined) {
    if (action.kind === 'payable_submit') return { ...base, label: '提交应付审批', path: `/api/payables/${payable.id}/submit`, scope: 'erp:payables:management:write', parser: 'payable', version: payable.version };
    if (action.kind === 'payable_approve') return { ...base, label: '批准应付事项', path: `/api/payables/${payable.id}/approve`, scope: 'erp:payables:management:decide', parser: 'payable', version: payable.version, body: { evidenceRef: values.evidenceRef } };
    if (action.kind === 'payable_bind') return { ...base, label: '绑定付款指令', path: `/api/payables/${payable.id}/treasury-instruction`, scope: 'erp:payables:treasury:bind', parser: 'payable', version: payable.version, body: { treasuryInstructionRef: values.treasuryInstructionRef } };
    if (action.kind === 'payable_settle') return { ...base, label: '登记支付结果', path: `/api/payables/${payable.id}/settlements`, scope: 'erp:payables:treasury:settle', parser: 'payable', version: payable.version, body: { outcome: values.outcome, evidenceRef: values.evidenceRef, ...(values.outcome === 'paid' ? {} : { failureCode: values.failureCode }) } };
  }
  throw new Error('FULFILLMENT_ACTION_INVALID');
}

function splitRefs(value: string | undefined): readonly string[] { return Object.freeze((value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)); }
function actionTitle(kind: ActionKind): string { return ({ create_engagement: '建立履约委托', engagement_submit: '提交履约审批', engagement_approve: '批准并发起电子签', engagement_activate: '登记签署完成证据', engagement_accept: '验收交付', materialize_payable: '形成应付事项', payable_submit: '提交财务审批', payable_approve: '批准并发起付款', payable_bind: '绑定 Treasury 指令', payable_settle: '登记支付结果' } as const)[kind]; }
function message(value: unknown, fallback: string): string { return value instanceof Error && value.message.length > 0 ? value.message : fallback; }
