'use client';

import {
  AimOutlined, FundProjectionScreenOutlined, PlusOutlined, ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import {
  Alert, Button, Drawer, Empty, Form, Input, Modal, Select, Space, Tag, Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { parseIdentityProfile, type IdentityProfileView } from '../../lib/approval-contract';
import {
  createIdempotencyKey, erpFetch, getBrowserSession,
  isDefinitiveWriteRejection, strongEtag,
} from '../../lib/api-client';
import { formatCnyMinor, yuanToMinor } from '../../lib/money';
import {
  parseSourcingSearch, parseSourcingWrite,
  type SourcingStatus, type SourcingView,
} from '../../lib/sourcing-contract';

const STATUS_LABEL: Readonly<Record<SourcingStatus, string>> = {
  draft: '草稿', pending_approval: '待审批', published: '征集中', evaluating: '评估中',
  awarded: '已选定', closed: '已关闭', cancelled: '已取消',
};
const STAGES: readonly SourcingStatus[] = [
  'draft', 'pending_approval', 'published', 'evaluating', 'awarded', 'closed',
];
interface CreateValues {
  readonly title: string; readonly serviceCategoryCode: string;
  readonly mode: SourcingView['mode']; readonly budgetYuan: string;
  readonly ownerEmployeeId: string; readonly responsibleDepartmentId: string;
  readonly responseDueAt: string; readonly invitedSupplierIds?: string;
}
type ActionKind = 'publish' | 'response' | 'award';
interface ActionValues {
  readonly evidenceRef?: string; readonly supplierId?: string; readonly amountYuan?: string;
}
interface Attempt {
  readonly actorId: string; readonly label: string; readonly path: string;
  readonly scope: string; readonly key: string; readonly version?: number;
  readonly body?: Readonly<Record<string, unknown>>;
}

/** 服务寻源运营台；预算、报价和成交价均以整数分字符串跨越网络边界。 */
export function SourcingConsole() {
  const [items, setItems] = useState<readonly SourcingView[]>([]);
  const [profile, setProfile] = useState<IdentityProfileView | null>(null);
  const [selected, setSelected] = useState<SourcingView | null>(null);
  const [status, setStatus] = useState<SourcingStatus | 'all'>('all');
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const generation = useRef(0);
  const [createForm] = Form.useForm<CreateValues>();
  const [actionForm] = Form.useForm<ActionValues>();

  const load = useCallback(async () => {
    const current = generation.current + 1; generation.current = current;
    setLoading(true); setError(null);
    try {
      const [result, identity, session] = await Promise.all([
        erpFetch<unknown>('/api/sourcing/requests?limit=100'),
        erpFetch<unknown>('/api/auth/profile'), getBrowserSession(),
      ]);
      const next = parseIdentityProfile(identity.data);
      if (!session.scopes.includes('erp:sourcing:management:read')) {
        throw new Error('SOURCING_WORKSPACE_SCOPE_MISSING');
      }
      if (current !== generation.current) return;
      setItems(parseSourcingSearch(result.data).items); setProfile(next);
    } catch (caught) {
      if (current === generation.current) setError(message(caught, '寻源工作台暂时不可用'));
    } finally { if (current === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (selected !== null) setSelected(items.find((item) => item.id === selected.id) ?? null);
  }, [items, selected]);
  const filtered = useMemo(() => items.filter((item) =>
    status === 'all' || item.status === status), [items, status]);
  const counts = useMemo(() => Object.fromEntries(STAGES.map((stage) => [
    stage, items.filter((item) => item.status === stage).length,
  ])) as Record<SourcingStatus, number>, [items]);

  async function execute(attempt: Attempt): Promise<void> {
    if (profile === null || profile.actorId !== attempt.actorId ||
        !profile.scopes.includes(attempt.scope)) {
      setPending(null); setError('当前身份授权已变化，原操作已清除。'); return;
    }
    setSaving(true);
    try {
      const result = await erpFetch<unknown>(attempt.path, {
        method: 'POST', headers: {
          'idempotency-key': attempt.key,
          ...(attempt.version === undefined ? {} : { 'if-match': strongEtag(attempt.version) }),
          ...(attempt.body === undefined ? {} : { 'content-type': 'application/json' }),
        }, ...(attempt.body === undefined ? {} : { body: JSON.stringify(attempt.body) }),
      });
      parseSourcingWrite(result.data); setPending(null); setCreateOpen(false); setAction(null);
      createForm.resetFields(); actionForm.resetFields(); await load();
    } catch (caught) {
      if (isDefinitiveWriteRejection(caught)) setPending(null);
      setError(isDefinitiveWriteRejection(caught)
        ? message(caught, `${attempt.label}失败`)
        : `${attempt.label}结果未知；请复用原编号重试。`);
    } finally { setSaving(false); }
  }

  async function mutate(
    label: string, path: string, scope: string,
    body?: Readonly<Record<string, unknown>>, version?: number,
  ): Promise<void> {
    if (profile === null || pending !== null || !profile.scopes.includes(scope)) return;
    const attempt = Object.freeze({
      actorId: profile.actorId, label, path, scope,
      key: createIdempotencyKey(`sourcing.${label}`),
      ...(body === undefined ? {} : { body }), ...(version === undefined ? {} : { version }),
    });
    setPending(attempt); await execute(attempt);
  }

  async function create(values: CreateValues): Promise<void> {
    try {
      const invited = (values.invitedSupplierIds ?? '').split(/[\s,，]+/u)
        .map((item) => item.trim()).filter(Boolean);
      await mutate('create', '/api/sourcing/requests', 'erp:sourcing:management:write', {
        title: values.title, serviceCategoryCode: values.serviceCategoryCode, mode: values.mode,
        budgetCeilingMinor: yuanToMinor(values.budgetYuan), currency: 'CNY',
        ownerEmployeeId: values.ownerEmployeeId,
        responsibleDepartmentId: values.responsibleDepartmentId,
        responseDueAt: new Date(values.responseDueAt).toISOString(),
        invitedSupplierIds: invited,
      });
    } catch (caught) { setError(message(caught, '预算金额或截止时间格式无效')); }
  }

  async function submitAction(values: ActionValues): Promise<void> {
    if (selected === null || action === null) return;
    try {
      if (action === 'publish') await mutate(
        'publish', `/api/sourcing/requests/${selected.id}/publish`,
        'erp:sourcing:management:decide', { approvalEvidenceRef: values.evidenceRef }, selected.version,
      );
      if (action === 'response') await mutate(
        'response', `/api/sourcing/requests/${selected.id}/responses`,
        'erp:sourcing:response:record', { supplierId: values.supplierId,
          quotationMinor: yuanToMinor(values.amountYuan ?? ''), proposalRef: values.evidenceRef },
        selected.version,
      );
      if (action === 'award') await mutate(
        'award', `/api/sourcing/requests/${selected.id}/award`,
        'erp:sourcing:management:decide', { supplierId: values.supplierId,
          agreedAmountMinor: yuanToMinor(values.amountYuan ?? ''),
          decisionEvidenceRef: values.evidenceRef }, selected.version,
      );
    } catch (caught) { setError(message(caught, '金额格式无效')); }
  }

  return <main className="sourcing-console">
    <header className="sourcing-heading"><div><Typography.Text className="sourcing-kicker"><FundProjectionScreenOutlined /> SERVICE SOURCING</Typography.Text><Typography.Title level={1}>服务寻源</Typography.Title><Typography.Paragraph>公开邀约、定向询价、直接委托与框架调用共享同一审批和资格复核轨道。</Typography.Paragraph></div><Space><Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void load(); }}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={profile?.scopes.includes('erp:sourcing:management:write') !== true} onClick={() => setCreateOpen(true)}>新建需求</Button></Space></header>
    {error === null ? null : <Alert type="error" showIcon title={error} action={pending === null ? undefined : <Button size="small" onClick={() => { void execute(pending); }}>原编号重试</Button>} />}
    <section className="sourcing-stage-rail">{STAGES.map((stage, index) => <button type="button" key={stage} className={status === stage ? 'is-active' : ''} onClick={() => setStatus(status === stage ? 'all' : stage)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{counts[stage] ?? 0}</strong><small>{STATUS_LABEL[stage]}</small>{index < STAGES.length - 1 ? <i /> : null}</button>)}</section>
    <section className="sourcing-register"><header><div><Typography.Text className="sourcing-kicker">REQUEST REGISTER</Typography.Text><h2>需求与响应</h2></div><Tag>{filtered.length} 项</Tag></header>{filtered.length === 0 ? <Empty description="当前阶段没有寻源需求" /> : <div className="sourcing-list">{filtered.map((item) => <button type="button" key={item.id} onClick={() => setSelected(item)}><span className="sourcing-state-mark" data-status={item.status} /><span><strong>{item.title}</strong><small>{item.requestNumber} · {item.serviceCategoryCode}</small></span><span><small>预算上限</small><b>¥ {formatCnyMinor(item.budgetCeilingMinor)}</b></span><span><small>响应</small><b>{item.responses.length}</b></span><span><small>截止</small><b>{new Date(item.responseDueAt).toLocaleDateString('zh-CN')}</b></span><Tag>{STATUS_LABEL[item.status]}</Tag></button>)}</div>}</section>
    <Drawer open={selected !== null} width={560} title="寻源需求控制面" onClose={() => setSelected(null)}>{selected === null ? null : <div className="sourcing-profile"><header><AimOutlined /><div><Typography.Title level={3}>{selected.title}</Typography.Title><Typography.Text>{selected.requestNumber} · {STATUS_LABEL[selected.status]}</Typography.Text></div></header><dl><div><dt>服务分类</dt><dd>{selected.serviceCategoryCode}</dd></div><div><dt>预算上限</dt><dd>¥ {formatCnyMinor(selected.budgetCeilingMinor)}</dd></div><div><dt>受邀供应方</dt><dd>{selected.invitedSupplierIds.length}</dd></div><div><dt>有效响应</dt><dd>{selected.responses.length}</dd></div></dl><section><h3>阶段证据</h3>{selected.responses.map((entry) => <article key={entry.supplierId}><SafetyCertificateOutlined /><span><strong>{entry.supplierId}</strong><small>报价 ¥ {formatCnyMinor(entry.quotationMinor)} · 资格版本 {entry.supplierVersion}</small></span></article>)}{selected.responses.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无有效响应" /> : null}</section><footer><Space wrap>{selected.status === 'draft' ? <Button type="primary" onClick={() => { void mutate('submit', `/api/sourcing/requests/${selected.id}/submit`, 'erp:sourcing:management:write', undefined, selected.version); }}>提交审批</Button> : null}{selected.status === 'pending_approval' ? <Button type="primary" onClick={() => setAction('publish')}>登记批准并发布</Button> : null}{selected.status === 'published' ? <><Button onClick={() => setAction('response')}>登记响应</Button>{selected.responses.length > 0 ? <Button type="primary" onClick={() => { void mutate('evaluate', `/api/sourcing/requests/${selected.id}/start-evaluation`, 'erp:sourcing:management:decide', undefined, selected.version); }}>进入评估</Button> : null}</> : null}{selected.status === 'evaluating' ? <Button type="primary" onClick={() => setAction('award')}>选定供应方</Button> : null}</Space><Typography.Text>版本 {selected.version}</Typography.Text></footer></div>}</Drawer>
    <Drawer open={createOpen} width={540} title="创建服务寻源需求" onClose={() => setCreateOpen(false)}><Form form={createForm} layout="vertical" initialValues={{ mode: 'directed_quote' }} onFinish={(values) => { void create(values); }}><Form.Item name="title" label="需求名称" rules={[{ required: true, min: 2, max: 160 }]}><Input /></Form.Item><div className="sourcing-form-grid"><Form.Item name="serviceCategoryCode" label="服务分类" rules={[{ required: true, pattern: /^[a-z][a-z0-9_.:-]{1,63}$/u }]}><Input placeholder="video_editing" /></Form.Item><Form.Item name="mode" label="寻源方式" rules={[{ required: true }]}><Select options={[{ label: '定向询价', value: 'directed_quote' }, { label: '公开邀约', value: 'open_invitation' }, { label: '直接委托', value: 'direct_award' }, { label: '框架调用', value: 'framework_calloff' }]} /></Form.Item></div><div className="sourcing-form-grid"><Form.Item name="budgetYuan" label="预算上限（元）" rules={[{ required: true, pattern: /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/u }]}><Input inputMode="decimal" /></Form.Item><Form.Item name="responseDueAt" label="响应截止时间" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item></div><div className="sourcing-form-grid"><Form.Item name="ownerEmployeeId" label="负责人 ID" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="responsibleDepartmentId" label="责任部门 ID" rules={[{ required: true }]}><Input /></Form.Item></div><Form.Item name="invitedSupplierIds" label="受邀供应方 ULID（逗号或换行分隔）"><Input.TextArea rows={4} /></Form.Item><Button block type="primary" htmlType="submit" loading={saving}>保存需求草稿</Button></Form></Drawer>
    <Modal open={action !== null} title={action === 'publish' ? '登记审批并发布' : action === 'response' ? '登记供应响应' : '选定供应方'} okText="提交" cancelText="取消" confirmLoading={saving} onCancel={() => setAction(null)} onOk={() => actionForm.submit()} destroyOnHidden><Form form={actionForm} layout="vertical" onFinish={(values) => { void submitAction(values); }}>{action === 'publish' ? null : <><Form.Item name="supplierId" label="供应方 ULID" rules={[{ required: true, pattern: /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u }]}><Input /></Form.Item><Form.Item name="amountYuan" label={action === 'response' ? '响应报价（元）' : '成交金额（元）'} rules={[{ required: true, pattern: /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/u }]}><Input inputMode="decimal" /></Form.Item></>}<Form.Item name="evidenceRef" label={action === 'response' ? '方案证据引用' : action === 'award' ? '选定决策证据引用' : '审批证据引用'} rules={[{ required: true, min: 1, max: 128 }]}><Input /></Form.Item></Form></Modal>
  </main>;
}

function message(value: unknown, fallback: string): string {
  return value instanceof Error && value.message.length > 0 ? value.message : fallback;
}
