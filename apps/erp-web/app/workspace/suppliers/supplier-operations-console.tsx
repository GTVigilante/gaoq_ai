'use client';

import {
  CheckCircleFilled, ClockCircleFilled, IdcardOutlined, PlusOutlined, ReloadOutlined,
  SafetyCertificateOutlined, SearchOutlined, ShopOutlined, StopOutlined, UserOutlined,
} from '@ant-design/icons';
import {
  Alert, Avatar, Button, Drawer, Empty, Form, Input, Modal, Radio, Select, Skeleton,
  Space, Tag, Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createIdempotencyKey, erpFetch, getBrowserSession, isDefinitiveWriteRejection, strongEtag } from '../../lib/api-client';
import { parseIdentityProfile, type IdentityProfileView } from '../../lib/approval-contract';
import { parseSupplierSearch, parseSupplierWrite, type SupplierStatus, type SupplierView } from '../../lib/supplier-contract';
import { SupplierMemberPanel } from './supplier-member-panel';

const { Title, Paragraph, Text } = Typography;
const STATUS_LABEL: Readonly<Record<SupplierStatus, string>> = { draft: '草稿', under_review: '待准入', active: '可合作', rejected: '已驳回', suspended: '已暂停', closed: '已关闭' };
const STATUS_COLOR: Readonly<Record<SupplierStatus, string>> = { draft: 'default', under_review: 'gold', active: 'green', rejected: 'red', suspended: 'volcano', closed: 'default' };
const INDIVIDUAL_QUALIFICATIONS = ['identity', 'contract_terms', 'tax_profile', 'conflict_review'] as const;
const ORGANIZATION_QUALIFICATIONS = ['business_registration', 'authority', 'contract_terms', 'tax_profile'] as const;
type CoreQualification = (typeof INDIVIDUAL_QUALIFICATIONS)[number] | (typeof ORGANIZATION_QUALIFICATIONS)[number];
const QUALIFICATION_LABEL: Readonly<Record<CoreQualification, string>> = { identity: '身份', business_registration: '主体登记', authority: '授权关系', contract_terms: '条款', tax_profile: '税务', conflict_review: '冲突审查' };
const EVIDENCE_FIELD: Readonly<Record<CoreQualification, keyof DecisionForm>> = { identity: 'identityEvidenceRef', business_registration: 'businessEvidenceRef', authority: 'authorityEvidenceRef', contract_terms: 'contractEvidenceRef', tax_profile: 'taxEvidenceRef', conflict_review: 'conflictEvidenceRef' };

interface CreateForm {
  readonly partyKind: 'individual' | 'organization'; readonly displayName: string;
  readonly legalName: string; readonly identifierType: 'national_id' | 'passport' | 'unified_social_credit_code' | 'business_registration_no';
  readonly identifier: string; readonly ownerEmployeeId: string; readonly responsibleDepartmentId: string;
  readonly riskTier: 'low' | 'medium' | 'high'; readonly serviceCategoryCode: string;
  readonly capabilityLevel: 'basic' | 'verified' | 'preferred' | 'strategic';
}
interface DecisionForm {
  readonly outcome: 'approved' | 'rejected'; readonly decisionEvidenceRef: string; readonly reasonCode?: string;
  readonly identityEvidenceRef?: string; readonly contractEvidenceRef?: string; readonly taxEvidenceRef?: string; readonly conflictEvidenceRef?: string;
  readonly businessEvidenceRef?: string; readonly authorityEvidenceRef?: string;
}
interface PendingMutation {
  readonly actorId: string; readonly label: string; readonly path: string; readonly scope: string;
  readonly method: 'POST'; readonly key: string; readonly version?: number; readonly body?: Readonly<Record<string, unknown>>;
}

/**
 * Intent: 供应方运营在高频审核中迅速识别可合作兼职者与材料缺口，像可信创作者名册而非传统采购账册。
 * Hierarchy: 待准入队列为主焦点，合作通行证直接呈现四项准入，名册筛选与统计退居第二层。
 * Palette: 报价单纸白、档案石墨、合规印章绿和待办琥珀；颜色仅表达动作与状态。
 * Depth: 采用轻边框与表面色差，保持高密度运营工具的稳定感。
 * Surfaces: 雾灰画布、纸白工作区、微灰嵌入控件三级表面。
 * Typography: 14px 主体，靠字重、灰阶与等宽编号建立层级。
 * Spacing: 4px 基准；12–20px 紧凑操作密度，44px 交互命中区。
 */
export function SupplierOperationsConsole() {
  const [items, setItems] = useState<readonly SupplierView[]>([]); const [profile, setProfile] = useState<IdentityProfileView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading'); const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(''); const [status, setStatus] = useState<SupplierStatus | 'all'>('all'); const [selected, setSelected] = useState<SupplierView | null>(null);
  const [createOpen, setCreateOpen] = useState(false); const [decisionOpen, setDecisionOpen] = useState(false); const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingMutation | null>(null); const generation = useRef(0);
  const [createForm] = Form.useForm<CreateForm>(); const [decisionForm] = Form.useForm<DecisionForm>();

  const load = useCallback(async () => {
    const current = generation.current + 1; generation.current = current; setState('loading'); setError(null);
    try {
      const [supplierResult, profileResult, session] = await Promise.all([erpFetch<unknown>('/api/suppliers?limit=100'), erpFetch<unknown>('/api/auth/profile'), getBrowserSession()]);
      const nextProfile = parseIdentityProfile(profileResult.data);
      if (!session.scopes.includes('erp:supplier:relationship:read') || nextProfile.actorId.length === 0) throw new Error('SUPPLIER_WORKSPACE_SCOPE_MISSING');
      if (current !== generation.current) return;
      setItems(parseSupplierSearch(supplierResult.data).items); setProfile(nextProfile); setState('ready');
    } catch (value) { if (current === generation.current) { setState('error'); setError(message(value, '供应方工作台暂时不可用')); } }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selected !== null) setSelected(items.find((item) => item.id === selected.id) ?? null); }, [items, selected]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN');
    return items.filter((item) => (status === 'all' || item.status === status) && (keyword.length === 0 || `${item.displayName} ${item.supplierNumber} ${item.capabilities.map((entry) => entry.serviceCategoryCode).join(' ')}`.toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [items, query, status]);
  const counts = useMemo(() => ({ active: items.filter((item) => item.status === 'active').length, review: items.filter((item) => item.status === 'under_review').length, individual: items.filter((item) => item.partyKind === 'individual').length, blocked: items.filter((item) => ['rejected', 'suspended'].includes(item.status)).length }), [items]);
  const canWrite = profile?.scopes.includes('erp:supplier:relationship:write') === true; const canDecide = profile?.scopes.includes('erp:supplier:relationship:decide') === true;

  async function execute(attempt: PendingMutation): Promise<void> {
    if (profile === null || profile.actorId !== attempt.actorId || !profile.scopes.includes(attempt.scope)) { setPending(null); setError('当前身份或授权已变化，原供应方操作已清除。'); return; }
    setSaving(true); setError(null);
    try {
      const result = await erpFetch<unknown>(attempt.path, { method: attempt.method, headers: { 'idempotency-key': attempt.key, ...(attempt.version === undefined ? {} : { 'if-match': strongEtag(attempt.version) }), ...(attempt.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(attempt.body === undefined ? {} : { body: JSON.stringify(attempt.body) }) });
      parseSupplierWrite(result.data); setPending(null); setCreateOpen(false); setDecisionOpen(false); createForm.resetFields(); decisionForm.resetFields(); await load();
    } catch (value) { if (isDefinitiveWriteRejection(value)) setPending(null); setError(isDefinitiveWriteRejection(value) ? message(value, `${attempt.label}失败`) : `${attempt.label}结果尚未确认；请使用原操作重试，系统会复用同一幂等编号。`); }
    finally { setSaving(false); }
  }

  async function mutate(label: string, path: string, scope: string, body?: Readonly<Record<string, unknown>>, version?: number): Promise<void> {
    if (profile === null || pending !== null || !profile.scopes.includes(scope)) return;
    const attempt: PendingMutation = Object.freeze({ actorId: profile.actorId, label, path, scope, method: 'POST', key: createIdempotencyKey(`supplier.${label}`), ...(version === undefined ? {} : { version }), ...(body === undefined ? {} : { body }) });
    setPending(attempt); await execute(attempt);
  }

  async function create(values: CreateForm): Promise<void> {
    await mutate('create', '/api/suppliers', 'erp:supplier:relationship:write', Object.freeze({ partyKind: values.partyKind, legalForm: values.partyKind === 'individual' ? 'individual' : 'company', displayName: values.displayName, legalIdentity: { identifierType: values.identifierType, identifier: values.identifier, legalName: values.legalName }, ownerEmployeeId: values.ownerEmployeeId, responsibleDepartmentId: values.responsibleDepartmentId, riskTier: values.riskTier, capabilities: [{ serviceCategoryCode: values.serviceCategoryCode, level: values.capabilityLevel }], rates: [] }));
  }

  async function decide(values: DecisionForm): Promise<void> {
    if (selected === null) return;
    const body = values.outcome === 'rejected'
      ? { outcome: 'rejected', decisionEvidenceRef: values.decisionEvidenceRef, reasonCode: values.reasonCode }
      : { outcome: 'approved', decisionEvidenceRef: values.decisionEvidenceRef, qualifications: requiredQualifications(selected).map((type) => ({ type, evidenceRef: values[EVIDENCE_FIELD[type]] })) };
    await mutate('decide', `/api/suppliers/${selected.id}/decisions`, 'erp:supplier:relationship:decide', body, selected.version);
  }

  return <main className="supplier-console" aria-labelledby="supplier-title" aria-busy={state === 'loading'}>
    <header className="supplier-heading">
      <div><Text className="supplier-eyebrow"><ShopOutlined /> COLLABORATOR REGISTRY</Text><Title id="supplier-title" level={1}>供应方运营台</Title><Paragraph>同时管理个人兼职者、工作室与企业；准入、能力、报价和合作资格使用同一可信关系主档。</Paragraph></div>
      <Space><Button icon={<ReloadOutlined />} loading={state === 'loading'} onClick={() => { void load(); }}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canWrite} onClick={() => setCreateOpen(true)}>新建供应方</Button></Space>
    </header>
    {error === null ? null : <Alert type="error" showIcon title={error} action={pending === null ? undefined : <Button size="small" onClick={() => { void execute(pending); }}>使用原编号重试</Button>} />}
    <section className="supplier-pulse" aria-label="供应方状态概览">
      <article><span>可立即合作</span><strong>{counts.active}</strong><small>已通过核心准入</small></article>
      <article className={counts.review > 0 ? 'is-attention' : ''}><span>待准入决策</span><strong>{counts.review}</strong><small>需要人工核验证据</small></article>
      <article><span>个人兼职者</span><strong>{counts.individual}</strong><small>区别于传统企业供应商</small></article>
      <article><span>暂停或驳回</span><strong>{counts.blocked}</strong><small>不得创建新合作单</small></article>
    </section>
    <section className="supplier-workbench">
      <aside className="supplier-queue" aria-label="供应方筛选与待办">
        <header><div><Text className="supplier-section-kicker">TRIAGE</Text><h2>待处理队列</h2></div><Tag color={counts.review > 0 ? 'gold' : 'green'}>{counts.review} 项</Tag></header>
        <Input prefix={<SearchOutlined />} allowClear placeholder="姓名、编号或服务能力" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Select value={status} onChange={setStatus} options={[{ label: '全部状态', value: 'all' }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))]} />
        <div className="supplier-review-list">{items.filter((item) => item.status === 'under_review').slice(0, 8).map((item) => <button key={item.id} type="button" onClick={() => setSelected(item)}><ClockCircleFilled /><span><strong>{item.displayName}</strong><small>{item.partyKind === 'individual' ? '个人兼职者' : '组织供应方'} · {item.capabilities[0]?.serviceCategoryCode ?? '未登记能力'}</small></span><b>审核</b></button>)}{counts.review === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待审核关系" /> : null}</div>
        <footer><SafetyCertificateOutlined /><span><strong>准入失败关闭</strong><small>材料过期或状态异常时不可发起合作</small></span></footer>
      </aside>
      <section className="supplier-register" aria-label="供应方名册">
        <header><div><Text className="supplier-section-kicker">REGISTRY</Text><h2>合作方名册</h2></div><Text>{filtered.length} / {items.length}</Text></header>
        {state === 'loading' ? <Skeleton active paragraph={{ rows: 8 }} /> : filtered.length === 0 ? <Empty description="当前筛选下没有供应方" /> : <div className="supplier-roster">{filtered.map((item) => <button type="button" key={item.id} className={selected?.id === item.id ? 'is-selected' : ''} onClick={() => setSelected(item)}>
          <Avatar icon={item.partyKind === 'individual' ? <UserOutlined /> : <ShopOutlined />} />
          <span className="supplier-roster-name"><strong>{item.displayName}</strong><small>{item.supplierNumber} · {item.identityHint}</small></span>
          <span className="supplier-roster-skills">{item.capabilities.slice(0, 2).map((entry) => <Tag key={entry.serviceCategoryCode}>{entry.serviceCategoryCode}</Tag>)}</span>
          <CollaborationPassport supplier={item} compact />
          <Tag color={STATUS_COLOR[item.status]}>{STATUS_LABEL[item.status]}</Tag>
        </button>)}</div>}
      </section>
    </section>

    <Drawer open={selected !== null} width={560} onClose={() => setSelected(null)} title="供应方关系档案" className="supplier-profile-drawer">
      {selected === null ? null : <><SupplierProfile supplier={selected} canWrite={canWrite} canDecide={canDecide} saving={saving} onSubmit={() => { void mutate('submit', `/api/suppliers/${selected.id}/submit`, 'erp:supplier:relationship:write', undefined, selected.version); }} onDecide={() => { decisionForm.setFieldsValue({ outcome: 'approved' }); setDecisionOpen(true); }} onSuspend={() => { void mutate('suspend', `/api/suppliers/${selected.id}/suspend`, 'erp:supplier:relationship:decide', { reasonCode: 'manual_suspension' }, selected.version); }} /><SupplierMemberPanel supplier={selected} profile={profile} /></>}
    </Drawer>
    <Drawer open={createOpen} width={540} onClose={() => setCreateOpen(false)} title="建立供应方关系" destroyOnHidden>
        <Form form={createForm} layout="vertical" initialValues={{ partyKind: 'individual', identifierType: 'national_id', riskTier: 'medium', capabilityLevel: 'basic' }} onFinish={(values) => { void create(values); }}>
        <Form.Item name="partyKind" label="供应方形态" rules={[{ required: true }]}><Radio.Group optionType="button" buttonStyle="solid" options={[{ label: '个人兼职者', value: 'individual' }, { label: '企业 / 工作室', value: 'organization' }]} /></Form.Item>
        <Form.Item name="displayName" label="展示名称" rules={[{ required: true, max: 128 }]}><Input /></Form.Item>
        <Form.Item name="legalName" label="法定姓名 / 主体名称" rules={[{ required: true, max: 128 }]}><Input /></Form.Item>
        <div className="supplier-form-grid"><Form.Item name="identifierType" label="身份凭证类型" rules={[{ required: true }]}><Select options={[{ label: '居民身份证', value: 'national_id' }, { label: '护照', value: 'passport' }, { label: '统一社会信用代码', value: 'unified_social_credit_code' }, { label: '工商登记号', value: 'business_registration_no' }]} /></Form.Item><Form.Item name="identifier" label="身份凭证号码" rules={[{ required: true, min: 6, max: 40 }]}><Input /></Form.Item></div>
        <div className="supplier-form-grid"><Form.Item name="ownerEmployeeId" label="内部负责人 ID" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="responsibleDepartmentId" label="责任部门 ID" rules={[{ required: true }]}><Input /></Form.Item></div>
        <div className="supplier-form-grid"><Form.Item name="serviceCategoryCode" label="首项服务能力" rules={[{ required: true, pattern: /^[a-z][a-z0-9_.:-]{1,63}$/ }]}><Input placeholder="如 video_editing" /></Form.Item><Form.Item name="capabilityLevel" label="能力可信等级" rules={[{ required: true }]}><Select options={[{ label: '基础', value: 'basic' }, { label: '已核验', value: 'verified' }, { label: '优选', value: 'preferred' }, { label: '战略', value: 'strategic' }]} /></Form.Item></div>
        <Form.Item name="riskTier" label="风险分级" rules={[{ required: true }]}><Select options={[{ label: '低', value: 'low' }, { label: '中', value: 'medium' }, { label: '高', value: 'high' }]} /></Form.Item>
        <Button block type="primary" htmlType="submit" loading={saving}>保存关系草稿</Button>
      </Form>
    </Drawer>
    <Modal open={decisionOpen} title="供应方准入决策" okText="提交决策" cancelText="取消" confirmLoading={saving} onCancel={() => setDecisionOpen(false)} onOk={() => decisionForm.submit()} destroyOnHidden>
      <Form form={decisionForm} layout="vertical" onFinish={(values) => { void decide(values); }}>
        <Form.Item name="outcome" label="决策" rules={[{ required: true }]}><Radio.Group options={[{ label: '批准合作', value: 'approved' }, { label: '驳回', value: 'rejected' }]} /></Form.Item>
        <Form.Item name="decisionEvidenceRef" label="决策证据引用" rules={[{ required: true, min: 1, max: 128 }]}><Input /></Form.Item>
        <Form.Item noStyle shouldUpdate={(before: { outcome?: unknown }, after: { outcome?: unknown }) => before.outcome !== after.outcome}>{({ getFieldValue }) => getFieldValue('outcome') === 'rejected' ? <Form.Item name="reasonCode" label="驳回原因码" rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{2,63}$/ }]}><Input placeholder="如 identity_mismatch" /></Form.Item> : <>{(selected === null ? [] : requiredQualifications(selected)).map((type) => <Form.Item key={type} name={EVIDENCE_FIELD[type]} label={`${QUALIFICATION_LABEL[type]}证据引用`} rules={[{ required: true, min: 1, max: 128 }]}><Input /></Form.Item>)}</>}</Form.Item>
      </Form>
    </Modal>
  </main>;
}

function CollaborationPassport({ supplier, compact = false }: { readonly supplier: SupplierView; readonly compact?: boolean }) {
  const verified = new Set(supplier.qualifications.map((entry) => entry.type));
  return <div className={`supplier-passport${compact ? ' is-compact' : ''}`} aria-label="合作通行证">{requiredQualifications(supplier).map((type) => <span key={type} className={verified.has(type) ? 'is-verified' : ''}>{verified.has(type) ? <CheckCircleFilled /> : <span className="supplier-passport-dot" />}{compact ? null : <small>{QUALIFICATION_LABEL[type]}</small>}</span>)}</div>;
}

function SupplierProfile({ supplier, canWrite, canDecide, saving, onSubmit, onDecide, onSuspend }: { readonly supplier: SupplierView; readonly canWrite: boolean; readonly canDecide: boolean; readonly saving: boolean; readonly onSubmit: () => void; readonly onDecide: () => void; readonly onSuspend: () => void }) {
  return <div className="supplier-profile"><header><Avatar size={54} icon={supplier.partyKind === 'individual' ? <UserOutlined /> : <ShopOutlined />} /><div><Title level={3}>{supplier.displayName}</Title><Text>{supplier.supplierNumber} · {supplier.partyKind === 'individual' ? '个人兼职者' : '组织供应方'}</Text></div><Tag color={STATUS_COLOR[supplier.status]}>{STATUS_LABEL[supplier.status]}</Tag></header>
    <section><Text className="supplier-section-kicker">COLLABORATION PASSPORT</Text><h3>合作通行证</h3><CollaborationPassport supplier={supplier} /></section>
    <dl><div><dt>身份尾号</dt><dd><IdcardOutlined /> {supplier.identityHint}</dd></div><div><dt>风险等级</dt><dd>{supplier.riskTier}</dd></div><div><dt>内部负责人</dt><dd>{supplier.ownerEmployeeId}</dd></div><div><dt>责任部门</dt><dd>{supplier.responsibleDepartmentId}</dd></div></dl>
    <section><h3>服务能力</h3><div className="supplier-capability-list">{supplier.capabilities.map((entry) => <article key={entry.serviceCategoryCode}><strong>{entry.serviceCategoryCode}</strong><Tag>{entry.level}</Tag><small>{entry.validUntil === null ? '长期有效' : `有效至 ${entry.validUntil}`}</small></article>)}</div></section>
    <footer><Space wrap>{supplier.status === 'draft' ? <Button type="primary" disabled={!canWrite} loading={saving} onClick={onSubmit}>提交准入</Button> : null}{supplier.status === 'under_review' ? <Button type="primary" disabled={!canDecide} loading={saving} onClick={onDecide}>作出准入决策</Button> : null}{supplier.status === 'active' ? <Button danger icon={<StopOutlined />} disabled={!canDecide} loading={saving} onClick={onSuspend}>暂停合作</Button> : null}</Space><Text>版本 {supplier.version} · 更新于 {new Date(supplier.updatedAt).toLocaleString('zh-CN')}</Text></footer>
  </div>;
}

function message(value: unknown, fallback: string): string { return value instanceof Error && value.message.length > 0 ? value.message : fallback; }
function requiredQualifications(supplier: Pick<SupplierView, 'partyKind'>): readonly CoreQualification[] { return supplier.partyKind === 'individual' ? INDIVIDUAL_QUALIFICATIONS : ORGANIZATION_QUALIFICATIONS; }
