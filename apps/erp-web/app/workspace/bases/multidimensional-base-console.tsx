'use client';

import {
  ApiOutlined, AppstoreOutlined, CalendarOutlined, CodeOutlined, DashboardOutlined,
  DatabaseOutlined, DeleteOutlined, EyeOutlined, FilterOutlined, FormOutlined, PlusOutlined,
  RobotOutlined, SearchOutlined, SettingOutlined, TableOutlined, ThunderboltOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import {
  Alert, Button, Checkbox, Drawer, Empty, Form, Input, InputNumber, List,
  Segmented, Select, Skeleton, Space, Switch, Tag, Typography, message,
} from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { createIdempotencyKey, erpFetch, strongEtag } from '../../lib/api-client';
import { createUlid } from '../forms/form-designer-contract';
import type {
  BaseDefinition, BaseField, BaseFilterCondition, BaseRecordRow, BaseView, MultidimensionalBase, ViewType,
} from './multidimensional-base-types';
import { MultidimensionalViewRenderer } from './multidimensional-view-renderers';
import { applyView } from './multidimensional-view-model';

const VIEW_META: Readonly<Record<ViewType, { readonly label: string; readonly icon: ReactNode; readonly hint: string }>> = {
  grid: { label: '表格', icon: <TableOutlined />, hint: '高密度编辑与排序' },
  kanban: { label: '看板', icon: <AppstoreOutlined />, hint: '按状态推进记录' },
  calendar: { label: '日历', icon: <CalendarOutlined />, hint: '按日期组织日程' },
  gallery: { label: '画册', icon: <UnorderedListOutlined />, hint: '卡片化浏览记录' },
  gantt: { label: '甘特', icon: <DashboardOutlined />, hint: '查看任务时间轴' },
  form: { label: '表单', icon: <FormOutlined />, hint: '对外收集结构化数据' },
  dashboard: { label: '仪表盘', icon: <DashboardOutlined />, hint: '聚合指标与数据质量' },
};

export function MultidimensionalBaseConsole() {
  const [bases, setBases] = useState<readonly MultidimensionalBase[]>([]);
  const [forms, setForms] = useState<readonly BaseDefinition[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [records, setRecords] = useState<readonly BaseRecordRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [recordsState, setRecordsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [createBaseOpen, setCreateBaseOpen] = useState(false);
  const [createViewOpen, setCreateViewOpen] = useState(false);
  const [createRecordOpen, setCreateRecordOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [baseResult, formResult] = await Promise.all([
        erpFetch<{ readonly items: readonly MultidimensionalBase[] }>('/api/multidimensional-bases'),
        erpFetch<{ readonly items: readonly BaseDefinition[] }>('/api/dynamic-forms'),
      ]);
      const nextBases = baseResult.data.items;
      setBases(nextBases);
      setForms(formResult.data.items.filter((form) => form.status === 'published'));
      setState('ready');
      setSelectedBaseId((current) => current !== null && nextBases.some((base) => base.id === current) ? current : nextBases[0]?.id ?? null);
    } catch { setState('error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const selectedBase = bases.find((base) => base.id === selectedBaseId) ?? null;
  useEffect(() => {
    const firstTable = selectedBase?.tables.toSorted((left, right) => left.position - right.position)[0]?.formId ?? null;
    setSelectedTableId((current) => current !== null && selectedBase?.tables.some((table) => table.formId === current) ? current : firstTable);
    setSearch('');
  }, [selectedBase]);
  const availableViews = useMemo(() => selectedBase?.views.filter((view) => view.tableId === selectedTableId) ?? [], [selectedBase, selectedTableId]);
  useEffect(() => { setSelectedViewId((current) => availableViews.some((view) => view.id === current) ? current : availableViews[0]?.id ?? null); }, [availableViews]);

  const loadRecords = useCallback(async (formId: string) => {
    setRecordsState('loading');
    try {
      const result = await erpFetch<{ readonly items: readonly BaseRecordRow[] }>(`/api/dynamic-forms/${formId}/records?limit=100`);
      setRecords(result.data.items); setRecordsState('ready');
    } catch { setRecords([]); setRecordsState('error'); }
  }, []);
  useEffect(() => { if (selectedTableId === null) { setRecords([]); setRecordsState('idle'); } else void loadRecords(selectedTableId); }, [loadRecords, selectedTableId]);

  const definition = forms.find((form) => form.id === selectedTableId) ?? null;
  const selectedView = availableViews.find((view) => view.id === selectedViewId) ?? null;
  const selectedTable = selectedBase?.tables.find((table) => table.formId === selectedTableId) ?? null;
  const fields = definition?.items.flatMap((item) => item.kind === 'field' ? [item.field] : []) ?? [];
  const filteredRecords = useMemo(() => applyView(records, selectedView, search), [records, search, selectedView]);

  const replaceBase = (base: MultidimensionalBase) => {
    setBases((current) => Object.freeze(current.map((item) => item.id === base.id ? base : item)));
  };
  const updateBase = async (base: MultidimensionalBase, views: readonly BaseView[]) => {
    const result = await erpFetch<{ readonly base: MultidimensionalBase }>(`/api/multidimensional-bases/${base.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': strongEtag(base.version), 'idempotency-key': createIdempotencyKey('base-update') },
      body: JSON.stringify({ definition: { name: base.name, description: base.description, tables: base.tables, views, automations: base.automations } }),
    });
    replaceBase(result.data.base);
    return result.data.base;
  };

  return <main className="base-console" aria-labelledby="base-title">
    <header className="base-hero"><div><Typography.Text type="secondary"><DatabaseOutlined /> GaoQ Data Workspace</Typography.Text><Typography.Title id="base-title" level={1}>多维数据工作台</Typography.Title><Typography.Paragraph>让表单、数据表、关联、自动化和审批围绕同一份业务记录协同运转。</Typography.Paragraph></div><Space wrap><Tag icon={<ApiOutlined />} color="blue">REST / OpenAPI</Tag><Tag icon={<RobotOutlined />} color="purple">MCP</Tag><Tag icon={<CodeOutlined />} color="cyan">CLI</Tag><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateBaseOpen(true)}>新建 Base</Button></Space></header>
    <Alert className="base-boundary-note" showIcon type="info" message="视图只改变呈现方式，不扩大记录或字段权限；所有外部写入仍经过租户、Scope、Schema、幂等与加密边界。" />
    {state === 'loading' ? <Skeleton active paragraph={{ rows: 12 }} /> : null}
    {state === 'error' ? <Alert type="warning" showIcon message="多维数据工作台暂不可用" description="请确认当前身份已获得 Base 与动态表单读取权限。" /> : null}
    {state === 'ready' ? <section className="base-workbench">
      <aside className="base-sidebar"><div className="base-sidebar-title"><span>空间</span><Tag>{bases.length}</Tag></div>{bases.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 Base" /> : <List dataSource={[...bases]} renderItem={(base) => <List.Item className={base.id === selectedBaseId ? 'is-selected' : ''} onClick={() => setSelectedBaseId(base.id)}><DatabaseOutlined /><span><strong>{base.name}</strong><small>{base.tables.length} 张表 · {base.automations.length} 个自动化</small></span></List.Item>}/>}<div className="base-sidebar-foot"><span><RobotOutlined /> MCP 原生读取</span><span><CodeOutlined /> CLI 批量管理</span><span><ApiOutlined /> OpenAPI 写入</span></div></aside>
      <div className="base-main">{selectedBase === null ? <Empty description="创建一个 Base，将已发布表单作为数据表接入" /> : <>
        <header className="base-main-header"><div><Typography.Title level={2}>{selectedBase.name}</Typography.Title><Typography.Paragraph>{selectedBase.description || '统一管理跨表关联与业务视图'}</Typography.Paragraph></div><Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>权限与设置</Button></header>
        <div className="base-table-tabs" role="tablist" aria-label="数据表">{selectedBase.tables.toSorted((left, right) => left.position - right.position).map((table) => <button key={table.formId} type="button" role="tab" aria-selected={table.formId === selectedTableId} className={table.formId === selectedTableId ? 'is-active' : ''} onClick={() => setSelectedTableId(table.formId)}><TableOutlined /> {table.name}<span>{table.formId === selectedTableId ? records.length : ''}</span></button>)}</div>
        <div className="base-view-tabs"><div role="tablist" aria-label="业务视图">{availableViews.map((view) => <button key={view.id} type="button" role="tab" aria-selected={view.id === selectedViewId} className={view.id === selectedViewId ? 'is-active' : ''} onClick={() => setSelectedViewId(view.id)}>{VIEW_META[view.type].icon}<span>{view.name}</span></button>)}<button type="button" className="is-add" aria-label="新建视图" onClick={() => setCreateViewOpen(true)}><PlusOutlined /></button></div><Button type="text" icon={<ThunderboltOutlined />} onClick={() => setSettingsOpen(true)}>{selectedBase.automations.length} 自动化</Button></div>
        <div className="base-command-bar"><Input allowClear prefix={<SearchOutlined />} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索当前视图" /><Space size={4} wrap><Button type="text" icon={<FilterOutlined />} onClick={() => setRulesOpen(true)}>筛选{selectedView?.config.filter?.conditions.length ? ` ${selectedView.config.filter.conditions.length}` : ''}</Button><Button type="text" icon={<UnorderedListOutlined />} onClick={() => setRulesOpen(true)}>排序{selectedView?.config.sorts.length ? ` ${selectedView.config.sorts.length}` : ''}</Button><Button type="text" icon={<EyeOutlined />} onClick={() => setFieldsOpen(true)}>字段</Button><Select aria-label="行高" value={selectedView?.config.rowHeight ?? 'medium'} options={[{ value: 'compact', label: '紧凑' }, { value: 'medium', label: '标准' }, { value: 'tall', label: '宽松' }]} disabled={selectedView === null} onChange={(rowHeight) => { void (async () => { if (selectedBase === null || selectedView === null) return; try { await updateBase(selectedBase, selectedBase.views.map((view) => view.id === selectedView.id ? { ...view, config: { ...view.config, rowHeight } } : view)); void message.success('视图行高已保存'); } catch { void message.error('视图设置保存失败'); } })(); }} /></Space><div className="base-command-actions"><span>{filteredRecords.length}{filteredRecords.length !== records.length ? ` / ${records.length}` : ''} 条记录</span><Button type="primary" icon={<PlusOutlined />} disabled={definition === null} onClick={() => setCreateRecordOpen(true)}>新建记录</Button></div></div>
        {recordsState === 'loading' ? <Skeleton active paragraph={{ rows: 8 }} /> : null}
        {recordsState === 'error' ? <Alert type="warning" showIcon message="记录读取失败" description="记录读取为敏感操作，审计或权限不可用时会失败关闭。" /> : null}
        {recordsState === 'ready' && records.length === 0 ? <Empty className="base-record-empty" description="当前数据表暂无记录；可通过表单、REST、CLI 或右上角新建记录写入" /> : null}
        {recordsState === 'ready' && records.length > 0 && filteredRecords.length === 0 ? <Empty className="base-record-empty" description="没有记录符合当前搜索或视图筛选条件" /> : null}
        {recordsState === 'ready' && filteredRecords.length > 0 && selectedView !== null && selectedTable !== null ? <MultidimensionalViewRenderer fields={fields} records={filteredRecords} view={selectedView} primaryFieldKey={selectedTable.primaryFieldKey} /> : null}
      </>}</div>
    </section> : null}
    <CreateBaseDrawer open={createBaseOpen} forms={forms} onClose={() => setCreateBaseOpen(false)} onCreated={async () => { setCreateBaseOpen(false); await load(); }} />
    <CreateViewDrawer open={createViewOpen} tableId={selectedTableId} onClose={() => setCreateViewOpen(false)} onCreate={async ({ name, type }) => { if (selectedBase === null || selectedTableId === null) return; const view: BaseView = { id: createUlid(), tableId: selectedTableId, name, type, config: { visibleFieldKeys: [], frozenFieldCount: 1, rowHeight: 'medium', sorts: [], groups: [] } }; try { const next = await updateBase(selectedBase, [...selectedBase.views, view]); setSelectedViewId(view.id); setCreateViewOpen(false); replaceBase(next); void message.success('新视图已创建'); } catch { void message.error('视图创建失败，请检查设计权限'); } }} />
    <CreateRecordDrawer open={createRecordOpen} definition={definition} onClose={() => setCreateRecordOpen(false)} onCreated={async () => { setCreateRecordOpen(false); if (selectedTableId !== null) await loadRecords(selectedTableId); }} />
    <FieldVisibilityDrawer open={fieldsOpen} base={selectedBase} view={selectedView} fields={fields} onClose={() => setFieldsOpen(false)} onApply={async (keys) => { if (selectedBase === null || selectedView === null) return; try { await updateBase(selectedBase, selectedBase.views.map((view) => view.id === selectedView.id ? { ...view, config: { ...view.config, visibleFieldKeys: keys } } : view)); setFieldsOpen(false); void message.success('可见字段已保存'); } catch { void message.error('字段设置保存失败'); } }} />
    <ViewRulesDrawer open={rulesOpen} view={selectedView} fields={fields} onClose={() => setRulesOpen(false)} onApply={async ({ conditions, mode, sorts }) => { if (selectedBase === null || selectedView === null) return; const filter = conditions.length === 0 ? undefined : { mode, conditions }; const views = selectedBase.views.map((view) => view.id === selectedView.id ? { ...view, config: { ...view.config, sorts, ...(filter === undefined ? { filter: undefined } : { filter }) } } : view); try { await updateBase(selectedBase, views as readonly BaseView[]); setRulesOpen(false); void message.success('筛选与排序已保存'); } catch { void message.error('视图规则保存失败'); } }} />
    <BaseSettingsDrawer open={settingsOpen} base={selectedBase} onClose={() => setSettingsOpen(false)} />
  </main>;
}

function CreateBaseDrawer(props: { readonly open: boolean; readonly forms: readonly BaseDefinition[]; readonly onClose: () => void; readonly onCreated: () => Promise<void> }) {
  const [form] = Form.useForm<{ name: string; code: string; description: string; tableIds: string[] }>();
  const [saving, setSaving] = useState(false);
  const submit = async (values: { name: string; code: string; description?: string; tableIds: string[] }) => {
    setSaving(true);
    try {
      const selected = values.tableIds.map((id, position) => { const definition = props.forms.find((item) => item.id === id); const fields = definition?.items.flatMap((item) => item.kind === 'field' ? [item.field] : []) ?? []; if (definition === undefined || fields[0] === undefined) throw new Error('FORM_SELECTION_INVALID'); return { formId: id, name: definition.name, primaryFieldKey: fields[0].key, position }; });
      const views = selected.map((table) => ({ id: createUlid(), tableId: table.formId, name: '默认表格', type: 'grid', config: { visibleFieldKeys: [], frozenFieldCount: 1, rowHeight: 'medium', sorts: [], groups: [] } }));
      await erpFetch('/api/multidimensional-bases', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('base-create') }, body: JSON.stringify({ code: values.code, definition: { name: values.name, description: values.description ?? '', tables: selected, views, automations: [] } }) });
      message.success('Base 已创建'); form.resetFields(); await props.onCreated();
    } catch { message.error('Base 创建失败，请检查权限与已发布表单'); } finally { setSaving(false); }
  };
  return <Drawer title="新建多维 Base" open={props.open} onClose={props.onClose} className="base-create-drawer" destroyOnHidden><Typography.Paragraph>选择已发布表单作为数据表。字段、附件、关联和敏感等级会原样复用。</Typography.Paragraph><Form form={form} layout="vertical" onFinish={(values) => { void submit(values); }} initialValues={{ tableIds: [], description: '' }}><Form.Item label="名称" name="name" rules={[{ required: true }, { min: 2, max: 128 }]}><Input placeholder="例如：招聘运营中心" /></Form.Item><Form.Item label="代码" name="code" rules={[{ required: true }, { pattern: /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u }]}><Input placeholder="recruitment_ops" /></Form.Item><Form.Item label="说明" name="description"><Input.TextArea rows={3} maxLength={500} /></Form.Item><Form.Item label="接入数据表" name="tableIds" rules={[{ required: true, type: 'array', min: 1 }]}><Select mode="multiple" options={props.forms.map((item) => ({ value: item.id, label: item.name }))} placeholder="选择已发布表单" /></Form.Item><Alert type="info" showIcon message="每张表自动建立默认表格视图，可继续添加看板、日历、画册、甘特、表单与仪表盘视图。" /><Button className="base-create-submit" block type="primary" htmlType="submit" loading={saving}>创建 Base</Button></Form></Drawer>;
}

function CreateViewDrawer(props: { readonly open: boolean; readonly tableId: string | null; readonly onClose: () => void; readonly onCreate: (value: { readonly name: string; readonly type: ViewType }) => Promise<void> }) {
  const [form] = Form.useForm<{ name: string; type: ViewType }>();
  const selectedType = Form.useWatch('type', form) ?? 'grid';
  return <Drawer title="新建业务视图" open={props.open} onClose={props.onClose} destroyOnHidden><Typography.Paragraph>视图共用同一份记录，只保存展示、筛选、分组和排序配置。</Typography.Paragraph><Form form={form} layout="vertical" initialValues={{ type: 'grid' }} onFinish={(values) => { void props.onCreate(values); }}><Form.Item name="name" label="视图名称" rules={[{ required: true, min: 1, max: 128 }]}><Input placeholder="例如：招聘漏斗" /></Form.Item><Form.Item name="type" label="视图类型" rules={[{ required: true }]}><div className="base-view-picker">{(Object.entries(VIEW_META) as [ViewType, (typeof VIEW_META)[ViewType]][]).map(([type, meta]) => <button key={type} type="button" onClick={() => form.setFieldValue('type', type)} className={selectedType === type ? 'is-selected' : ''}>{meta.icon}<span><strong>{meta.label}</strong><small>{meta.hint}</small></span></button>)}</div></Form.Item><Button type="primary" block htmlType="submit" disabled={props.tableId === null}>创建视图</Button></Form></Drawer>;
}

function CreateRecordDrawer(props: { readonly open: boolean; readonly definition: BaseDefinition | null; readonly onClose: () => void; readonly onCreated: () => Promise<void> }) {
  const [form] = Form.useForm<Record<string, unknown>>();
  const [saving, setSaving] = useState(false);
  const fields = props.definition?.items.flatMap((item) => item.kind === 'field' ? [item.field] : []) ?? [];
  const submit = async (values: Record<string, unknown>) => { if (props.definition === null) return; setSaving(true); try { await erpFetch(`/api/dynamic-forms/${props.definition.id}/records`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('base-record-create') }, body: JSON.stringify({ values }) }); message.success('记录已创建'); form.resetFields(); await props.onCreated(); } catch { message.error('记录创建失败，请检查字段格式和写权限'); } finally { setSaving(false); } };
  return <Drawer title={`新建记录${props.definition === null ? '' : ` · ${props.definition.name}`}`} open={props.open} onClose={props.onClose} width={520} destroyOnHidden><Form form={form} layout="vertical" onFinish={(values) => { void submit(values); }}>{fields.map((field) => field.type === 'related_property' ? null : <Form.Item key={field.key} name={field.key} label={<span>{field.label} <Tag>{field.sensitivity}</Tag></span>} valuePropName={field.type === 'boolean' ? 'checked' : 'value'} {...(field.required ? { rules: [{ required: true, message: `请填写${field.label}` }] } : {})}>{recordControl(field)}</Form.Item>)}{fields.some((field) => field.type === 'attachment') ? <Alert type="info" showIcon message="附件记录需先通过受控文件网关上传，再写入文件引用；本抽屉不会绕过上传边界。" /> : null}<Button className="base-create-submit" type="primary" block htmlType="submit" loading={saving}>创建记录</Button></Form></Drawer>;
}

function FieldVisibilityDrawer(props: { readonly open: boolean; readonly base: MultidimensionalBase | null; readonly view: BaseView | null; readonly fields: readonly BaseField[]; readonly onClose: () => void; readonly onApply: (keys: readonly string[]) => Promise<void> }) {
  const all = props.fields.map((field) => field.key);
  const [keys, setKeys] = useState<readonly string[]>(all);
  useEffect(() => { setKeys(props.view?.config.visibleFieldKeys.length ? props.view.config.visibleFieldKeys : all); }, [props.view, props.fields]);
  return <Drawer title="显示字段" open={props.open} onClose={props.onClose}><div className="base-field-visibility"><header><span>已显示 {keys.length} / {props.fields.length}</span><Button type="link" onClick={() => setKeys(keys.length === props.fields.length ? [] : all)}>{keys.length === props.fields.length ? '全部隐藏' : '全部显示'}</Button></header><Checkbox.Group value={[...keys]} onChange={(value) => setKeys(value.map(String))}>{props.fields.map((field) => <Checkbox key={field.key} value={field.key}><span><strong>{field.label}</strong><small>{field.type} · {field.sensitivity}</small></span></Checkbox>)}</Checkbox.Group><Button type="primary" block disabled={props.base === null || props.view === null || keys.length === 0} onClick={() => { void props.onApply(keys); }}>应用到当前视图</Button></div></Drawer>;
}

function ViewRulesDrawer(props: { readonly open: boolean; readonly view: BaseView | null; readonly fields: readonly BaseField[]; readonly onClose: () => void; readonly onApply: (value: { readonly mode: 'all' | 'any'; readonly conditions: readonly BaseFilterCondition[]; readonly sorts: readonly { readonly fieldKey: string; readonly direction: 'asc' | 'desc' }[] }) => Promise<void> }) {
  const [mode, setMode] = useState<'all' | 'any'>('all');
  const [conditions, setConditions] = useState<readonly BaseFilterCondition[]>([]);
  const [sorts, setSorts] = useState<readonly { readonly fieldKey: string; readonly direction: 'asc' | 'desc' }[]>([]);
  useEffect(() => { setMode(props.view?.config.filter?.mode ?? 'all'); setConditions(props.view?.config.filter?.conditions ?? []); setSorts(props.view?.config.sorts ?? []); }, [props.open, props.view]);
  const fieldOptions = props.fields.map((field) => ({ value: field.key, label: field.label }));
  const operatorOptions = [{ value: 'eq', label: '等于' }, { value: 'ne', label: '不等于' }, { value: 'contains', label: '包含' }, { value: 'not_contains', label: '不包含' }, { value: 'gt', label: '大于' }, { value: 'gte', label: '大于等于' }, { value: 'lt', label: '小于' }, { value: 'lte', label: '小于等于' }, { value: 'is_empty', label: '为空' }, { value: 'is_not_empty', label: '不为空' }] as const;
  return <Drawer title="筛选与排序" open={props.open} onClose={props.onClose} width={600}><div className="base-rules"><section><header><div><strong>筛选条件</strong><span>记录需满足{mode === 'all' ? '全部' : '任一'}条件</span></div><Segmented<'all' | 'any'> value={mode} options={[{ value: 'all', label: '且' }, { value: 'any', label: '或' }]} onChange={setMode} /></header>{conditions.map((condition, index) => { const unary = condition.operator === 'is_empty' || condition.operator === 'is_not_empty'; return <div className="base-rule-row" key={`${condition.fieldKey}-${index}`}><Select value={condition.fieldKey} options={fieldOptions} onChange={(fieldKey) => setConditions(conditions.map((item, target) => target === index ? { ...item, fieldKey } : item))} /><Select value={condition.operator} options={[...operatorOptions]} onChange={(operator) => setConditions(conditions.map((item, target) => target === index ? (operator === 'is_empty' || operator === 'is_not_empty' ? { fieldKey: item.fieldKey, operator } : { fieldKey: item.fieldKey, operator, value: '' }) : item))} />{unary ? <span className="base-rule-unary">无需填写值</span> : <Input value={typeof condition.value === 'string' || typeof condition.value === 'number' ? condition.value : ''} onChange={(event) => setConditions(conditions.map((item, target) => target === index ? { ...item, value: event.target.value } : item))} placeholder="比较值" />}<Button danger type="text" aria-label="删除筛选条件" icon={<DeleteOutlined />} onClick={() => setConditions(conditions.filter((_, target) => target !== index))} /></div>; })}<Button type="dashed" icon={<PlusOutlined />} disabled={props.fields.length === 0 || conditions.length >= 20} onClick={() => { const fieldKey = props.fields[0]?.key; if (fieldKey !== undefined) setConditions([...conditions, { fieldKey, operator: 'eq', value: '' }]); }}>添加筛选条件</Button></section><section><header><div><strong>排序规则</strong><span>按顺序执行，最多 10 条</span></div></header>{sorts.map((sort, index) => <div className="base-sort-row" key={`${sort.fieldKey}-${index}`}><Select value={sort.fieldKey} options={fieldOptions} onChange={(fieldKey) => setSorts(sorts.map((item, target) => target === index ? { ...item, fieldKey } : item))} /><Segmented<'asc' | 'desc'> value={sort.direction} options={[{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }]} onChange={(direction) => setSorts(sorts.map((item, target) => target === index ? { ...item, direction } : item))} /><Button danger type="text" aria-label="删除排序规则" icon={<DeleteOutlined />} onClick={() => setSorts(sorts.filter((_, target) => target !== index))} /></div>)}<Button type="dashed" icon={<PlusOutlined />} disabled={props.fields.length === 0 || sorts.length >= 10} onClick={() => { const fieldKey = props.fields[0]?.key; if (fieldKey !== undefined) setSorts([...sorts, { fieldKey, direction: 'asc' }]); }}>添加排序</Button></section><Button type="primary" block disabled={props.view === null} onClick={() => { void props.onApply({ mode, conditions, sorts }); }}>应用到当前视图</Button></div></Drawer>;
}

function BaseSettingsDrawer(props: { readonly open: boolean; readonly base: MultidimensionalBase | null; readonly onClose: () => void }) {
  return <Drawer title="权限、自动化与接入" open={props.open} onClose={props.onClose} width={520}>{props.base === null ? <Empty /> : <div className="base-settings"><Alert type="info" showIcon message="权限继承当前租户身份" description="Base、表定义、记录数据分别使用独立读取/设计/写入 Scope；敏感读取审计不可用时失败关闭。" /><section><header><strong>自动化</strong><Tag>{props.base.automations.length}</Tag></header>{props.base.automations.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置自动化" /> : props.base.automations.map((automation) => <article key={automation.id}><ThunderboltOutlined /><span><strong>{automation.name}</strong><small>{automation.trigger.type} · {automation.actions.length} 个动作</small></span><Tag color={automation.enabled ? 'green' : 'default'}>{automation.enabled ? '运行中' : '未启用'}</Tag></article>)}</section><section><header><strong>系统接入</strong></header><article><ApiOutlined /><span><strong>REST / OpenAPI</strong><small>外部系统按 Schema 与幂等键写入</small></span><Tag color="blue">可用</Tag></article><article><RobotOutlined /><span><strong>MCP</strong><small>复用应用服务的最小只读投影</small></span><Tag color="purple">原生</Tag></article><article><CodeOutlined /><span><strong>CLI</strong><small>批量导入与自动化运维入口</small></span><Tag color="cyan">原生</Tag></article></section><footer><code>{props.base.id}</code><span>版本 {props.base.version}</span></footer></div>}</Drawer>;
}

function recordControl(field: BaseField): ReactNode {
  if (field.type === 'long_text') return <Input.TextArea rows={4} maxLength={10_000} placeholder={field.placeholder || `请输入${field.label}`} />;
  if (field.type === 'number' || field.type === 'percentage') return <InputNumber className="console-full-width" />;
  if (field.type === 'money_minor') return <Input placeholder="请输入整数分，例如 120000" inputMode="numeric" />;
  if (field.type === 'boolean') return <Switch />;
  if (field.type === 'single_select' || field.type === 'radio') return <Select options={[...(field.options ?? [])]} placeholder="请选择" />;
  if (field.type === 'multi_select' || field.type === 'checkbox_group') return <Select mode="multiple" options={[...(field.options ?? [])]} placeholder="请选择" />;
  if (field.type === 'attachment') return <Input disabled placeholder="请先上传并选择文件引用" />;
  return <Input placeholder={field.placeholder || `请输入${field.label}`} />;
}
