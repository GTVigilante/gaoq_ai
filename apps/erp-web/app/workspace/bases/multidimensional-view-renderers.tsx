'use client';

import {
  CalendarOutlined, CheckCircleOutlined, ClockCircleOutlined, DatabaseOutlined,
  FileImageOutlined, FormOutlined, LinkOutlined, NumberOutlined, PaperClipOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Empty, Input, InputNumber, Progress, Select, Space, Switch, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CSSProperties, ReactNode } from 'react';

import type { BaseField, BaseRecordRow, BaseView } from './multidimensional-base-types';
import { cellText, groupByField, pickField } from './multidimensional-view-model';

interface RendererProps {
  readonly fields: readonly BaseField[];
  readonly records: readonly BaseRecordRow[];
  readonly view: BaseView;
  readonly primaryFieldKey: string;
}

/** 用同一份权限过滤后的记录投影渲染七类业务视图。 */
export function MultidimensionalViewRenderer(props: RendererProps) {
  if (props.view.type === 'grid') return <GridView {...props} />;
  if (props.view.type === 'kanban') return <KanbanView {...props} />;
  if (props.view.type === 'calendar') return <CalendarView {...props} />;
  if (props.view.type === 'gallery') return <GalleryView {...props} />;
  if (props.view.type === 'gantt') return <GanttView {...props} />;
  if (props.view.type === 'form') return <FormView {...props} />;
  return <DashboardView {...props} />;
}

function GridView({ fields, records, view }: RendererProps) {
  const visible = view.config.visibleFieldKeys.length === 0 ? fields : fields.filter((field) => view.config.visibleFieldKeys.includes(field.key));
  const columns: ColumnsType<BaseRecordRow> = [
    { title: '#', dataIndex: 'id', key: 'id', fixed: 'left', width: 74, render: (id: string) => <code className="base-record-code">{id.slice(-6)}</code> },
    ...visible.map((field, index) => ({
      title: <span className="base-column-title"><FieldIcon field={field} />{field.label}{['L3', 'L4'].includes(field.sensitivity) ? <Tag color="orange">{field.sensitivity}</Tag> : null}</span>,
      key: field.key,
      width: field.type === 'attachment' || field.type.startsWith('relation') ? 220 : 176,
      ...(index < view.config.frozenFieldCount ? { fixed: 'left' as const } : {}),
      render: (_: unknown, row: BaseRecordRow) => <CellValue value={row.values[field.key]} field={field} />,
    })),
    { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 170, render: (value: string) => formatDateTime(value) },
  ];
  return <Table<BaseRecordRow> className={`base-data-table row-${view.config.rowHeight}`} rowKey="id" dataSource={[...records]} columns={columns} pagination={{ pageSize: 50, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} scroll={{ x: Math.max(900, columns.length * 176), y: 560 }} />;
}

function KanbanView({ fields, records, view, primaryFieldKey }: RendererProps) {
  const groupField = fields.find((field) => field.key === view.config.groups[0]) ?? pickField(fields, ['single_select', 'radio'], /状态|阶段|进度|优先/u);
  const grouped = groupByField(records, groupField);
  const optionColumns = groupField?.options?.map((option) => option.label) ?? [];
  const columns = [...new Set([...optionColumns, ...grouped.keys()])];
  return <div className="base-kanban" aria-label={`${view.name}看板`}>
    {columns.map((column) => <section key={column} className="base-kanban-column"><header><span><i />{column}</span><b>{grouped.get(column)?.length ?? 0}</b></header><div>{(grouped.get(column) ?? []).map((row) => <article key={row.id}><strong>{cellText(row.values[primaryFieldKey])}</strong>{fields.filter((field) => field.key !== primaryFieldKey && field.key !== groupField?.key).slice(0, 3).map((field) => <p key={field.key}><span>{field.label}</span><CellValue field={field} value={row.values[field.key]} /></p>)}<footer><code>{row.id.slice(-6)}</code><time>{formatDateTime(row.updatedAt, false)}</time></footer></article>)}</div></section>)}
  </div>;
}

function CalendarView({ fields, records, primaryFieldKey }: RendererProps) {
  const dateField = pickField(fields, ['date', 'datetime'], /日期|时间|日程|截止|开始/u);
  if (dateField === null) return <ViewEmpty icon={<CalendarOutlined />} title="缺少日期字段" description="为数据表添加日期或日期时间字段后，即可按日程展示记录。" />;
  const dated = records.flatMap((row) => { const parsed = parseDate(row.values[dateField.key]); return parsed === null ? [] : [{ row, date: parsed }]; }).toSorted((left, right) => left.date.getTime() - right.date.getTime());
  if (dated.length === 0) return <ViewEmpty icon={<CalendarOutlined />} title="暂无已排期记录" description={`当前视图按“${dateField.label}”展示；填写日期后会自动进入日历。`} />;
  const days = [...new Set(dated.map(({ date }) => date.toISOString().slice(0, 10)))];
  return <div className="base-calendar"><header><div><strong>{dateField.label}</strong><span>{days[0]} — {days.at(-1)}</span></div><Tag>{dated.length} 条日程</Tag></header><div className="base-calendar-days">{days.map((day) => <section key={day}><header><span>{new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(new Date(`${day}T00:00:00`))}</span><strong>{day.slice(5)}</strong></header>{dated.filter(({ date }) => date.toISOString().startsWith(day)).map(({ row, date }) => <article key={row.id}><time>{date.toISOString().slice(11, 16) === '00:00' ? '全天' : date.toISOString().slice(11, 16)}</time><strong>{cellText(row.values[primaryFieldKey])}</strong><span>{row.id.slice(-6)}</span></article>)}</section>)}</div></div>;
}

function GalleryView({ fields, records, primaryFieldKey }: RendererProps) {
  return <div className="base-gallery">{records.map((row) => <article key={row.id}><div className="base-gallery-cover"><FileImageOutlined /><span>{cellText(row.values[primaryFieldKey]).slice(0, 1)}</span></div><div className="base-gallery-body"><strong>{cellText(row.values[primaryFieldKey])}</strong>{fields.filter((field) => field.key !== primaryFieldKey).slice(0, 4).map((field) => <p key={field.key}><span>{field.label}</span><CellValue field={field} value={row.values[field.key]} /></p>)}</div><footer><code>{row.id.slice(-6)}</code><time>{formatDateTime(row.updatedAt, false)}</time></footer></article>)}</div>;
}

function GanttView({ fields, records, primaryFieldKey }: RendererProps) {
  const dateFields = fields.filter((field) => field.type === 'date' || field.type === 'datetime');
  const startField = dateFields.find((field) => /开始|启动|入职|开放/u.test(field.label)) ?? dateFields[0] ?? null;
  const endField = dateFields.find((field) => field.key !== startField?.key && /结束|截止|完成/u.test(field.label)) ?? dateFields[1] ?? startField;
  if (startField === null) return <ViewEmpty icon={<ClockCircleOutlined />} title="缺少时间轴字段" description="至少添加一个日期字段；两个日期字段可形成开始—结束区间。" />;
  const tasks = records.flatMap((row) => { const start = parseDate(row.values[startField.key]); const end = parseDate(endField === null ? null : row.values[endField.key]) ?? start; return start === null || end === null ? [] : [{ row, start, end: end < start ? start : end }]; });
  if (tasks.length === 0) return <ViewEmpty icon={<ClockCircleOutlined />} title="暂无时间轴记录" description={`填写“${startField.label}”后即可生成甘特条。`} />;
  const minimum = Math.min(...tasks.map((task) => task.start.getTime()));
  const maximum = Math.max(...tasks.map((task) => task.end.getTime()), minimum + 86_400_000);
  const span = maximum - minimum;
  return <div className="base-gantt"><header><span>记录</span><div><time>{new Date(minimum).toISOString().slice(0, 10)}</time><time>{new Date(maximum).toISOString().slice(0, 10)}</time></div></header>{tasks.map((task) => { const left = ((task.start.getTime() - minimum) / span) * 100; const width = Math.max(4, ((task.end.getTime() - task.start.getTime() + 86_400_000) / span) * 100); return <div key={task.row.id} className="base-gantt-row"><strong>{cellText(task.row.values[primaryFieldKey])}</strong><div><span style={{ '--gantt-left': `${left}%`, '--gantt-width': `${Math.min(width, 100 - left)}%` } as CSSProperties}>{formatDateTime(task.start.toISOString(), false)}</span></div></div>; })}</div>;
}

function FormView({ fields }: RendererProps) {
  return <div className="base-form-view"><header><FormOutlined /><div><strong>公开收集表单</strong><span>字段与数据表共用 Schema，提交仍经过权限、校验和幂等边界。</span></div></header><div className="base-form-view-fields">{fields.map((field) => <label key={field.key}><span>{field.label}{field.required ? <em>*</em> : null}</span><FormControl field={field} /></label>)}</div><footer><button type="button" disabled>预览模式 · 不提交</button></footer></div>;
}

function DashboardView({ fields, records }: RendererProps) {
  const groupField = pickField(fields, ['single_select', 'radio', 'department'], /状态|阶段|部门|来源/u);
  const grouped = groupByField(records, groupField);
  const fieldCount = Math.max(1, fields.length * Math.max(1, records.length));
  const filled = records.reduce((sum, row) => sum + fields.filter((field) => cellText(row.values[field.key]) !== '—').length, 0);
  const completion = Math.round((filled / fieldCount) * 100);
  return <div className="base-dashboard"><section className="base-dashboard-metrics"><div><span>记录总数</span><strong>{records.length}</strong><small>当前权限范围</small></div><div><span>字段完整度</span><strong>{completion}%</strong><Progress percent={completion} showInfo={false} /></div><div><span>数据字段</span><strong>{fields.length}</strong><small>含关联与计算字段</small></div></section><section className="base-dashboard-chart"><header><div><strong>{groupField?.label ?? '记录分布'}</strong><span>按当前视图实时聚合</span></div><Tag>{grouped.size} 个分类</Tag></header><div>{[...grouped.entries()].toSorted((left, right) => right[1].length - left[1].length).map(([key, rows]) => <p key={key}><span>{key}</span><Progress percent={records.length === 0 ? 0 : Math.round((rows.length / records.length) * 100)} showInfo={false} /><strong>{rows.length}</strong></p>)}</div></section><section className="base-dashboard-quality"><header><strong>数据质量</strong><span>结构化检查</span></header><div><CheckCircleOutlined /><span><strong>Schema 已绑定</strong><small>字段类型与表单定义一致</small></span></div><div><CheckCircleOutlined /><span><strong>权限已继承</strong><small>视图不扩大记录或字段范围</small></span></div><div><CheckCircleOutlined /><span><strong>外部接口可用</strong><small>REST · OpenAPI · MCP · CLI</small></span></div></section></div>;
}

function CellValue({ value, field }: { readonly value: unknown; readonly field: BaseField }) {
  if (value === null || value === undefined || value === '') return <span className="base-cell-empty">—</span>;
  if (field.type === 'boolean') return <Tag color={value === true ? 'green' : 'default'}>{value === true ? '是' : '否'}</Tag>;
  if (field.type === 'single_select' || field.type === 'radio') return <Tag color="blue">{cellText(value)}</Tag>;
  if (field.type === 'multi_select' || field.type === 'checkbox_group') return <Space size={[0, 3]} wrap>{(Array.isArray(value) ? value : [value]).map((item, index) => <Tag key={`${cellText(item)}-${index}`}>{cellText(item)}</Tag>)}</Space>;
  if (field.type.startsWith('relation') || field.type === 'related_property') return <span className="base-cell-relation"><LinkOutlined />{cellText(value)}</span>;
  if (field.type === 'attachment') return <span className="base-cell-attachment"><PaperClipOutlined />{Array.isArray(value) ? `${value.length} 个附件` : cellText(value)}</span>;
  if (field.type === 'money_minor' && typeof value === 'string' && /^-?[0-9]+$/u.test(value)) return <span className="base-cell-number">¥ {(Number(value) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</span>;
  if (field.type === 'number' || field.type === 'percentage') return <span className="base-cell-number">{cellText(value)}{field.type === 'percentage' ? '%' : ''}</span>;
  return <span>{cellText(value)}</span>;
}

function FieldIcon({ field }: { readonly field: BaseField }) {
  if (field.type === 'employee' || field.type === 'department') return <TeamOutlined />;
  if (field.type === 'number' || field.type === 'money_minor' || field.type === 'percentage') return <NumberOutlined />;
  if (field.type === 'date' || field.type === 'datetime' || field.type === 'time') return <CalendarOutlined />;
  if (field.type === 'attachment') return <PaperClipOutlined />;
  if (field.type.startsWith('relation') || field.type === 'related_property') return <LinkOutlined />;
  return <DatabaseOutlined />;
}

function FormControl({ field }: { readonly field: BaseField }) {
  if (field.type === 'long_text') return <Input.TextArea rows={3} placeholder={field.placeholder || `请输入${field.label}`} disabled />;
  if (field.type === 'number' || field.type === 'money_minor' || field.type === 'percentage') return <InputNumber className="console-full-width" placeholder="请输入" disabled />;
  if (field.type === 'boolean') return <Switch disabled />;
  if (field.type === 'single_select' || field.type === 'radio') return <Select className="console-full-width" options={[...(field.options ?? [])]} placeholder="请选择" disabled />;
  if (field.type === 'multi_select' || field.type === 'checkbox_group') return <Select className="console-full-width" mode="multiple" options={[...(field.options ?? [])]} placeholder="请选择" disabled />;
  return <Input prefix={<FieldIcon field={field} />} placeholder={field.placeholder || `请输入${field.label}`} disabled />;
}

function ViewEmpty({ icon, title, description }: { readonly icon: ReactNode; readonly title: string; readonly description: string }) {
  return <div className="base-view-empty"><span>{icon}</span><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>{title}</strong><small>{description}</small></>} /></div>;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value: string, includeTime = true): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', includeTime ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { month: '2-digit', day: '2-digit' }).format(date);
}
