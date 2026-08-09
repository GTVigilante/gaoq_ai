'use client';

import { Alert, Button, Empty, Input, Segmented, Skeleton, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { erpFetch } from '../../lib/api-client';
import { ResumeLibraryConsole } from './resume-library-console';

const { Title, Paragraph, Text } = Typography;
type View = '总览' | '招聘需求' | '职位' | '候选流程' | '面试' | 'Offer' | '简历库';
type Row = Readonly<Record<string, unknown> & { id: string }>;
interface Dashboard { readonly generatedAt: string; readonly requisitions: Readonly<Record<string, number>>; readonly positions: Readonly<Record<string, { count: number; headcount: number }>>; readonly applications: Readonly<Record<string, number>>; readonly scheduledInterviews: number; readonly offers: Readonly<Record<string, number>>; }

const VIEWS: readonly View[] = ['总览', '招聘需求', '职位', '候选流程', '面试', 'Offer', '简历库'];
const STAGES = ['applied', 'screening', 'interview', 'offer_approval', 'offer_sent', 'offer_accepted', 'preboarding', 'hired'] as const;
const STAGE_LABEL: Readonly<Record<string, string>> = { applied: '新申请', screening: '筛选', interview: '面试', offer_approval: 'Offer审批', offer_sent: '待候选人', offer_accepted: '已接受', preboarding: '预入职', hired: '已入职', rejected: '已淘汰', withdrawn: '已撤回' };
const ENDPOINT: Readonly<Record<Exclude<View, '总览' | '简历库'>, string>> = { 招聘需求: 'requisitions', 职位: 'positions', 候选流程: 'applications', 面试: 'interviews', Offer: 'offers' };

/** 企业招聘运营台：沿人才旅程呈现状态，敏感原文继续留在目的限定详情接口。 */
export function RecruitmentOperationsConsole() {
  const [view, setView] = useState<View>('总览');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async (target: View) => {
    if (target === '简历库') return;
    setState('loading');
    try {
      if (target === '总览') {
        const response = await erpFetch<Dashboard>('/api/recruitment/workspace/dashboard');
        setDashboard(response.data); setRows([]);
      } else {
        const response = await erpFetch<{ readonly items: readonly Row[] }>(`/api/recruitment/workspace/${ENDPOINT[target]}?limit=100`);
        setRows(response.data.items);
      }
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);
  useEffect(() => { void load(view); }, [load, view]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (keyword.length === 0) return rows;
    return rows.filter((row) => [row.id, row.title, row.positionTitle, row.candidateId, row.positionId].some((value) => typeof value === 'string' && value.toLowerCase().includes(keyword)));
  }, [rows, search]);

  if (view === '简历库') return <div className="recruitment-ops"><Navigation view={view} onChange={setView} /><ResumeLibraryConsole /></div>;
  return (
    <main className="recruitment-ops" aria-labelledby="recruitment-ops-title">
      <header className="recruitment-ops-header">
        <div><Title id="recruitment-ops-title" level={1}>招聘运营中心</Title><Paragraph>从编制需求到正式入职，在同一条人才旅程中看清供给、阻塞和下一步责任。</Paragraph></div>
        <div className="recruitment-ops-pulse"><span aria-hidden="true" /><strong>实时业务投影</strong><small>{dashboard === null ? '等待刷新' : formatTime(dashboard.generatedAt)}</small></div>
      </header>
      <Navigation view={view} onChange={(next) => { setSearch(''); setView(next); }} />
      {state === 'error' ? <Alert type="error" showIcon message="招聘工作台暂时不可用" description="请确认登录权限和服务状态后重试。" action={<Button onClick={() => void load(view)}>重新加载</Button>} /> : null}
      {state === 'loading' ? <Skeleton active paragraph={{ rows: 8 }} /> : null}
      {state === 'ready' && view === '总览' && dashboard !== null ? <Overview dashboard={dashboard} /> : null}
      {state === 'ready' && view !== '总览' ? (
        <section className="recruitment-register" aria-label={`${view}列表`}>
          <header><div><Title level={2}>{view}</Title><Text type="secondary">仅呈现当前身份部门范围内的最小业务摘要</Text></div><Input.Search allowClear value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或业务编号" aria-label="搜索招聘记录" /></header>
          {filtered.length === 0 ? <Empty description="当前筛选下没有记录" /> : <Table<Row> rowKey="id" dataSource={[...filtered]} columns={columns(view)} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 920 }} />}
        </section>
      ) : null}
    </main>
  );
}

function Navigation({ view, onChange }: { readonly view: View; readonly onChange: (view: View) => void }) { return <nav className="recruitment-ops-nav" aria-label="招聘管理视图"><Segmented<View> block options={[...VIEWS]} value={view} onChange={onChange} /></nav>; }
function Overview({ dashboard }: { readonly dashboard: Dashboard }) {
  const open = dashboard.positions.open ?? { count: 0, headcount: 0 };
  const active = STAGES.reduce((sum, stage) => sum + (dashboard.applications[stage] ?? 0), 0);
  return <><section className="recruitment-command-strip"><Metric label="开放职位" value={open.count} detail={`${open.headcount} 个招聘名额`} /><Metric label="活跃候选" value={active} detail={`${dashboard.applications.applied ?? 0} 个新申请`} /><Metric label="待进行面试" value={dashboard.scheduledInterviews} detail="日历排期中的轮次" /><Metric label="待处理 Offer" value={(dashboard.offers.pending_approval ?? 0) + (dashboard.offers.approved ?? 0) + (dashboard.offers.sent ?? 0)} detail={`${dashboard.offers.accepted ?? 0} 个已接受`} /></section><section className="recruitment-journey" aria-labelledby="recruitment-journey-title"><header><div><Title id="recruitment-journey-title" level={2}>人才旅程</Title><Text type="secondary">数字是当前阶段存量，不代表候选人排名或质量判断</Text></div><Tag color="blue">AI 不参与录用决策</Tag></header><ol>{STAGES.map((stage, index) => <li key={stage}><span>{String(index + 1).padStart(2, '0')}</span><strong>{dashboard.applications[stage] ?? 0}</strong><small>{STAGE_LABEL[stage]}</small>{index < STAGES.length - 1 ? <i aria-hidden="true" /> : null}</li>)}</ol></section><section className="recruitment-attention"><article><Title level={3}>HC 审批队列</Title><p><strong>{dashboard.requisitions.pending_approval ?? 0}</strong><span>待审批</span></p><small>另有 {dashboard.requisitions.draft ?? 0} 个草稿需求</small></article><article><Title level={3}>Offer 转化</Title><p><strong>{dashboard.offers.accepted ?? 0}</strong><span>已接受</span></p><small>{dashboard.offers.declined ?? 0} 个候选人已拒绝</small></article><article><Title level={3}>入职衔接</Title><p><strong>{dashboard.applications.preboarding ?? 0}</strong><span>预入职</span></p><small>{dashboard.applications.hired ?? 0} 人已完成组织建档</small></article></section></>;
}
function Metric({ label, value, detail }: { readonly label: string; readonly value: number; readonly detail: string }) { return <article><span>{label}</span><strong>{value.toLocaleString('zh-CN')}</strong><small>{detail}</small></article>; }
function columns(view: Exclude<View, '总览' | '简历库'>): ColumnsType<Row> { const common: ColumnsType<Row> = [{ title: '业务编号', dataIndex: 'id', width: 230, render: (value: string) => <Text copyable={{ text: value }} ellipsis>{value}</Text> }, { title: '状态', key: 'status', width: 130, render: (_, row) => <Tag>{formatStatus(row.status ?? row.stage)}</Tag> }, { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: (value: unknown) => typeof value === 'string' ? formatTime(value) : '—' }]; if (view === '招聘需求') return [{ title: '需求', dataIndex: 'positionTitle', width: 220 }, { title: '人数', dataIndex: 'headcount', width: 90 }, { title: '部门', dataIndex: 'departmentId', width: 180 }, ...common]; if (view === '职位') return [{ title: '职位', dataIndex: 'title', width: 220 }, { title: '地点', dataIndex: 'location', width: 160 }, { title: '人数', dataIndex: 'headcount', width: 90 }, ...common]; if (view === '候选流程') return [{ title: '候选人引用', dataIndex: 'candidateId', width: 230 }, { title: '职位引用', dataIndex: 'positionId', width: 230 }, { title: '来源', dataIndex: 'sourceChannel', width: 120 }, ...common]; if (view === '面试') return [{ title: '申请引用', dataIndex: 'applicationId', width: 230 }, { title: '轮次', dataIndex: 'roundNumber', width: 80 }, { title: '方式', dataIndex: 'mode', width: 100 }, { title: '开始时间', dataIndex: 'startsAt', width: 180, render: (value: string) => formatTime(value) }, ...common]; return [{ title: '申请引用', dataIndex: 'applicationId', width: 230 }, { title: '职位引用', dataIndex: 'positionId', width: 230 }, { title: '有效期', dataIndex: 'expiresAt', width: 180, render: (value: string) => formatTime(value) }, ...common]; }
function formatStatus(value: unknown): string { return typeof value === 'string' ? value : 'unknown'; }
function formatTime(value: string): string { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(parsed); }
