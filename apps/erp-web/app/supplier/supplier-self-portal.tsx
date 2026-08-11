'use client';

import {
  ArrowRightOutlined, DollarOutlined, FundProjectionScreenOutlined, ReloadOutlined, SafetyCertificateOutlined,
  ThunderboltOutlined, UserOutlined, WalletOutlined,
} from '@ant-design/icons';
import { Alert, Button, Empty, Form, Input, Modal, Select, Space, Tag } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createIdempotencyKey, erpFetch, getBrowserSession,
  isDefinitiveWriteRejection, strongEtag,
} from '../lib/api-client';
import {
  parseSupplierOpportunitySearch, parseSupplierOpportunityWrite,
  type SupplierOpportunityView,
} from '../lib/sourcing-contract';
import { parseSupplierIncome, type SupplierIncomeView } from '../lib/supplier-income-contract';
import { resolveSupplierSelfAccess, type SupplierSelfAccess } from '../lib/supplier-self-access';
import {
  parseSupplierEngagementList, parseSupplierEngagementWrite,
  type SupplierEngagementView,
} from '../lib/supplier-engagement-contract';
import { parseSupplierWrite, type SupplierView } from '../lib/supplier-contract';
import { minorToYuan, yuanToMinor } from '../lib/money';

type CatalogKind = 'capabilities' | 'rates';
interface PendingMutation {
  readonly kind: CatalogKind; readonly key: string; readonly version: number;
  readonly body: Readonly<Record<string, unknown>>;
}
interface PendingOpportunityResponse {
  readonly opportunityId: string; readonly key: string; readonly version: number;
  readonly body: { readonly quotationMinor: string; readonly proposalRef: string };
}
interface PendingDelivery {
  readonly engagementId: string; readonly key: string; readonly version: number;
  readonly body: { readonly artifactRef: string };
}

const LEVELS = [
  { label: '基础', value: 'basic' }, { label: '已核验', value: 'verified' },
  { label: '优选', value: 'preferred' }, { label: '战略', value: 'strategic' },
];
const UNITS = [
  { label: '按件', value: 'per_piece' }, { label: '按分钟', value: 'per_minute' },
  { label: '按天', value: 'per_day' }, { label: '按项目', value: 'per_project' },
  { label: '按小时', value: 'per_hour' },
];

/** 供应方本人门户；服务端只按可信 actor 解析供应关系，页面从不提交 supplierId。 */
export function SupplierSelfPortal() {
  const [supplier, setSupplier] = useState<SupplierView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CatalogKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [opportunities, setOpportunities] = useState<readonly SupplierOpportunityView[]>([]);
  const [income, setIncome] = useState<SupplierIncomeView | null>(null);
  const [engagements, setEngagements] = useState<readonly SupplierEngagementView[]>([]);
  const [access, setAccess] = useState<SupplierSelfAccess>(() => resolveSupplierSelfAccess([]));
  const [delivering, setDelivering] = useState<SupplierEngagementView | null>(null);
  const [deliveryPending, setDeliveryPending] = useState<PendingDelivery | null>(null);
  const [responding, setResponding] = useState<SupplierOpportunityView | null>(null);
  const [opportunityPending, setOpportunityPending] = useState<PendingOpportunityResponse | null>(null);
  const generation = useRef(0);
  const [capabilityForm] = Form.useForm(); const [rateForm] = Form.useForm();
  const [responseForm] = Form.useForm();
  const [deliveryForm] = Form.useForm();

  const load = useCallback(async () => {
    const current = generation.current + 1; generation.current = current;
    setState('loading'); setError(null);
    try {
      const browser = await getBrowserSession();
      const granted = resolveSupplierSelfAccess(browser.scopes);
      if (!granted.profileRead) {
        throw new Error('当前账号未获授权读取合作档案');
      }
      const profile = await erpFetch<unknown>('/api/supplier-self/profile');
      const optionalReads = await Promise.allSettled([
        granted.opportunitiesRead
          ? erpFetch<unknown>('/api/supplier-self/opportunities?limit=100') : Promise.resolve(null),
        granted.incomeRead
          ? erpFetch<unknown>('/api/supplier-self/income') : Promise.resolve(null),
        granted.engagementsRead
          ? erpFetch<unknown>('/api/supplier-self/engagements?limit=100') : Promise.resolve(null),
      ]);
      const parsed = parseSupplierWrite(profile.data).supplier;
      const [opportunityResult, incomeResult, engagementResult] = optionalReads;
      const available = opportunityResult?.status === 'fulfilled' && opportunityResult.value !== null
        ? parseSupplierOpportunitySearch(opportunityResult.value.data).items : [];
      const incomeProjection = incomeResult?.status === 'fulfilled' && incomeResult.value !== null
        ? parseSupplierIncome(incomeResult.value.data) : null;
      const assigned = engagementResult?.status === 'fulfilled' && engagementResult.value !== null
        ? parseSupplierEngagementList(engagementResult.value.data).items : [];
      const failedRead = optionalReads.find((result) => result.status === 'rejected');
      if (current === generation.current) {
        setSupplier(parsed); setOpportunities(available); setIncome(incomeProjection);
        setEngagements(assigned); setAccess(granted); setState('ready');
        if (failedRead?.status === 'rejected') {
          setError(message(failedRead.reason, '部分合作信息暂时无法读取'));
        }
      }
    } catch (caught) {
      if (current === generation.current) { setState('error'); setError(message(caught, '无法解析唯一有效的合作档案')); }
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const canManageCatalog = access.catalogManage;
  const canReadOpportunities = access.opportunitiesRead;
  const canRespond = access.responseWrite;
  const canReadEngagements = access.engagementsRead;
  const canDeliver = access.deliveryWrite;

  function open(kind: CatalogKind): void {
    if (supplier === null || pending !== null) return;
    if (kind === 'capabilities') capabilityForm.setFieldsValue({ capabilities: supplier.capabilities });
    else rateForm.setFieldsValue({
      rates: supplier.rates.map(({ amountMinor, ...rate }) => ({
        ...rate,
        amountYuan: minorToYuan(amountMinor),
      })),
    });
    setEditing(kind);
  }

  async function execute(attempt: PendingMutation): Promise<void> {
    setSaving(true); setError(null);
    try {
      const response = await erpFetch<unknown>(`/api/supplier-self/${attempt.kind}`, {
        method: 'PUT', headers: {
          'content-type': 'application/json', 'idempotency-key': attempt.key,
          'if-match': strongEtag(attempt.version),
        }, body: JSON.stringify(attempt.body),
      });
      setSupplier(parseSupplierWrite(response.data).supplier);
      setPending(null); setEditing(null); capabilityForm.resetFields(); rateForm.resetFields();
    } catch (caught) {
      if (isDefinitiveWriteRejection(caught)) setPending(null);
      setError(isDefinitiveWriteRejection(caught)
        ? message(caught, '目录更新失败')
        : '更新结果尚未确认；请使用原编号重试，系统不会重复写入。');
    } finally { setSaving(false); }
  }

  async function saveCapabilities(values: { capabilities?: readonly Record<string, unknown>[] }) {
    if (supplier === null || values.capabilities === undefined) return;
    const attempt = Object.freeze({
      kind: 'capabilities' as const, version: supplier.version,
      key: createIdempotencyKey('supplier.self.capabilities'),
      body: Object.freeze({ capabilities: values.capabilities }),
    });
    setPending(attempt); await execute(attempt);
  }

  async function saveRates(values: { rates?: readonly (Record<string, unknown> & { amountYuan?: string })[] }) {
    if (supplier === null || values.rates === undefined) return;
    let rates: readonly Record<string, unknown>[];
    try {
      rates = values.rates.map(({ amountYuan, ...rate }) => ({
        ...rate,
        amountMinor: yuanToMinor(amountYuan ?? ''),
        currency: 'CNY',
        taxIncluded: true,
      }));
    } catch (caught) {
      setError(message(caught, '参考价必须是最多两位小数的非负金额'));
      return;
    }
    const attempt = Object.freeze({
      kind: 'rates' as const, version: supplier.version,
      key: createIdempotencyKey('supplier.self.rates'), body: Object.freeze({ rates }),
    });
    setPending(attempt); await execute(attempt);
  }

  async function executeOpportunity(attempt: PendingOpportunityResponse): Promise<void> {
    setSaving(true); setError(null);
    try {
      const response = await erpFetch<unknown>(
        `/api/supplier-self/opportunities/${attempt.opportunityId}/responses`,
        {
          method: 'POST', headers: {
            'content-type': 'application/json', 'idempotency-key': attempt.key,
            'if-match': strongEtag(attempt.version),
          }, body: JSON.stringify(attempt.body),
        },
      );
      const updated = parseSupplierOpportunityWrite(response.data).request;
      setOpportunities((current) => current.map((item) => item.id === updated.id ? updated : item));
      setOpportunityPending(null); setResponding(null); responseForm.resetFields();
    } catch (caught) {
      if (isDefinitiveWriteRejection(caught)) setOpportunityPending(null);
      setError(isDefinitiveWriteRejection(caught)
        ? message(caught, '商机响应失败')
        : '响应结果尚未确认；请使用原编号重试，系统不会重复登记。');
    } finally { setSaving(false); }
  }

  async function submitOpportunityResponse(values: { quotationYuan?: string; proposalRef?: string }) {
    if (responding === null || values.proposalRef === undefined) return;
    let quotationMinor: string;
    try { quotationMinor = yuanToMinor(values.quotationYuan ?? ''); } catch (caught) {
      setError(message(caught, '报价必须是最多两位小数的非负金额')); return;
    }
    const attempt = Object.freeze({
      opportunityId: responding.id, version: responding.version,
      key: createIdempotencyKey('supplier.self.sourcing.response'),
      body: Object.freeze({ quotationMinor, proposalRef: values.proposalRef }),
    });
    setOpportunityPending(attempt); await executeOpportunity(attempt);
  }

  async function executeDelivery(attempt: PendingDelivery): Promise<void> {
    setSaving(true); setError(null);
    try {
      const response = await erpFetch<unknown>(
        `/api/supplier-self/engagements/${attempt.engagementId}/deliveries`,
        { method: 'POST', headers: {
          'content-type': 'application/json', 'idempotency-key': attempt.key,
          'if-match': strongEtag(attempt.version),
        }, body: JSON.stringify(attempt.body) },
      );
      const updated = parseSupplierEngagementWrite(response.data).engagement;
      setEngagements((current) => current.map((item) => item.id === updated.id ? updated : item));
      setDeliveryPending(null); setDelivering(null); deliveryForm.resetFields();
    } catch (caught) {
      if (isDefinitiveWriteRejection(caught)) setDeliveryPending(null);
      setError(isDefinitiveWriteRejection(caught)
        ? message(caught, '交付提交失败')
        : '交付结果尚未确认；请使用原编号重试。');
    } finally { setSaving(false); }
  }

  async function submitDelivery(values: { artifactRef?: string }) {
    if (delivering === null || values.artifactRef === undefined) return;
    const attempt = Object.freeze({
      engagementId: delivering.id, version: delivering.version,
      key: createIdempotencyKey('supplier.self.engagement.delivery'),
      body: Object.freeze({ artifactRef: values.artifactRef }),
    });
    setDeliveryPending(attempt); await executeDelivery(attempt);
  }

  return <main className="supplier-self-page">
    <header className="supplier-self-hero">
      <div className="supplier-self-mark"><ThunderboltOutlined /></div>
      <div><span>GAOQ COLLABORATOR</span><h1>我的合作档案</h1><p>能力、参考价和合作资格由你维护；身份、税务与收款变更仍经过独立核验。</p></div>
      <Button icon={<ReloadOutlined />} loading={state === 'loading'} onClick={() => { void load(); }}>刷新</Button>
    </header>
    {error === null ? null : <Alert showIcon type="error" title={error} action={pending !== null ? <Button size="small" onClick={() => { void execute(pending); }}>用原编号重试</Button> : opportunityPending !== null ? <Button size="small" onClick={() => { void executeOpportunity(opportunityPending); }}>用原编号重试</Button> : deliveryPending === null ? undefined : <Button size="small" onClick={() => { void executeDelivery(deliveryPending); }}>用原编号重试</Button>} />}
    {supplier === null ? <section className="supplier-self-empty"><Empty description={state === 'loading' ? '正在读取可信合作关系' : '没有可访问的合作档案'} /></section> : <>
      <section className="supplier-self-passport">
        <div className="supplier-self-avatar"><UserOutlined /></div>
        <div><small>{supplier.supplierNumber}</small><h2>{supplier.displayName}</h2><p>{supplier.partyKind === 'individual' ? '个人兼职合作方' : '组织合作方成员'} · {supplier.identityHint}</p></div>
        <Tag color={supplier.status === 'active' ? 'green' : 'gold'}>{supplier.status === 'active' ? '可合作' : supplier.status}</Tag>
        <div className="supplier-self-seal"><SafetyCertificateOutlined /><span>资格版本</span><strong>V{supplier.version}</strong></div>
      </section>
      {canReadEngagements ? <section className="supplier-self-engagements">
        <header><div><span>ACTIVE WORK</span><h2>我的履约委托</h2></div><Tag>{engagements.length} 项</Tag></header>
        {engagements.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无分配给你的履约委托" /> : <div>{engagements.map((item) => <article key={item.id}><div><small>{item.engagementNumber} · {item.serviceCategoryCode}</small><strong>约定金额 ¥ {minorToYuan(item.agreedAmountMinor)}</strong><span>{engagementStatus(item.status)} · 已提交 {item.deliveryCount} 个版本</span></div>{canDeliver && ['active','delivered'].includes(item.status) ? <Button onClick={() => setDelivering(item)}>提交交付</Button> : <Tag>{engagementStatus(item.status)}</Tag>}</article>)}</div>}
      </section> : null}
      <section className="supplier-self-grid">
        <article>
          <header><div><span>CAPABILITIES</span><h2>我能提供的服务</h2></div>{canManageCatalog ? <Button onClick={() => open('capabilities')}>维护</Button> : null}</header>
          {supplier.capabilities.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未登记能力" /> : supplier.capabilities.map((item) => <div className="supplier-self-row" key={item.serviceCategoryCode}><div><strong>{item.serviceCategoryCode}</strong><small>{item.validUntil === null ? '长期有效' : `有效至 ${item.validUntil}`}</small></div><Tag>{item.level}</Tag></div>)}
        </article>
        <article>
          <header><div><span>REFERENCE RATES</span><h2>我的参考价</h2></div>{canManageCatalog ? <Button onClick={() => open('rates')}>维护</Button> : null}</header>
          {supplier.rates.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未登记参考价" /> : supplier.rates.map((item) => <div className="supplier-self-row" key={`${item.serviceCategoryCode}:${item.unit}`}><div><strong>{item.serviceCategoryCode}</strong><small>{item.unit} · {item.taxIncluded ? '含税' : '未税'}</small></div><b><DollarOutlined /> {minorToYuan(item.amountMinor)}</b></div>)}
        </article>
      </section>
      {canReadOpportunities ? <section className="supplier-self-opportunities">
        <header><div><span>OPEN OPPORTUNITIES</span><h2>可响应的合作机会</h2></div><Tag>{opportunities.length} 项</Tag></header>
        {opportunities.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="目前没有与你能力匹配的开放机会" /> : <div className="supplier-self-opportunity-list">{opportunities.map((item) => <article key={item.id}><FundProjectionScreenOutlined /><div><small>{item.requestNumber} · {item.serviceCategoryCode}</small><strong>{item.title}</strong><span>预算上限 ¥ {minorToYuan(item.budgetCeilingMinor)} · 截止 {new Date(item.responseDueAt).toLocaleDateString('zh-CN')}</span></div>{item.responded ? <Tag color="green">已响应 ¥ {minorToYuan(item.ownQuotationMinor!)}</Tag> : canRespond ? <Button type="primary" onClick={() => { setResponding(item); responseForm.setFieldsValue({ quotationYuan: minorToYuan(item.budgetCeilingMinor) }); }}>提交响应</Button> : <Tag>仅查看</Tag>}</article>)}</div>}
      </section> : null}
      {income === null ? null : <section className="supplier-self-income">
        <header><div><span>INCOME LEDGER</span><h2>我的收益进度</h2></div><WalletOutlined /></header>
        <div className="supplier-self-income-summary"><article><small>待审批</small><strong>¥ {minorToYuan(income.summary.awaitingAmountMinor)}</strong></article><article><small>付款处理中</small><strong>¥ {minorToYuan(income.summary.processingAmountMinor)}</strong></article><article><small>已支付</small><strong>¥ {minorToYuan(income.summary.paidAmountMinor)}</strong></article><article data-attention={income.summary.attentionAmountMinor === '0' ? 'false' : 'true'}><small>需关注</small><strong>¥ {minorToYuan(income.summary.attentionAmountMinor)}</strong></article></div>
        <div className="supplier-self-income-list">{income.items.slice(0, 8).map((item) => <div key={item.id}><span><strong>{item.payableNumber}</strong><small>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</small></span><b>¥ {minorToYuan(item.netAmountMinor)}</b><Tag color={item.status === 'paid' ? 'green' : ['failed', 'frozen'].includes(item.status) ? 'red' : 'blue'}>{incomeStatus(item.status)}</Tag></div>)}</div>
      </section>}
      <aside className="supplier-self-note"><SafetyCertificateOutlined /><div><strong>参考价不是成交价</strong><p>每次合作的范围、价格、履约者和验收条件会在独立委托中确认。</p></div><ArrowRightOutlined /></aside>
    </>}

    <Modal open={editing === 'capabilities'} title="维护服务能力" footer={null} onCancel={() => setEditing(null)} destroyOnHidden>
      <Form form={capabilityForm} layout="vertical" onFinish={(values: unknown) => {
        void saveCapabilities(values as { capabilities?: readonly Record<string, unknown>[] });
      }}>
        <Form.List name="capabilities">{(fields, { add, remove }) => <Space direction="vertical" className="supplier-self-form-list">{fields.map(({ key, name }) => <div className="supplier-self-form-card" key={key}><Form.Item name={[name, 'serviceCategoryCode']} label="服务分类" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name={[name, 'level']} label="能力等级" rules={[{ required: true }]}><Select options={LEVELS} /></Form.Item><Form.Item name={[name, 'validUntil']} label="有效期（可空）"><Input placeholder="YYYY-MM-DD" /></Form.Item><Button danger onClick={() => remove(name)}>移除</Button></div>)}<Button onClick={() => add({ level: 'basic', evidenceRef: null, validUntil: null })}>添加能力</Button></Space>}</Form.List>
        <Button block type="primary" htmlType="submit" loading={saving}>保存全部能力</Button>
      </Form>
    </Modal>
    <Modal open={editing === 'rates'} title="维护参考价" footer={null} onCancel={() => setEditing(null)} destroyOnHidden>
      <Form form={rateForm} layout="vertical" onFinish={(values: unknown) => {
        void saveRates(values as { rates?: readonly (Record<string, unknown> & { amountYuan?: string })[] });
      }}>
        <Form.List name="rates">{(fields, { add, remove }) => <Space direction="vertical" className="supplier-self-form-list">{fields.map(({ key, name }) => <div className="supplier-self-form-card" key={key}><Form.Item name={[name, 'serviceCategoryCode']} label="服务分类" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name={[name, 'unit']} label="计价单位" rules={[{ required: true }]}><Select options={UNITS} /></Form.Item><Form.Item name={[name, 'amountYuan']} label="参考价（元）" rules={[{ required: true }, { pattern: /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/u, message: '请输入最多两位小数的非负金额' }]}><Input inputMode="decimal" placeholder="0.00" /></Form.Item><Form.Item name={[name, 'validFrom']} label="生效日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item><Button danger onClick={() => remove(name)}>移除</Button></div>)}<Button onClick={() => add({ unit: 'per_project', amountYuan: '0.00', validFrom: new Date().toISOString().slice(0, 10), validUntil: null })}>添加参考价</Button></Space>}</Form.List>
        <Button block type="primary" htmlType="submit" loading={saving}>保存全部参考价</Button>
      </Form>
    </Modal>
    <Modal open={responding !== null} title="提交合作响应" footer={null} onCancel={() => setResponding(null)} destroyOnHidden>
      <Form form={responseForm} layout="vertical" onFinish={(values: unknown) => {
        void submitOpportunityResponse(values as { quotationYuan?: string; proposalRef?: string });
      }}>
        <Form.Item name="quotationYuan" label="本次报价（元）" rules={[{ required: true }, { pattern: /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/u, message: '请输入最多两位小数的非负金额' }]}><Input inputMode="decimal" /></Form.Item>
        <Form.Item name="proposalRef" label="方案证据引用" rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u }]}><Input placeholder="已受控存储的方案引用" /></Form.Item>
        <Alert type="info" showIcon title="方案正文不会进入审计、事件或本页面回执。" />
        <Button block type="primary" htmlType="submit" loading={saving}>确认提交</Button>
      </Form>
    </Modal>
    <Modal open={delivering !== null} title="提交交付版本" footer={null} onCancel={() => setDelivering(null)} destroyOnHidden>
      <Form form={deliveryForm} layout="vertical" onFinish={(values: unknown) => {
        void submitDelivery(values as { artifactRef?: string });
      }}>
        <Form.Item name="artifactRef" label="成果受控引用" rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u }]}><Input placeholder="请先将成果存入受控文件服务" /></Form.Item>
        <Alert showIcon type="info" title="页面、审计和业务事件只保存成果引用，不保存文件正文。" />
        <Button block type="primary" htmlType="submit" loading={saving}>确认提交</Button>
      </Form>
    </Modal>
  </main>;
}

function message(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.length > 0) return value.message;
  return fallback;
}

function incomeStatus(value: string): string {
  return ({ prepared: '已生成', pending_approval: '待审批', approved: '已批准', submitted: '付款处理中', paid: '已支付', failed: '付款失败', frozen: '已冻结' } as Readonly<Record<string, string>>)[value] ?? value;
}

function engagementStatus(value: string): string {
  return ({ draft: '草稿', pending_approval: '待审批', pending_signature: '待签署', active: '履约中', delivered: '待验收', accepted: '已验收', disputed: '争议中', cancelled: '已取消' } as Readonly<Record<string, string>>)[value] ?? value;
}
