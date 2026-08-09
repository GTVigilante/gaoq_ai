'use client';

import {
  ApartmentOutlined, ArrowDownOutlined, ArrowUpOutlined, CalendarOutlined,
  CheckSquareOutlined, CloudUploadOutlined, DatabaseOutlined, DeleteOutlined,
  CopyOutlined, DesktopOutlined, DollarOutlined, DragOutlined, FileAddOutlined, FileTextOutlined,
  FontSizeOutlined, LinkOutlined, MailOutlined, NumberOutlined, PaperClipOutlined,
  PhoneOutlined, PlusOutlined, RedoOutlined, SaveOutlined, SafetyCertificateOutlined, SearchOutlined,
  SelectOutlined, TeamOutlined, NotificationOutlined, UserOutlined,
  MobileOutlined, UndoOutlined,
} from '@ant-design/icons';
import {
  Alert, App as AntApp, Badge, Button, Checkbox, Drawer, Empty, Flex, Input,
  InputNumber, Radio, Select, Segmented, Space, Spin, Switch, Tag, Tooltip, Typography,
} from 'antd';
import type { Dispatch, DragEvent, ReactNode, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { createIdempotencyKey, ErpApiError, erpFetch, strongEtag } from '../../lib/api-client';
import {
  createDesignerItem, duplicateDesignerItem, itemId, moveItem, PALETTE, type DesignerField,
  type DesignerItem, type DesignerLayout, type FieldType, type PaletteEntry, type WorkflowNode,
} from './form-designer-contract';

type View = 'design' | 'process' | 'preview' | 'relations';
type SaveState = 'idle' | 'saving' | 'loading';
type AttachmentAccept = NonNullable<DesignerField['attachment']>['accept'][number];
interface StoredForm {
  readonly id: string; readonly code: string; readonly name: string;
  readonly description: string; readonly items: readonly DesignerItem[];
  readonly workflow?: { readonly riskLevel: 'R1' | 'R2'; readonly nodes: readonly WorkflowNode[] };
  readonly status: 'draft' | 'published' | 'retired'; readonly revision: number; readonly version: number;
}
interface FormListResult { readonly items: readonly StoredForm[] }
interface FormMutationResult { readonly form: StoredForm }
interface ApprovalMutationResult { readonly template: { readonly id: string; readonly code: string; readonly revision: number; readonly version: number } }
interface DesignerHistory { readonly past: readonly (readonly DesignerItem[])[]; readonly present: readonly DesignerItem[]; readonly future: readonly (readonly DesignerItem[])[] }

const GROUPS = ['基础字段', '选择与组织', '业务与关联', '布局组件'] as const;
const ICONS: Readonly<Record<FieldType | DesignerLayout['type'], ReactNode>> = {
  short_text: <FontSizeOutlined />, long_text: <FileTextOutlined />, number: <NumberOutlined />,
  money_minor: <DollarOutlined />, percentage: <NumberOutlined />, boolean: <CheckSquareOutlined />,
  date: <CalendarOutlined />, datetime: <CalendarOutlined />, time: <CalendarOutlined />,
  email: <MailOutlined />, phone: <PhoneOutlined />, url: <LinkOutlined />,
  single_select: <SelectOutlined />, multi_select: <SelectOutlined />, radio: <CheckSquareOutlined />,
  checkbox_group: <CheckSquareOutlined />, employee: <TeamOutlined />, department: <ApartmentOutlined />,
  attachment: <PaperClipOutlined />, relation_single: <LinkOutlined />, relation_multiple: <LinkOutlined />,
  related_property: <DatabaseOutlined />, section: <FileAddOutlined />, description: <FileTextOutlined />,
  divider: <DragOutlined />,
};

/** 氚云式三栏设计器；鼠标拖拽与键盘排序共享同一状态模型。 */
export function DynamicFormDesigner() {
  const { message, modal } = AntApp.useApp();
  const [name, setName] = useState('员工异动申请');
  const [code, setCode] = useState('employee_change');
  const [description, setDescription] = useState('收集员工异动信息，并关联员工与目标部门。');
  const [history, setHistory] = useState<DesignerHistory>(() => ({ past: [], present: seedItems(), future: [] }));
  const items = history.present;
  const [riskLevel, setRiskLevel] = useState<'R1' | 'R2'>('R1');
  const [workflowNodes, setWorkflowNodes] = useState<readonly WorkflowNode[]>(() => seedWorkflow());
  const [selectedId, setSelectedId] = useState<string | null>(() => itemId(seedItems()[1]!));
  const [view, setView] = useState<View>('design');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [stored, setStored] = useState<StoredForm | null>(null);
  const [forms, setForms] = useState<readonly StoredForm[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const selected = items.find((item) => itemId(item) === selectedId) ?? null;
  const editable = stored?.status !== 'published';

  const load = useCallback(async () => {
    try {
      const result = await erpFetch<FormListResult>('/api/dynamic-forms');
      setForms(result.data.items);
    } catch {
      setForms([]);
    } finally {
      setSaveState('idle');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = useCallback((entry: PaletteEntry, at = items.length) => {
    if (!editable) return;
    const item = createDesignerItem(entry, items);
    commitItems(setHistory, (current) => Object.freeze([...current.slice(0, at), item, ...current.slice(at)]));
    setSelectedId(itemId(item)); setView('design');
  }, [editable, items]);

  const remove = useCallback((id: string) => {
    if (!editable) return;
    const target = items.find((item) => itemId(item) === id);
    if (target === undefined) return;
    const references = target.kind === 'field'
      ? items.filter((item) => item.kind === 'field' && item.field.relatedProperty?.relationFieldKey === target.field.key).length + workflowNodes.filter((node) => node.condition?.field === target.field.key || (node.resolver.type === 'department_manager' && node.resolver.departmentField === target.field.key)).length
      : 0;
    modal.confirm({
      title: target.kind === 'field' ? `删除字段“${target.field.label}”？` : `删除组件“${target.layout.title}”？`,
      content: references === 0 ? '删除会从当前草稿移除该组件。已发布修订和历史记录不会被改写。' : `检测到 ${references} 处关联属性或流程引用。请先确认依赖；保存时仍会执行完整定义校验。`,
      okText: '删除组件', okButtonProps: { danger: true },
      onOk: () => { commitItems(setHistory, (current) => Object.freeze(current.filter((item) => itemId(item) !== id))); setSelectedId((current) => current === id ? null : current); },
    });
  }, [editable, items, modal, workflowNodes]);

  const reorder = useCallback((from: number, to: number) => {
    if (!editable) return;
    commitItems(setHistory, (current) => moveItem(current, from, to));
  }, [editable]);

  const drop = useCallback((event: DragEvent, at: number) => {
    event.preventDefault();
    if (!editable) return;
    const dragged = event.dataTransfer.getData('application/x-gaoq-form-item');
    if (dragged !== '') {
      const from = items.findIndex((item) => itemId(item) === dragged);
      if (from >= 0) {
        const target = Math.min(items.length - 1, from < at ? at - 1 : at);
        reorder(from, Math.max(0, target));
      }
      setDraggingId(null); return;
    }
    const type = event.dataTransfer.getData('application/x-gaoq-field-type');
    const entry = PALETTE.find((candidate) => candidate.type === type);
    if (entry !== undefined) add(entry, at);
  }, [add, editable, items, reorder]);

  const save = async () => {
    const issue = validationIssue(name, code, items);
    if (issue !== null) { void message.error(issue); return; }
    setSaveState('saving');
    try {
      const body = { definition: { name: name.trim(), description: description.trim(), items, workflow: { riskLevel, nodes: workflowNodes } } };
      const result = stored === null
        ? await erpFetch<FormMutationResult>('/api/dynamic-forms', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('dynamic-form-create') }, body: JSON.stringify({ code, ...body }) })
        : await erpFetch<FormMutationResult>(`/api/dynamic-forms/${encodeURIComponent(stored.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('dynamic-form-update'), 'if-match': strongEtag(stored.version) }, body: JSON.stringify(body) });
      setStored(result.data.form); setForms((current) => Object.freeze([result.data.form, ...current.filter((item) => item.id !== result.data.form.id)]));
      void message.success(stored === null ? '表单草稿已创建' : '表单草稿已更新');
    } catch (error) { showError(modal, error, '表单草稿保存失败'); }
    finally { setSaveState('idle'); }
  };

  const syncApprovalTemplate = async () => {
    const issue = workflowIssue(workflowNodes, items);
    if (issue !== null) { void message.error(issue); return; }
    setSaveState('saving');
    try {
      const result = await erpFetch<ApprovalMutationResult>('/api/approvals/templates', {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('dynamic-form-approval-adapter') },
        body: JSON.stringify({ code: `${code}.approval`, name, riskLevel, definition: { fields: approvalFields(items), nodes: workflowNodes.map(approvalNode) } }),
      });
      void message.success(`已生成审批模板 ${result.data.template.code} · 修订 ${result.data.template.revision}`);
    } catch (error) { showError(modal, error, '审批模板生成失败'); }
    finally { setSaveState('idle'); }
  };

  const publish = async () => {
    if (stored === null) return;
    setSaveState('saving');
    try {
      const result = await erpFetch<FormMutationResult>(`/api/dynamic-forms/${encodeURIComponent(stored.id)}/publish`, { method: 'POST', headers: { 'idempotency-key': createIdempotencyKey('dynamic-form-publish'), 'if-match': strongEtag(stored.version) } });
      setStored(result.data.form); setPublishOpen(false); void message.success('表单已发布，定义现已锁定');
    } catch (error) { showError(modal, error, '表单发布失败'); }
    finally { setSaveState('idle'); }
  };

  const updateField = (patch: Partial<DesignerField>) => {
    if (selected?.kind !== 'field' || !editable) return;
    commitItems(setHistory, (current) => Object.freeze(current.map((item) => item.kind === 'field' && item.field.id === selected.field.id ? { kind: 'field' as const, field: { ...item.field, ...patch } } : item)));
  };
  const updateLayout = (patch: Partial<DesignerLayout>) => {
    if (selected?.kind !== 'layout' || !editable) return;
    commitItems(setHistory, (current) => Object.freeze(current.map((item) => item.kind === 'layout' && item.layout.id === selected.layout.id ? { kind: 'layout' as const, layout: { ...item.layout, ...patch } } : item)));
  };

  const duplicateSelected = () => {
    if (selected === null || !editable) return;
    const index = items.findIndex((item) => itemId(item) === itemId(selected));
    const copy = duplicateDesignerItem(selected, items);
    commitItems(setHistory, (current) => Object.freeze([...current.slice(0, index + 1), copy, ...current.slice(index + 1)]));
    setSelectedId(itemId(copy));
  };
  const undo = () => setHistory((current) => current.past.length === 0 ? current : { past: current.past.slice(0, -1), present: current.past.at(-1)!, future: [current.present, ...current.future] });
  const redo = () => setHistory((current) => current.future.length === 0 ? current : { past: [...current.past, current.present], present: current.future[0]!, future: current.future.slice(1) });

  return <main className="form-studio" aria-labelledby="forms-title">
    <header className="form-studio-header">
      <div>
        <Typography.Title id="forms-title" level={1}>表单设计</Typography.Title>
        <Typography.Paragraph>拖入字段，设置数据规则，再用关联字段连接不同业务表单。</Typography.Paragraph>
      </div>
      <Flex gap={10} wrap align="center">
        {stored === null ? <Tag>未保存草稿</Tag> : <Tag color={stored.status === 'published' ? 'green' : 'blue'}>{stored.status === 'published' ? '已发布' : `草稿 v${stored.version}`}</Tag>}
        <Segmented<View> value={view} onChange={setView} options={[{ value: 'design', label: '表单' }, { value: 'process', label: '流程' }, { value: 'preview', label: '填写预览' }, { value: 'relations', label: '数据关系' }]} />
        <Space.Compact className="form-history-actions"><Tooltip title="撤销"><Button aria-label="撤销" icon={<UndoOutlined />} disabled={!editable || history.past.length === 0} onClick={undo} /></Tooltip><Tooltip title="重做"><Button aria-label="重做" icon={<RedoOutlined />} disabled={!editable || history.future.length === 0} onClick={redo} /></Tooltip><Tooltip title="复制选中组件"><Button aria-label="复制选中组件" icon={<CopyOutlined />} disabled={!editable || selected === null} onClick={duplicateSelected} /></Tooltip></Space.Compact>
        <Button icon={<SaveOutlined />} loading={saveState === 'saving'} disabled={!editable} onClick={() => { void save(); }}>保存草稿</Button>
        <Button type="primary" disabled={stored === null || stored.status !== 'draft'} onClick={() => setPublishOpen(true)}>发布</Button>
      </Flex>
    </header>

    <section className="form-meta" aria-label="表单基本信息">
      <label><span>表单名称</span><Input value={name} maxLength={128} disabled={!editable} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>表单编码</span><Input value={code} maxLength={64} disabled={stored !== null} onChange={(event) => setCode(event.target.value)} /></label>
      <label className="form-meta-description"><span>用途说明</span><Input value={description} maxLength={500} disabled={!editable} onChange={(event) => setDescription(event.target.value)} /></label>
    </section>

    {saveState === 'loading' ? <div className="form-studio-loading"><Spin /><span>正在读取可关联表单…</span></div> : null}
    {view === 'design' ? <div className="form-studio-grid">
      <Palette editable={editable} onAdd={add} />
      <DesignerCanvas items={items} selectedId={selectedId} draggingId={draggingId} editable={editable} onSelect={setSelectedId} onRemove={remove} onReorder={reorder} onDrop={drop} onDragStart={(id) => setDraggingId(id)} onDragEnd={() => setDraggingId(null)} />
      <PropertyPanel item={selected} items={items} forms={forms} editable={editable} onFieldChange={updateField} onLayoutChange={updateLayout} />
    </div> : null}
    {view === 'process' ? <WorkflowDesigner nodes={workflowNodes} fields={items.flatMap((item) => item.kind === 'field' ? [item.field] : [])} riskLevel={riskLevel} editable={editable} syncing={saveState === 'saving'} onRiskChange={setRiskLevel} onChange={setWorkflowNodes} onSync={() => { void syncApprovalTemplate(); }} /> : null}
    {view === 'preview' ? <FormPreview name={name} description={description} items={items} /> : null}
    {view === 'relations' ? <RelationMap currentName={name} items={items} forms={forms} /> : null}

    <Drawer title="发布前复核" open={publishOpen} onClose={() => setPublishOpen(false)} rootClassName="form-publish-drawer" extra={<SafetyCertificateOutlined />}>
      <Alert type="warning" showIcon message="发布后本修订不可编辑" description="发布必须由独立复核人执行。请核对字段敏感级别、附件策略和所有关联目标；创建者不能发布自己的草稿。" />
      <dl className="form-publish-summary"><div><dt>表单</dt><dd>{name}</dd></div><div><dt>字段</dt><dd>{items.filter((item) => item.kind === 'field').length} 个</dd></div><div><dt>关联</dt><dd>{items.filter((item) => item.kind === 'field' && item.field.relation !== undefined).length} 条定义</dd></div><div><dt>修订</dt><dd>{stored?.revision ?? 1}</dd></div></dl>
      <Button type="primary" block disabled={stored === null} loading={saveState === 'saving'} onClick={() => { void publish(); }}>确认复核并发布</Button>
    </Drawer>
  </main>;
}

function Palette({ editable, onAdd }: { readonly editable: boolean; readonly onAdd: (entry: PaletteEntry) => void }) {
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLocaleLowerCase('zh-CN');
  return <aside className="form-palette" aria-label="字段组件库">
    <div className="form-panel-heading"><strong>字段组件</strong><span>拖到中间画布</span></div><div className="form-palette-search"><Input allowClear prefix={<SearchOutlined />} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索字段" /></div>
    <div className="form-palette-scroll">{GROUPS.map((group) => { const entries = PALETTE.filter((entry) => entry.group === group && (keyword === '' || `${entry.label}${entry.hint}`.toLocaleLowerCase('zh-CN').includes(keyword))); return entries.length === 0 ? null : <section key={group}><h2>{group}</h2><div className="form-palette-list">{entries.map((entry) => <button key={entry.type} type="button" draggable={editable} disabled={!editable} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-gaoq-field-type', entry.type); }} onClick={() => onAdd(entry)}><span className="form-palette-icon">{ICONS[entry.type]}</span><span><strong>{entry.label}</strong><small>{entry.hint}</small></span><PlusOutlined /></button>)}</div></section>; })}</div>
  </aside>;
}

function DesignerCanvas(props: { readonly items: readonly DesignerItem[]; readonly selectedId: string | null; readonly draggingId: string | null; readonly editable: boolean; readonly onSelect: (id: string) => void; readonly onRemove: (id: string) => void; readonly onReorder: (from: number, to: number) => void; readonly onDrop: (event: DragEvent, at: number) => void; readonly onDragStart: (id: string) => void; readonly onDragEnd: () => void }) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  return <section className="form-canvas" aria-label="表单画布">
    <div className="form-canvas-bar"><Segmented<'desktop' | 'mobile'> value={device} options={[{ value: 'desktop', label: <span><DesktopOutlined /> 桌面</span> }, { value: 'mobile', label: <span><MobileOutlined /> 手机</span> }]} onChange={setDevice} /><Badge status="processing" text={`${props.items.length} 个组件`} /></div>
    <div className={`form-canvas-sheet is-${device}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => props.onDrop(event, props.items.length)}>
      {props.items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="把左侧字段拖到这里，或点击字段直接添加" /> : null}
      {props.items.map((item, index) => <div key={itemId(item)} className="form-canvas-slot">
        <DropLine onDrop={(event) => props.onDrop(event, index)} />
        <div className={`form-canvas-item${props.selectedId === itemId(item) ? ' is-selected' : ''}${props.draggingId === itemId(item) ? ' is-dragging' : ''}`} draggable={props.editable} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-gaoq-form-item', itemId(item)); props.onDragStart(itemId(item)); }} onDragEnd={props.onDragEnd} onClick={() => props.onSelect(itemId(item))}>
          <div className="form-drag-handle" aria-hidden="true"><DragOutlined /></div>
          <div className="form-item-content">{item.kind === 'field' ? <FieldPreview field={item.field} /> : <LayoutPreview layout={item.layout} />}</div>
          <div className="form-item-actions"><Tooltip title="上移"><Button size="small" type="text" aria-label="上移组件" icon={<ArrowUpOutlined />} disabled={!props.editable || index === 0} onClick={(event) => { event.stopPropagation(); props.onReorder(index, index - 1); }} /></Tooltip><Tooltip title="下移"><Button size="small" type="text" aria-label="下移组件" icon={<ArrowDownOutlined />} disabled={!props.editable || index === props.items.length - 1} onClick={(event) => { event.stopPropagation(); props.onReorder(index, index + 1); }} /></Tooltip><Tooltip title="删除"><Button size="small" danger type="text" aria-label="删除组件" icon={<DeleteOutlined />} disabled={!props.editable} onClick={(event) => { event.stopPropagation(); props.onRemove(itemId(item)); }} /></Tooltip></div>
        </div>
      </div>)}
      {props.items.length > 0 ? <DropLine onDrop={(event) => props.onDrop(event, props.items.length)} /> : null}
    </div>
  </section>;
}

function DropLine({ onDrop }: { readonly onDrop: (event: DragEvent) => void }) { return <div className="form-drop-line" onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => { event.stopPropagation(); onDrop(event); }}><span>放到这里</span></div>; }

function FieldPreview({ field }: { readonly field: DesignerField }) {
  return <div className={`form-field-preview is-${field.width}`}><label>{field.label}{field.required ? <em>*</em> : null}<Tag variant="filled">{field.sensitivity}</Tag></label>{field.description === '' ? null : <p>{field.description}</p>}<FieldControl field={field} /></div>;
}

function FieldControl({ field }: { readonly field: DesignerField }) {
  const placeholder = field.placeholder || `请输入${field.label}`;
  if (field.type === 'long_text') return <Input.TextArea placeholder={placeholder} rows={3} disabled />;
  if (field.type === 'number' || field.type === 'money_minor' || field.type === 'percentage') return <InputNumber placeholder={placeholder} disabled className="console-full-width" addonAfter={field.type === 'percentage' ? '%' : undefined} />;
  if (field.type === 'boolean') return <Switch disabled checkedChildren="是" unCheckedChildren="否" />;
  if (['date', 'datetime', 'time'].includes(field.type)) return <Input prefix={<CalendarOutlined />} placeholder={field.type === 'date' ? 'YYYY-MM-DD' : field.type === 'time' ? 'HH:mm' : 'YYYY-MM-DD HH:mm'} disabled />;
  if (field.type === 'single_select') return <Select options={[...(field.options ?? [])]} placeholder="请选择" disabled className="console-full-width" />;
  if (field.type === 'multi_select') return <Select mode="multiple" options={[...(field.options ?? [])]} placeholder="请选择" disabled className="console-full-width" />;
  if (field.type === 'radio') return <Radio.Group disabled options={[...(field.options ?? [])]} />;
  if (field.type === 'checkbox_group') return <Checkbox.Group disabled options={[...(field.options ?? [])]} />;
  if (field.type === 'employee' || field.type === 'department') return <Input prefix={field.type === 'employee' ? <TeamOutlined /> : <ApartmentOutlined />} placeholder={field.type === 'employee' ? '选择组织成员' : '选择组织部门'} disabled />;
  if (field.type === 'attachment') return <div className="form-attachment-preview"><CloudUploadOutlined /><span>点击或拖拽上传附件</span><small>最多 {field.attachment?.maxCount ?? 5} 个，单个不超过 {field.attachment?.maxSizeMb ?? 20} MB</small></div>;
  if (field.type === 'relation_single' || field.type === 'relation_multiple') return <Input prefix={<LinkOutlined />} placeholder="选择关联记录" disabled />;
  if (field.type === 'related_property') return <Input prefix={<DatabaseOutlined />} placeholder="随关联记录实时显示" disabled />;
  return <Input prefix={field.type === 'email' ? <MailOutlined /> : field.type === 'phone' ? <PhoneOutlined /> : field.type === 'url' ? <LinkOutlined /> : undefined} placeholder={placeholder} disabled />;
}

function LayoutPreview({ layout }: { readonly layout: DesignerLayout }) {
  if (layout.type === 'divider') return <div className="form-layout-divider"><span>{layout.title}</span></div>;
  if (layout.type === 'section') return <div className="form-layout-section"><strong>{layout.title}</strong>{layout.description === '' ? null : <span>{layout.description}</span>}</div>;
  return <div className="form-layout-description"><FileTextOutlined /><span><strong>{layout.title}</strong>{layout.description}</span></div>;
}

function PropertyPanel(props: { readonly item: DesignerItem | null; readonly items: readonly DesignerItem[]; readonly forms: readonly StoredForm[]; readonly editable: boolean; readonly onFieldChange: (patch: Partial<DesignerField>) => void; readonly onLayoutChange: (patch: Partial<DesignerLayout>) => void }) {
  return <aside className="form-properties" aria-label="组件属性"><div className="form-panel-heading"><strong>属性设置</strong><span>{props.item === null ? '选择一个组件' : '即时生效'}</span></div>{props.item === null ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="点击画布中的字段进行配置" /> : props.item.kind === 'layout' ? <LayoutProperties layout={props.item.layout} editable={props.editable} onChange={props.onLayoutChange} /> : <FieldProperties field={props.item.field} items={props.items} forms={props.forms} editable={props.editable} onChange={props.onFieldChange} />}</aside>;
}

function LayoutProperties({ layout, editable, onChange }: { readonly layout: DesignerLayout; readonly editable: boolean; readonly onChange: (patch: Partial<DesignerLayout>) => void }) {
  return <div className="form-property-list"><Property label="标题"><Input value={layout.title} maxLength={128} disabled={!editable} onChange={(event) => onChange({ title: event.target.value })} /></Property><Property label="说明"><Input.TextArea value={layout.description} maxLength={1_000} rows={4} disabled={!editable} onChange={(event) => onChange({ description: event.target.value })} /></Property></div>;
}

function FieldProperties({ field, items, forms, editable, onChange }: { readonly field: DesignerField; readonly items: readonly DesignerItem[]; readonly forms: readonly StoredForm[]; readonly editable: boolean; readonly onChange: (patch: Partial<DesignerField>) => void }) {
  const relatedFields = items.flatMap((item) => item.kind === 'field' && item.field.relation !== undefined ? [item.field] : []);
  const target = forms.find((form) => form.id === field.relation?.targetFormId);
  const relationSource = relatedFields.find((candidate) => candidate.key === field.relatedProperty?.relationFieldKey);
  const propertyTarget = forms.find((form) => form.id === relationSource?.relation?.targetFormId);
  return <div className="form-property-list">
    <div className="form-property-type"><span>{ICONS[field.type]}</span><div><strong>{PALETTE.find((entry) => entry.type === field.type)?.label}</strong><small>字段类型创建后保持稳定</small></div></div>
    <Property label="字段名称"><Input value={field.label} maxLength={128} disabled={!editable} onChange={(event) => onChange({ label: event.target.value })} /></Property>
    <Property label="字段键"><Input value={field.key} maxLength={64} disabled={!editable} onChange={(event) => onChange({ key: event.target.value })} /></Property>
    <Property label="填写提示"><Input value={field.placeholder} maxLength={128} disabled={!editable} onChange={(event) => onChange({ placeholder: event.target.value })} /></Property>
    <Property label="帮助说明"><Input.TextArea value={field.description} maxLength={500} rows={3} disabled={!editable} onChange={(event) => onChange({ description: event.target.value })} /></Property>
    <div className="form-property-row"><Property label="占用宽度"><Segmented<'full' | 'half'> value={field.width} disabled={!editable} options={[{ value: 'full', label: '整行' }, { value: 'half', label: '半行' }]} onChange={(value) => onChange({ width: value })} /></Property><Property label="敏感级别"><Select<DesignerField['sensitivity']> value={field.sensitivity} disabled={!editable} options={(['L1', 'L2', 'L3', 'L4'] as const).map((value) => ({ value, label: value }))} onChange={(value) => onChange({ sensitivity: value })} /></Property></div>
    {field.type === 'related_property' ? null : <label className="form-property-switch"><span><strong>必填字段</strong><small>提交记录时不能为空</small></span><Switch checked={field.required} disabled={!editable} onChange={(required) => onChange({ required })} /></label>}
    {field.options === undefined ? null : <OptionsEditor options={field.options} editable={editable} onChange={(options) => onChange({ options })} />}
    {field.attachment === undefined ? null : <><div className="form-property-row"><Property label="最多文件数"><InputNumber min={1} max={20} value={field.attachment.maxCount} disabled={!editable} onChange={(value) => onChange({ attachment: { ...field.attachment!, maxCount: value ?? 1 } })} /></Property><Property label="单文件上限（MB）"><InputNumber min={1} max={50} value={field.attachment.maxSizeMb} disabled={!editable} onChange={(value) => onChange({ attachment: { ...field.attachment!, maxSizeMb: value ?? 1 } })} /></Property></div><Property label="允许类型"><Select<AttachmentAccept[]> mode="multiple" value={[...field.attachment.accept]} disabled={!editable} options={(['image', 'document', 'spreadsheet', 'archive', 'pdf'] as const).map((value) => ({ value, label: value }))} onChange={(accept) => onChange({ attachment: { ...field.attachment!, accept } })} /></Property></>}
    {field.relation === undefined ? null : <><div className="form-property-section-title">数据关联</div><Property label="目标表单"><Select<string> value={field.relation.targetFormId} placeholder="选择已存在表单" disabled={!editable} options={forms.filter((form) => form.id !== '').map((form) => ({ value: form.id, label: `${form.name} · ${form.code}` }))} onChange={(targetFormId) => onChange({ relation: { targetFormId, displayFieldKey: '', allowCreate: field.relation!.allowCreate } })} /></Property><Property label="记录显示字段"><Select<string> value={field.relation.displayFieldKey} placeholder="选择目标字段" disabled={!editable || target === undefined} options={target?.items.flatMap((item) => item.kind === 'field' ? [{ value: item.field.key, label: item.field.label }] : []) ?? []} onChange={(displayFieldKey) => onChange({ relation: { ...field.relation!, displayFieldKey } })} /></Property><label className="form-property-switch"><span><strong>允许快捷新建</strong><small>从选择器直接创建目标记录</small></span><Switch checked={field.relation.allowCreate} disabled={!editable} onChange={(allowCreate) => onChange({ relation: { ...field.relation!, allowCreate } })} /></label></>}
    {field.relatedProperty === undefined ? null : <><div className="form-property-section-title">关联属性路径</div><Property label="来源关联字段"><Select<string> value={field.relatedProperty.relationFieldKey} placeholder="选择本表关联字段" disabled={!editable} options={relatedFields.map((candidate) => ({ value: candidate.key, label: candidate.label }))} onChange={(relationFieldKey) => onChange({ relatedProperty: { relationFieldKey, targetFieldKey: '' } })} /></Property><Property label="目标字段"><Select<string> value={field.relatedProperty.targetFieldKey} placeholder="选择要实时显示的字段" disabled={!editable || propertyTarget === undefined} options={propertyTarget?.items.flatMap((item) => item.kind === 'field' && item.field.sensitivity !== 'L4' ? [{ value: item.field.key, label: item.field.label }] : []) ?? []} onChange={(targetFieldKey) => onChange({ relatedProperty: { ...field.relatedProperty!, targetFieldKey } })} /></Property><Alert type="info" showIcon message="实时读取，不复制数据" description="目标记录变化后这里同步更新；L4 字段不能作为关联属性展示。" /></>}
  </div>;
}

function OptionsEditor({ options, editable, onChange }: { readonly options: readonly { readonly value: string; readonly label: string }[]; readonly editable: boolean; readonly onChange: (options: readonly { readonly value: string; readonly label: string }[]) => void }) {
  return <div className="form-option-editor"><div className="form-property-section-title">选项</div>{options.map((option, index) => <div key={`${option.value}-${index}`}><DragOutlined /><Input value={option.label} disabled={!editable} onChange={(event) => onChange(options.map((current, target) => target === index ? { ...current, label: event.target.value, value: safeOptionValue(event.target.value, index) } : current))} /><Button type="text" danger aria-label="删除选项" icon={<DeleteOutlined />} disabled={!editable || options.length <= 1} onClick={() => onChange(options.filter((_, target) => target !== index))} /></div>)}<Button type="dashed" block icon={<PlusOutlined />} disabled={!editable || options.length >= 200} onClick={() => onChange([...options, { value: `option_${options.length + 1}`, label: `选项${options.length + 1}` }])}>添加选项</Button></div>;
}

function Property({ label, children }: { readonly label: string; readonly children: ReactNode }) { return <label className="form-property"><span>{label}</span>{children}</label>; }

function WorkflowDesigner(props: { readonly nodes: readonly WorkflowNode[]; readonly fields: readonly DesignerField[]; readonly riskLevel: 'R1' | 'R2'; readonly editable: boolean; readonly syncing: boolean; readonly onRiskChange: (value: 'R1' | 'R2') => void; readonly onChange: (nodes: readonly WorkflowNode[]) => void; readonly onSync: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(() => props.nodes[0]?.id ?? null);
  const selected = props.nodes.find((node) => node.id === selectedId) ?? null;
  const update = (patch: Partial<WorkflowNode>) => { if (selected === null || !props.editable) return; props.onChange(Object.freeze(props.nodes.map((node) => node.id === selected.id ? { ...node, ...patch } : node))); };
  const addNode = (type: 'approval' | 'copy') => {
    if (!props.editable) return;
    const node: WorkflowNode = type === 'approval'
      ? { id: `node_${createWorkflowId()}`, name: '审批节点', type, approvalMode: 'all', resolver: { type: 'initiator_manager' } }
      : { id: `node_${createWorkflowId()}`, name: '抄送节点', type, resolver: { type: 'roles', roleCodes: ['hrbp'], scope: 'tenant' } };
    props.onChange(Object.freeze([...props.nodes, node])); setSelectedId(node.id);
  };
  const reorderNode = (from: number, to: number) => {
    if (!props.editable || from === to || from < 0 || to < 0 || from >= props.nodes.length || to >= props.nodes.length) return;
    const next = [...props.nodes]; const [node] = next.splice(from, 1); if (node === undefined) return; next.splice(to, 0, node); props.onChange(Object.freeze(next));
  };
  return <section className="workflow-studio" aria-label="审批流程设计器">
    <header className="workflow-toolbar"><div><Typography.Title level={2}>审批流程</Typography.Title><Typography.Paragraph>节点按顺序执行；条件不满足时自动跳过。发布前会转换为 GaoQ 审批模板草稿。</Typography.Paragraph></div><Flex gap={10} align="center"><span className="workflow-risk-label">风险等级</span><Segmented<'R1' | 'R2'> value={props.riskLevel} disabled={!props.editable} options={[{ value: 'R1', label: 'R1 常规' }, { value: 'R2', label: 'R2 强认证' }]} onChange={props.onRiskChange} /><Button icon={<SafetyCertificateOutlined />} loading={props.syncing} onClick={props.onSync}>生成审批模板草稿</Button></Flex></header>
    <div className="workflow-grid">
      <div className="workflow-canvas">
        <div className="workflow-terminal"><UserOutlined /><span><strong>发起人提交</strong><small>表单数据完成校验后进入流程</small></span></div>
        {props.nodes.map((node, index) => <div key={node.id} className="workflow-node-wrap">
          <div className="workflow-connector" aria-hidden="true"><i /></div>
          <article className={`workflow-node${selectedId === node.id ? ' is-selected' : ''}`} draggable={props.editable} onDragStart={(event) => event.dataTransfer.setData('application/x-gaoq-workflow-node', node.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('application/x-gaoq-workflow-node'); reorderNode(props.nodes.findIndex((candidate) => candidate.id === id), index); }} onClick={() => setSelectedId(node.id)}>
            <span className="workflow-node-icon">{node.type === 'approval' ? <SafetyCertificateOutlined /> : <NotificationOutlined />}</span><span><strong>{node.name}</strong><small>{resolverLabel(node)}{node.condition === undefined ? '' : ` · 条件：${fieldLabel(props.fields, node.condition.field)} ${node.condition.op}`}</small></span><Tag>{node.type === 'approval' ? node.approvalMode === 'all' ? '会签' : '或签' : '抄送'}</Tag><div className="workflow-node-actions"><Button type="text" size="small" aria-label="上移流程节点" icon={<ArrowUpOutlined />} disabled={!props.editable || index === 0} onClick={(event) => { event.stopPropagation(); reorderNode(index, index - 1); }} /><Button type="text" size="small" aria-label="下移流程节点" icon={<ArrowDownOutlined />} disabled={!props.editable || index === props.nodes.length - 1} onClick={(event) => { event.stopPropagation(); reorderNode(index, index + 1); }} /><Button type="text" size="small" danger aria-label="删除流程节点" icon={<DeleteOutlined />} disabled={!props.editable} onClick={(event) => { event.stopPropagation(); props.onChange(Object.freeze(props.nodes.filter((candidate) => candidate.id !== node.id))); setSelectedId(null); }} /></div>
          </article>
        </div>)}
        <div className="workflow-connector" aria-hidden="true"><i /></div>
        <div className="workflow-add"><Button icon={<PlusOutlined />} disabled={!props.editable} onClick={() => addNode('approval')}>审批节点</Button><Button icon={<NotificationOutlined />} disabled={!props.editable} onClick={() => addNode('copy')}>抄送节点</Button></div>
        <div className="workflow-connector" aria-hidden="true"><i /></div>
        <div className="workflow-terminal is-end"><CheckSquareOutlined /><span><strong>流程完成</strong><small>写入审批终态并触发后续自动化</small></span></div>
      </div>
      <aside className="workflow-properties"><div className="form-panel-heading"><strong>节点设置</strong><span>拖拽可排序</span></div>{selected === null ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个流程节点" /> : <div className="form-property-list">
        <div className="form-property-type"><span>{selected.type === 'approval' ? <SafetyCertificateOutlined /> : <NotificationOutlined />}</span><div><strong>{selected.type === 'approval' ? '审批节点' : '抄送节点'}</strong><small>{selected.id}</small></div></div>
        <Property label="节点名称"><Input value={selected.name} maxLength={128} disabled={!props.editable} onChange={(event) => update({ name: event.target.value })} /></Property>
        {selected.type === 'approval' ? <Property label="通过方式"><Segmented<'all' | 'any'> value={selected.approvalMode ?? 'all'} disabled={!props.editable} options={[{ value: 'all', label: '全部通过（会签）' }, { value: 'any', label: '任一通过（或签）' }]} onChange={(approvalMode) => update({ approvalMode })} /></Property> : null}
        <Property label={selected.type === 'approval' ? '审批人来源' : '抄送人来源'}><Select<WorkflowNode['resolver']['type']> value={selected.resolver.type} disabled={!props.editable} options={[{ value: 'initiator_manager', label: '发起人的直属上级' }, { value: 'department_manager', label: '表单部门负责人' }, { value: 'roles', label: '指定角色' }, { value: 'employees', label: '指定成员' }]} onChange={(type) => update({ resolver: defaultResolver(type, props.fields) })} /></Property>
        {selected.resolver.type === 'roles' ? <><Property label="角色编码（逗号分隔）"><Input value={selected.resolver.roleCodes.join(', ')} disabled={!props.editable} onChange={(event) => update({ resolver: { ...selected.resolver as Extract<WorkflowNode['resolver'], { type: 'roles' }>, roleCodes: csv(event.target.value) } })} /></Property><Property label="角色范围"><Select value={selected.resolver.scope} disabled={!props.editable} options={[{ value: 'tenant', label: '全租户' }, { value: 'initiator_department', label: '发起人部门' }]} onChange={(scope) => update({ resolver: { ...selected.resolver as Extract<WorkflowNode['resolver'], { type: 'roles' }>, scope } })} /></Property></> : null}
        {selected.resolver.type === 'employees' ? <Property label="员工标识（逗号分隔）"><Input value={selected.resolver.employeeIds.join(', ')} disabled={!props.editable} onChange={(event) => update({ resolver: { type: 'employees', employeeIds: csv(event.target.value) } })} /></Property> : null}
        {selected.resolver.type === 'department_manager' ? <Property label="部门字段"><Select value={selected.resolver.departmentField} disabled={!props.editable} options={props.fields.filter((field) => field.type === 'department').map((field) => ({ value: field.key, label: field.label }))} onChange={(departmentField) => update({ resolver: { type: 'department_manager', departmentField } })} /></Property> : null}
        <label className="form-property-switch"><span><strong>条件分支</strong><small>只在记录满足条件时执行本节点</small></span><Switch checked={selected.condition !== undefined} disabled={!props.editable} onChange={(checked) => update({ condition: checked ? { field: props.fields[0]?.key ?? '', op: 'eq', value: '' } : undefined })} /></label>
        {selected.condition === undefined ? null : <><Property label="条件字段"><Select value={selected.condition.field} disabled={!props.editable} options={props.fields.filter((field) => field.type !== 'attachment' && field.type !== 'related_property').map((field) => ({ value: field.key, label: field.label }))} onChange={(field) => update({ condition: { ...selected.condition!, field } })} /></Property><Property label="比较方式"><Select value={selected.condition.op} disabled={!props.editable} options={[{ value: 'eq', label: '等于' }, { value: 'ne', label: '不等于' }, { value: 'gt', label: '大于' }, { value: 'gte', label: '大于等于' }, { value: 'lt', label: '小于' }, { value: 'lte', label: '小于等于' }, { value: 'is_empty', label: '为空' }]} onChange={(op) => update({ condition: op === 'is_empty' ? { field: selected.condition!.field, op } : { field: selected.condition!.field, op, value: ['gt', 'gte', 'lt', 'lte'].includes(op) ? 0 : '' } })} /></Property>{selected.condition.op === 'is_empty' ? null : <Property label="比较值">{['gt', 'gte', 'lt', 'lte'].includes(selected.condition.op) ? <InputNumber value={typeof selected.condition.value === 'number' ? selected.condition.value : 0} disabled={!props.editable} onChange={(value) => update({ condition: { ...selected.condition!, value: value ?? 0 } })} className="console-full-width" /> : <Input value={typeof selected.condition.value === 'string' ? selected.condition.value : ''} disabled={!props.editable} onChange={(event) => update({ condition: { ...selected.condition!, value: event.target.value } })} />}</Property>}</>}
      </div>}</aside>
    </div>
  </section>;
}

function FormPreview({ name, description, items }: { readonly name: string; readonly description: string; readonly items: readonly DesignerItem[] }) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  return <section className="form-preview-stage" aria-label="表单填写预览"><div className="form-preview-device"><Segmented<'desktop' | 'mobile'> value={device} options={[{ value: 'desktop', label: <span><DesktopOutlined /> 桌面预览</span> }, { value: 'mobile', label: <span><MobileOutlined /> 手机预览</span> }]} onChange={setDevice} /></div><div className={`form-preview-sheet is-${device}`}><div className="form-preview-heading"><Typography.Title level={2}>{name || '未命名表单'}</Typography.Title><Typography.Paragraph>{description || '暂无用途说明'}</Typography.Paragraph></div><div className="form-preview-fields">{items.map((item) => <div key={itemId(item)} className={item.kind === 'field' && item.field.width === 'half' ? 'is-half' : 'is-full'}>{item.kind === 'field' ? <FieldPreview field={item.field} /> : <LayoutPreview layout={item.layout} />}</div>)}</div><Flex justify="flex-end" gap={10} className="form-preview-actions"><Button>暂存</Button><Button type="primary">提交记录</Button></Flex></div></section>;
}

function RelationMap({ currentName, items, forms }: { readonly currentName: string; readonly items: readonly DesignerItem[]; readonly forms: readonly StoredForm[] }) {
  const relations = items.flatMap((item) => item.kind === 'field' && item.field.relation !== undefined ? [item.field] : []);
  return <section className="form-relation-stage" aria-label="数据关系图"><div className="form-relation-help"><Typography.Title level={2}>数据关系</Typography.Title><Typography.Paragraph>关联记录保存目标记录标识；关联属性实时取值；反向关联列表让目标记录看见谁在引用它。</Typography.Paragraph></div><div className="form-relation-map"><div className="form-relation-node is-current"><DatabaseOutlined /><strong>{currentName || '当前表单'}</strong><span>{relations.length} 条出向关系</span></div>{relations.length === 0 ? <Empty description="添加“关联记录”字段后，关系会显示在这里" /> : <div className="form-relation-links">{relations.map((field) => { const target = forms.find((form) => form.id === field.relation?.targetFormId); return <div key={field.id} className="form-relation-edge"><span><LinkOutlined /> {field.label}</span><i aria-hidden="true" /><div className="form-relation-node"><DatabaseOutlined /><strong>{target?.name ?? '待选择目标表单'}</strong><span>{field.type === 'relation_single' ? '一对一' : '一对多'} · 可反向访问</span></div></div>; })}</div>}</div></section>;
}

function validationIssue(name: string, code: string, items: readonly DesignerItem[]): string | null {
  if (name.trim().length < 2) return '表单名称至少需要 2 个字符';
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(code)) return '表单编码须以字母开头，只能包含字母、数字、点、下划线和连字符';
  if (items.length === 0) return '至少添加一个字段或布局组件';
  const fields = items.flatMap((item) => item.kind === 'field' ? [item.field] : []);
  if (new Set(fields.map((field) => field.key)).size !== fields.length) return '字段键不能重复';
  if (fields.some((field) => field.label.trim() === '' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(field.key))) return '请补全字段名称，并修正不合法的字段键';
  if (fields.some((field) => field.relation !== undefined && (field.relation.targetFormId === '' || field.relation.displayFieldKey === ''))) return '请为所有关联记录字段选择目标表单和显示字段';
  if (fields.some((field) => field.relatedProperty !== undefined && (field.relatedProperty.relationFieldKey === '' || field.relatedProperty.targetFieldKey === ''))) return '请补全所有关联属性的取值路径';
  return null;
}

function workflowIssue(nodes: readonly WorkflowNode[], items: readonly DesignerItem[]): string | null {
  if (!nodes.some((node) => node.type === 'approval')) return '审批流程至少需要一个审批节点';
  const fields = new Map(items.flatMap((item) => item.kind === 'field' ? [[item.field.key, item.field] as const] : []));
  for (const node of nodes) {
    if (node.name.trim() === '') return '请补全流程节点名称';
    if (node.resolver.type === 'roles' && node.resolver.roleCodes.length === 0) return `节点“${node.name}”缺少角色`;
    if (node.resolver.type === 'employees' && node.resolver.employeeIds.length === 0) return `节点“${node.name}”缺少指定成员`;
    if (node.resolver.type === 'department_manager' && fields.get(node.resolver.departmentField)?.type !== 'department') return `节点“${node.name}”必须选择部门字段`;
    if (node.condition !== undefined && !fields.has(node.condition.field)) return `节点“${node.name}”的条件字段不存在`;
  }
  return null;
}

function approvalFields(items: readonly DesignerItem[]): readonly Record<string, unknown>[] {
  return items.flatMap((item) => {
    if (item.kind !== 'field' || item.field.type === 'related_property') return [];
    const field = item.field;
    const type = approvalFieldType(field.type);
    return [{ key: field.key, label: field.label, type, required: field.required, sensitivity: field.sensitivity, ...(field.options === undefined ? {} : { options: field.options.map((option) => ({ key: option.value, label: option.label })) }), ...(type === 'text' ? { maximumLength: field.type === 'long_text' ? 10_000 : 2_000 } : {}) }];
  });
}

function approvalFieldType(type: FieldType): 'text' | 'number' | 'money_minor' | 'boolean' | 'date' | 'single_select' | 'multi_select' | 'employee' | 'department' | 'file_reference' {
  if (type === 'number' || type === 'percentage') return 'number';
  if (type === 'money_minor' || type === 'boolean' || type === 'date' || type === 'single_select' || type === 'multi_select' || type === 'employee' || type === 'department') return type;
  if (type === 'radio') return 'single_select';
  if (type === 'checkbox_group') return 'multi_select';
  if (type === 'attachment') return 'file_reference';
  return 'text';
}

function approvalNode(node: WorkflowNode): Record<string, unknown> {
  return { id: node.id, name: node.name, type: node.type, ...(node.approvalMode === undefined ? {} : { approvalMode: node.approvalMode }), resolver: node.resolver, ...(node.condition === undefined ? {} : { condition: node.condition.op === 'is_empty' ? { field: node.condition.field, op: node.condition.op } : { field: node.condition.field, op: node.condition.op, value: node.condition.value } }) };
}

function resolverLabel(node: WorkflowNode): string {
  if (node.resolver.type === 'initiator_manager') return '发起人的直属上级';
  if (node.resolver.type === 'department_manager') return `部门负责人 · ${node.resolver.departmentField || '待选择字段'}`;
  if (node.resolver.type === 'employees') return `指定成员 · ${node.resolver.employeeIds.length} 人`;
  return `角色 · ${node.resolver.roleCodes.join('、') || '待配置'}`;
}

function fieldLabel(fields: readonly DesignerField[], key: string): string { return fields.find((field) => field.key === key)?.label ?? key; }

function defaultResolver(type: WorkflowNode['resolver']['type'], fields: readonly DesignerField[]): WorkflowNode['resolver'] {
  if (type === 'initiator_manager') return { type };
  if (type === 'department_manager') return { type, departmentField: fields.find((field) => field.type === 'department')?.key ?? '' };
  if (type === 'employees') return { type, employeeIds: [] };
  return { type, roleCodes: ['department_manager'], scope: 'tenant' };
}

function csv(value: string): readonly string[] { return Object.freeze([...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]); }
function createWorkflowId(): string { return crypto.randomUUID().replaceAll('-', '').slice(0, 24); }

function commitItems(setHistory: Dispatch<SetStateAction<DesignerHistory>>, update: (items: readonly DesignerItem[]) => readonly DesignerItem[]): void {
  setHistory((current) => {
    const next = update(current.present);
    if (next === current.present) return current;
    return { past: Object.freeze([...current.past.slice(-49), current.present]), present: next, future: Object.freeze([]) };
  });
}

function safeOptionValue(label: string, index: number): string {
  const value = Array.from(label.trim(), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === '<' || character === '>' || codePoint < 32 ? '_' : character;
  }).join('').slice(0, 100);
  return value === '' ? `option_${index + 1}` : value;
}

function seedItems(): readonly DesignerItem[] {
  return Object.freeze([
    { kind: 'layout', layout: { id: '01K00000000000000000000001', type: 'section', title: '基本信息', description: '请确认员工和异动类型。' } },
    { kind: 'field', field: { id: '01K00000000000000000000002', key: 'employee', label: '异动员工', type: 'employee', required: true, sensitivity: 'L2', width: 'half', description: '', placeholder: '' } },
    { kind: 'field', field: { id: '01K00000000000000000000003', key: 'change_type', label: '异动类型', type: 'single_select', required: true, sensitivity: 'L1', width: 'half', description: '', placeholder: '请选择异动类型', options: [{ value: 'transfer', label: '部门调动' }, { value: 'promotion', label: '晋升' }, { value: 'other', label: '其他' }] } },
    { kind: 'field', field: { id: '01K00000000000000000000004', key: 'effective_date', label: '生效日期', type: 'date', required: true, sensitivity: 'L1', width: 'half', description: '', placeholder: '' } },
    { kind: 'field', field: { id: '01K00000000000000000000005', key: 'target_department', label: '目标部门', type: 'department', required: true, sensitivity: 'L2', width: 'half', description: '', placeholder: '' } },
    { kind: 'field', field: { id: '01K00000000000000000000006', key: 'supporting_files', label: '证明附件', type: 'attachment', required: false, sensitivity: 'L3', width: 'full', description: '仅上传与本次异动直接相关的证明材料。', placeholder: '', attachment: { maxCount: 5, maxSizeMb: 20, accept: ['image', 'document', 'pdf'] } } },
  ]);
}

function seedWorkflow(): readonly WorkflowNode[] {
  return Object.freeze([
    { id: 'manager_review', name: '直属上级审批', type: 'approval', approvalMode: 'all', resolver: { type: 'initiator_manager' } },
    { id: 'hrbp_review', name: 'HRBP 复核', type: 'approval', approvalMode: 'any', resolver: { type: 'roles', roleCodes: ['hrbp'], scope: 'tenant' }, condition: { field: 'change_type', op: 'ne', value: 'other' } },
    { id: 'notify_hr_ops', name: '抄送人事运营', type: 'copy', resolver: { type: 'roles', roleCodes: ['hr_operations'], scope: 'tenant' } },
  ]);
}

function showError(modal: ReturnType<typeof AntApp.useApp>['modal'], value: unknown, fallback: string): void { const error = value instanceof ErpApiError ? value : null; modal.error({ title: fallback, content: `${error?.message ?? fallback}${error?.traceId === null || error === null ? '' : `\n追踪标识：${error.traceId}`}` }); }
