'use client';

import {
  ApiOutlined, AppstoreOutlined, CalendarOutlined, CodeOutlined, DashboardOutlined,
  DatabaseOutlined, FormOutlined, PlusOutlined, RobotOutlined, SettingOutlined,
  TableOutlined, ThunderboltOutlined, UnorderedListOutlined,
} from '@ant-design/icons';
import { Alert, Button, Drawer, Empty, Flex, Form, Input, List, Segmented, Select, Skeleton, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { createIdempotencyKey, erpFetch } from '../../lib/api-client';
import { createUlid } from '../forms/form-designer-contract';

type ViewType = 'grid' | 'kanban' | 'calendar' | 'gallery' | 'gantt' | 'form' | 'dashboard';
interface Field { readonly key: string; readonly label: string; readonly type: string; readonly sensitivity: string }
interface Definition { readonly id: string; readonly code: string; readonly name: string; readonly status: string; readonly items: readonly ({ readonly kind: 'field'; readonly field: Field } | { readonly kind: 'layout' })[] }
interface BaseView { readonly id: string; readonly tableId: string; readonly name: string; readonly type: ViewType; readonly config: { readonly visibleFieldKeys: readonly string[]; readonly frozenFieldCount: number; readonly rowHeight: 'compact' | 'medium' | 'tall'; readonly sorts: readonly unknown[]; readonly groups: readonly string[] } }
interface Base { readonly id: string; readonly code: string; readonly name: string; readonly description: string; readonly version: number; readonly tables: readonly { readonly formId: string; readonly name: string; readonly primaryFieldKey: string; readonly position: number }[]; readonly views: readonly BaseView[]; readonly automations: readonly unknown[] }
interface RecordRow { readonly id: string; readonly version: number; readonly values: Readonly<Record<string, unknown>>; readonly updatedAt: string }

const VIEW_META: Readonly<Record<ViewType, { readonly label: string; readonly icon: ReactNode }>> = {
  grid: { label: '表格', icon: <TableOutlined /> }, kanban: { label: '看板', icon: <AppstoreOutlined /> }, calendar: { label: '日历', icon: <CalendarOutlined /> },
  gallery: { label: '画册', icon: <UnorderedListOutlined /> }, gantt: { label: '甘特', icon: <DashboardOutlined /> }, form: { label: '表单', icon: <FormOutlined /> }, dashboard: { label: '仪表盘', icon: <DashboardOutlined /> },
};

export function MultidimensionalBaseConsole() {
  const [bases, setBases] = useState<readonly Base[]>([]);
  const [forms, setForms] = useState<readonly Definition[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [records, setRecords] = useState<readonly RecordRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [recordsState, setRecordsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [baseResult, formResult] = await Promise.all([
        erpFetch<{ readonly items: readonly Base[] }>('/api/multidimensional-bases'),
        erpFetch<{ readonly items: readonly Definition[] }>('/api/dynamic-forms'),
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
  }, [selectedBase]);
  const availableViews = selectedBase?.views.filter((view) => view.tableId === selectedTableId) ?? [];
  useEffect(() => { setSelectedViewId((current) => availableViews.some((view) => view.id === current) ? current : availableViews[0]?.id ?? null); }, [availableViews]);

  const loadRecords = useCallback(async (formId: string) => {
    setRecordsState('loading');
    try {
      const result = await erpFetch<{ readonly items: readonly RecordRow[] }>(`/api/dynamic-forms/${formId}/records?limit=100`);
      setRecords(result.data.items); setRecordsState('ready');
    } catch { setRecords([]); setRecordsState('error'); }
  }, []);
  useEffect(() => { if (selectedTableId === null) { setRecords([]); setRecordsState('idle'); } else void loadRecords(selectedTableId); }, [loadRecords, selectedTableId]);

  const definition = forms.find((form) => form.id === selectedTableId) ?? null;
  const selectedView = availableViews.find((view) => view.id === selectedViewId) ?? null;
  const fields = definition?.items.flatMap((item) => item.kind === 'field' ? [item.field] : []) ?? [];
  const visible = selectedView?.config.visibleFieldKeys.length ? fields.filter((field) => selectedView.config.visibleFieldKeys.includes(field.key)) : fields;
  const columns = useMemo<ColumnsType<RecordRow>>(() => [
    { title: '#', dataIndex: 'id', key: 'id', fixed: 'left', width: 86, render: (id: string) => <Typography.Text code>{id.slice(-6)}</Typography.Text> },
    ...visible.map((field) => ({ title: <span>{field.label}{['L3', 'L4'].includes(field.sensitivity) ? <Tag color="orange">{field.sensitivity}</Tag> : null}</span>, key: field.key, width: 180, render: (_: unknown, row: RecordRow) => renderValue(row.values[field.key], field.type) })),
    { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 180, render: (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false }) },
  ], [visible]);

  return <main className="base-console" aria-labelledby="base-title">
    <header className="base-hero"><div><Typography.Text type="secondary"><DatabaseOutlined /> GaoQ Data Workspace</Typography.Text><Typography.Title id="base-title" level={1}>多维数据工作台</Typography.Title><Typography.Paragraph>同一份记录同时服务表单填写、表格管理、审批、自动化与外部系统接入。</Typography.Paragraph></div><Space wrap><Tag icon={<ApiOutlined />} color="blue">REST / OpenAPI</Tag><Tag icon={<RobotOutlined />} color="purple">MCP</Tag><Tag icon={<CodeOutlined />} color="cyan">CLI</Tag><Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>新建 Base</Button></Space></header>
    <Alert className="base-boundary-note" showIcon type="info" message="外部系统写入仍经过租户、Scope、Schema、幂等与加密边界；数据表视图不会绕过表单字段规则。" />
    {state === 'loading' ? <Skeleton active paragraph={{ rows: 12 }} /> : null}
    {state === 'error' ? <Alert type="warning" showIcon message="多维数据工作台暂不可用" description="请确认当前身份已获得 Base 与动态表单读取权限。" /> : null}
    {state === 'ready' ? <section className="base-workbench">
      <aside className="base-sidebar"><div className="base-sidebar-title"><span>空间</span><Tag>{bases.length}</Tag></div>{bases.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 Base" /> : <List dataSource={[...bases]} renderItem={(base) => <List.Item className={base.id === selectedBaseId ? 'is-selected' : ''} onClick={() => setSelectedBaseId(base.id)}><DatabaseOutlined /><span><strong>{base.name}</strong><small>{base.tables.length} 张表 · {base.automations.length} 个自动化</small></span></List.Item>} />}</aside>
      <div className="base-main">{selectedBase === null ? <Empty description="创建一个 Base，将已发布表单作为数据表接入" /> : <>
        <header className="base-main-header"><div><Typography.Title level={2}>{selectedBase.name}</Typography.Title><Typography.Paragraph>{selectedBase.description || '统一管理跨表关联与业务视图'}</Typography.Paragraph></div><Button icon={<SettingOutlined />}>权限与设置</Button></header>
        <div className="base-table-tabs" role="tablist" aria-label="数据表">{selectedBase.tables.toSorted((left, right) => left.position - right.position).map((table) => <button key={table.formId} type="button" className={table.formId === selectedTableId ? 'is-active' : ''} onClick={() => setSelectedTableId(table.formId)}><TableOutlined /> {table.name}</button>)}</div>
        <Flex className="base-view-bar" justify="space-between" align="center" gap={12} wrap><Segmented<string> value={selectedViewId ?? ''} options={availableViews.map((view) => ({ value: view.id, label: <span>{VIEW_META[view.type].icon} {view.name}</span> }))} onChange={setSelectedViewId} /><Space><Tag icon={<ThunderboltOutlined />}>{selectedBase.automations.length} 自动化</Tag><Button icon={<PlusOutlined />}>新建视图</Button></Space></Flex>
        {recordsState === 'loading' ? <Skeleton active paragraph={{ rows: 8 }} /> : null}
        {recordsState === 'error' ? <Alert type="warning" showIcon message="记录读取失败" description="记录读取为敏感操作，审计或权限不可用时会失败关闭。" /> : null}
        {recordsState === 'ready' && records.length === 0 ? <Empty className="base-record-empty" description="当前数据表暂无记录；可通过表单、REST 或 CLI 写入" /> : null}
        {recordsState === 'ready' && records.length > 0 && selectedView?.type === 'grid' ? <Table<RecordRow> className={`base-data-table row-${selectedView.config.rowHeight}`} rowKey="id" dataSource={[...records]} columns={columns} pagination={{ pageSize: 50, showSizeChanger: false }} scroll={{ x: Math.max(900, columns.length * 180), y: 560 }} /> : null}
        {recordsState === 'ready' && records.length > 0 && selectedView?.type !== 'grid' && selectedView !== null ? <ViewPlaceholder view={selectedView} count={records.length} /> : null}
      </>}</div>
    </section> : null}
    <CreateBaseDrawer open={drawerOpen} forms={forms} onClose={() => setDrawerOpen(false)} onCreated={async () => { setDrawerOpen(false); await load(); }} />
  </main>;
}

function ViewPlaceholder({ view, count }: { readonly view: BaseView; readonly count: number }) {
  const meta = VIEW_META[view.type];
  return <div className="base-view-placeholder"><span>{meta.icon}</span><Typography.Title level={3}>{meta.label}视图已接入统一 View 定义</Typography.Title><Typography.Paragraph>当前有 {count} 条记录。该视图的专用布局渲染器将在后续切片启用，底层记录与权限边界已经一致。</Typography.Paragraph></div>;
}

function CreateBaseDrawer(props: { readonly open: boolean; readonly forms: readonly Definition[]; readonly onClose: () => void; readonly onCreated: () => Promise<void> }) {
  const [form] = Form.useForm<{ name: string; code: string; description: string; tableIds: string[] }>();
  const [saving, setSaving] = useState(false);
  const submit = async (values: { name: string; code: string; description?: string; tableIds: string[] }) => {
    setSaving(true);
    try {
      const selected = values.tableIds.map((id, position) => {
        const definition = props.forms.find((item) => item.id === id);
        const fields = definition?.items.flatMap((item) => item.kind === 'field' ? [item.field] : []) ?? [];
        if (definition === undefined || fields[0] === undefined) throw new Error('FORM_SELECTION_INVALID');
        return { formId: id, name: definition.name, primaryFieldKey: fields[0].key, position };
      });
      const views = selected.map((table) => ({ id: createUlid(), tableId: table.formId, name: '默认表格', type: 'grid', config: { visibleFieldKeys: [], frozenFieldCount: 1, rowHeight: 'medium', sorts: [], groups: [] } }));
      await erpFetch('/api/multidimensional-bases', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('base-create') }, body: JSON.stringify({ code: values.code, definition: { name: values.name, description: values.description ?? '', tables: selected, views, automations: [] } }) });
      message.success('Base 已创建'); form.resetFields(); await props.onCreated();
    } catch { message.error('Base 创建失败，请检查权限与已发布表单'); } finally { setSaving(false); }
  };
  return <Drawer title="新建多维 Base" open={props.open} onClose={props.onClose} className="base-create-drawer" destroyOnHidden><Typography.Paragraph>选择已发布表单作为数据表。字段、附件、关联和敏感等级会原样复用。</Typography.Paragraph><Form form={form} layout="vertical" onFinish={(values) => { void submit(values); }} initialValues={{ tableIds: [], description: '' }}><Form.Item label="名称" name="name" rules={[{ required: true }, { min: 2, max: 128 }]}><Input placeholder="例如：招聘运营中心" /></Form.Item><Form.Item label="代码" name="code" rules={[{ required: true }, { pattern: /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u }]}><Input placeholder="recruitment_ops" /></Form.Item><Form.Item label="说明" name="description"><Input.TextArea rows={3} maxLength={500} /></Form.Item><Form.Item label="接入数据表" name="tableIds" rules={[{ required: true, type: 'array', min: 1 }]}><Select mode="multiple" options={props.forms.map((item) => ({ value: item.id, label: item.name }))} placeholder="选择已发布表单" /></Form.Item><Alert type="info" showIcon message="每张表自动建立默认表格视图，可继续添加看板、日历、画册、甘特、表单与仪表盘视图。" /><Button className="base-create-submit" block type="primary" htmlType="submit" loading={saving}>创建 Base</Button></Form></Drawer>;
}

function renderValue(value: unknown, type: string): ReactNode {
  if (value === undefined || value === null || value === '') return <Typography.Text type="secondary">—</Typography.Text>;
  if (type === 'boolean') return <Tag color={value ? 'green' : 'default'}>{value ? '是' : '否'}</Tag>;
  if (type === 'attachment') return <Tag>{Array.isArray(value) ? value.length : 1} 个附件</Tag>;
  if (Array.isArray(value)) return <Space size={[4, 4]} wrap>{value.slice(0, 4).map((item, index) => <Tag key={`${String(item)}-${index}`}>{String(item)}</Tag>)}</Space>;
  if (typeof value === 'object') return <Typography.Text type="secondary">结构化数据</Typography.Text>;
  return <Typography.Text ellipsis={{ tooltip: String(value) }}>{String(value)}</Typography.Text>;
}
