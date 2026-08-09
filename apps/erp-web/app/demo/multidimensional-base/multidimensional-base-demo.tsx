'use client';

import {
  AppstoreOutlined,
  CalendarOutlined,
  CheckCircleFilled,
  DashboardOutlined,
  DatabaseOutlined,
  LinkOutlined,
  LockOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  TableOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Progress, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';

type TableId = 'candidates' | 'jobs' | 'interviews';
type ViewId = 'candidate-grid' | 'candidate-kanban' | 'candidate-dashboard' | 'job-grid' | 'interview-grid' | 'interview-calendar';
type Stage = '人才寻访' | '简历筛选' | '面试中' | 'Offer' | '已录用';

interface Candidate {
  readonly key: string;
  readonly name: string;
  readonly job: string;
  readonly department: string;
  readonly stage: Stage;
  readonly owner: string;
  readonly source: string;
  readonly score: number;
  readonly city: string;
  readonly priority: '高' | '中' | '普通';
  readonly tags: readonly string[];
  readonly nextInterview: string;
}

interface Job {
  readonly key: string;
  readonly title: string;
  readonly department: string;
  readonly location: string;
  readonly headcount: number;
  readonly status: '招聘中' | '已暂停';
  readonly recruiter: string;
  readonly openDate: string;
  readonly tags: readonly string[];
}

interface Interview {
  readonly key: string;
  readonly candidate: string;
  readonly stage: Stage;
  readonly round: string;
  readonly interviewer: string;
  readonly scheduledAt: string;
  readonly mode: string;
  readonly result: '待进行' | '通过';
  readonly score: number | null;
}

const candidates: readonly Candidate[] = [
  { key: 'C-008', name: '陆可（演示）', job: 'HRBP', department: '人力资源部', stage: 'Offer', owner: '周悦', source: '内部推荐', score: 91, city: '北京', priority: '高', tags: ['带团队', '文化匹配'], nextInterview: '08-12 16:00' },
  { key: 'C-001', name: '林晨（演示）', job: '高级产品经理', department: '产品部', stage: 'Offer', owner: '林晓', source: '内部推荐', score: 92, city: '上海', priority: '高', tags: ['SaaS', '带团队', '文化匹配'], nextInterview: '08-12 14:00' },
  { key: 'C-004', name: '许宁（演示）', job: '前端工程师', department: '研发部', stage: '已录用', owner: '周悦', source: '内部推荐', score: 95, city: '广州', priority: '普通', tags: ['SaaS', '国际化'], nextInterview: '—' },
  { key: 'C-006', name: '顾航（演示）', job: '高级产品经理', department: '产品部', stage: '面试中', owner: '林晓', source: '招聘官网', score: 90, city: '苏州', priority: '高', tags: ['SaaS', '带团队'], nextInterview: '08-13 11:00' },
  { key: 'C-002', name: '周悦（演示）', job: '前端工程师', department: '研发部', stage: '面试中', owner: '周悦', source: '招聘官网', score: 88, city: '深圳', priority: '高', tags: ['国际化', '数据驱动'], nextInterview: '08-11 10:00' },
  { key: 'C-003', name: '陈拓（演示）', job: 'HRBP', department: '人力资源部', stage: '简历筛选', owner: '林晓', source: '社交招聘', score: 84, city: '北京', priority: '中', tags: ['带团队', '文化匹配'], nextInterview: '08-14 09:30' },
  { key: 'C-007', name: '沈珂（演示）', job: '管培生', department: '战略部', stage: '简历筛选', owner: '林晓', source: '招聘官网', score: 82, city: '广州', priority: '中', tags: ['文化匹配', '数据驱动'], nextInterview: '08-15 10:00' },
  { key: 'C-005', name: '唐婧（演示）', job: '数据分析师', department: '数据部', stage: '人才寻访', owner: '周悦', source: '猎头', score: 79, city: '杭州', priority: '普通', tags: ['数据驱动'], nextInterview: '—' },
];

const jobs: readonly Job[] = [
  { key: 'J-001', title: '高级产品经理', department: '产品部', location: '上海', headcount: 2, status: '招聘中', recruiter: '林晓', openDate: '2026-08-01', tags: ['急招', '社招'] },
  { key: 'J-002', title: '前端工程师', department: '研发部', location: '深圳', headcount: 3, status: '招聘中', recruiter: '周悦', openDate: '2026-08-02', tags: ['社招', '可远程'] },
  { key: 'J-003', title: 'HRBP', department: '人力资源部', location: '北京', headcount: 1, status: '招聘中', recruiter: '林晓', openDate: '2026-08-03', tags: ['急招', '社招'] },
  { key: 'J-004', title: '数据分析师', department: '数据部', location: '杭州', headcount: 2, status: '已暂停', recruiter: '周悦', openDate: '2026-07-25', tags: ['社招'] },
  { key: 'J-005', title: '管培生', department: '战略部', location: '广州', headcount: 5, status: '招聘中', recruiter: '林晓', openDate: '2026-08-05', tags: ['校招'] },
];

const interviews: readonly Interview[] = [
  { key: 'I-002', candidate: '周悦（演示）', stage: '面试中', round: '专业面', interviewer: '研发经理', scheduledAt: '08-11 10:00', mode: '视频', result: '待进行', score: null },
  { key: 'I-001', candidate: '林晨（演示）', stage: 'Offer', round: '终面', interviewer: '产品负责人', scheduledAt: '08-12 14:00', mode: '现场', result: '待进行', score: null },
  { key: 'I-005', candidate: '陆可（演示）', stage: 'Offer', round: '终面', interviewer: 'HR 负责人', scheduledAt: '08-12 16:00', mode: '现场', result: '待进行', score: null },
  { key: 'I-004', candidate: '顾航（演示）', stage: '面试中', round: '专业面', interviewer: '产品负责人', scheduledAt: '08-13 11:00', mode: '视频', result: '待进行', score: null },
  { key: 'I-006', candidate: '陈拓（演示）', stage: '简历筛选', round: 'HR 初试', interviewer: '林晓', scheduledAt: '08-14 09:30', mode: '电话', result: '待进行', score: null },
  { key: 'I-003', candidate: '许宁（演示）', stage: '已录用', round: '终面', interviewer: '研发 VP', scheduledAt: '08-06 15:00', mode: '现场', result: '通过', score: 95 },
];

const tableViews: Readonly<Record<TableId, readonly { readonly id: ViewId; readonly label: string; readonly icon: ReactNode }[]>> = {
  candidates: [
    { id: 'candidate-grid', label: '全部候选人', icon: <TableOutlined /> },
    { id: 'candidate-kanban', label: '招聘漏斗看板', icon: <AppstoreOutlined /> },
    { id: 'candidate-dashboard', label: '招聘仪表盘', icon: <DashboardOutlined /> },
  ],
  jobs: [{ id: 'job-grid', label: '开放职位', icon: <TableOutlined /> }],
  interviews: [
    { id: 'interview-grid', label: '面试台账', icon: <TableOutlined /> },
    { id: 'interview-calendar', label: '面试日历', icon: <CalendarOutlined /> },
  ],
};

const stageColors: Readonly<Record<Stage, string>> = {
  人才寻访: 'default', 简历筛选: 'blue', 面试中: 'purple', Offer: 'gold', 已录用: 'green',
};
const stageProgressColors: Readonly<Record<Stage, string>> = {
  人才寻访: '#64748b', 简历筛选: '#2563eb', 面试中: '#7c3aed', Offer: '#d97706', 已录用: '#16a34a',
};

/** 展示与生产 Base 同构的公开只读样例，不读取浏览器身份或真实人员数据。 */
export function MultidimensionalBaseDemo() {
  const [table, setTable] = useState<TableId>('candidates');
  const [view, setView] = useState<ViewId>('candidate-grid');
  const selectTable = (next: TableId) => {
    setTable(next);
    setView(tableViews[next][0]?.id ?? 'candidate-grid');
  };

  return <main className="base-demo" aria-labelledby="demo-title">
    <header className="base-demo-topbar">
      <Link className="base-demo-brand" href="/"><span><DatabaseOutlined /></span><strong>GaoQ OS</strong><small>Data Workspace</small></Link>
      <div className="base-demo-status"><span><CheckCircleFilled /> 生产样例已创建</span><span><LockOutlined /> 公开页仅含虚构数据</span></div>
      <Button href="/workspace/bases" type="primary">进入正式工作台</Button>
    </header>

    <section className="base-demo-intro">
      <div><Tag color="blue">只读演示</Tag><h1 id="demo-title">招聘运营中心</h1><p>一套 Base，把职位、候选人和面试安排连成可筛选、可关联、可自动化的招聘数据工作台。</p></div>
      <dl><div><dt>数据表</dt><dd>3</dd></div><div><dt>演示记录</dt><dd>19</dd></div><div><dt>业务视图</dt><dd>6</dd></div><div><dt>自动化</dt><dd>1</dd></div></dl>
    </section>

    <section className="base-demo-workbench" aria-label="招聘运营多维表格">
      <aside className="base-demo-sidebar">
        <div className="base-demo-space-title"><span>空间</span><Tag>1</Tag></div>
        <div className="base-demo-space-item"><DatabaseOutlined /><span><strong>招聘运营中心</strong><small>3 张表 · 1 个自动化</small></span></div>
        <div className="base-demo-integrations"><strong>同一份数据，多种入口</strong><span><SafetyCertificateOutlined /> 租户与字段权限</span><span><LinkOutlined /> 表单和跨表关联</span><span><RobotOutlined /> MCP / CLI / API</span></div>
      </aside>

      <div className="base-demo-main">
        <header className="base-demo-base-header"><div><h2>招聘运营中心（多维表示例）</h2><p>全部姓名与招聘信息均为虚构样例。</p></div><Tag icon={<ThunderboltOutlined />} color="purple">1 条自动化 · 未启用</Tag></header>
        <div className="base-demo-table-tabs" role="tablist" aria-label="数据表">
          <TableTab active={table === 'candidates'} label="候选人" count={8} onClick={() => selectTable('candidates')} />
          <TableTab active={table === 'jobs'} label="招聘职位" count={5} onClick={() => selectTable('jobs')} />
          <TableTab active={table === 'interviews'} label="面试安排" count={6} onClick={() => selectTable('interviews')} />
        </div>
        <div className="base-demo-viewbar"><div role="tablist" aria-label="视图">{tableViews[table].map((item) => <button key={item.id} className={view === item.id ? 'is-active' : ''} type="button" role="tab" aria-selected={view === item.id} onClick={() => setView(item.id)}>{item.icon}{item.label}</button>)}</div><span>关联字段实时读取 · 更新于刚刚</span></div>
        <div className="base-demo-content">
          {view.endsWith('-grid') ? <div className="base-demo-mobile-hint">左右滑动查看更多字段 <span aria-hidden="true">→</span></div> : null}
          {view === 'candidate-grid' ? <CandidateGrid /> : null}
          {view === 'candidate-kanban' ? <CandidateKanban /> : null}
          {view === 'candidate-dashboard' ? <CandidateDashboard /> : null}
          {view === 'job-grid' ? <JobGrid /> : null}
          {view === 'interview-grid' ? <InterviewGrid /> : null}
          {view === 'interview-calendar' ? <InterviewCalendar /> : null}
        </div>
      </div>
    </section>

    <footer className="base-demo-footer"><span>样例 Base ID：01KZKA3ZTXR2S8EGTG4B2QJF1P</span><span>REST · OpenAPI · MCP · CLI</span></footer>
  </main>;
}

function TableTab(props: { readonly active: boolean; readonly label: string; readonly count: number; readonly onClick: () => void }) {
  return <button className={props.active ? 'is-active' : ''} type="button" role="tab" aria-selected={props.active} onClick={props.onClick}><TableOutlined /> {props.label}<span>{props.count}</span></button>;
}

function CandidateGrid() {
  const columns = useMemo<ColumnsType<Candidate>>(() => [
    { title: '候选人', dataIndex: 'name', key: 'name', fixed: 'left', width: 170, render: (name: string) => <div className="base-demo-person"><Avatar size={26}>{name.slice(0, 1)}</Avatar><strong>{name}</strong></div> },
    { title: '应聘职位（关联）', dataIndex: 'job', key: 'job', width: 160, render: (value: string) => <span className="base-demo-relation"><LinkOutlined />{value}</span> },
    { title: '职位部门（关联）', dataIndex: 'department', key: 'department', width: 150 },
    { title: '招聘阶段', dataIndex: 'stage', key: 'stage', width: 120, render: (value: Stage) => <Tag color={stageColors[value]}>{value}</Tag> },
    { title: '招聘负责人', dataIndex: 'owner', key: 'owner', width: 120 },
    { title: '候选来源', dataIndex: 'source', key: 'source', width: 120 },
    { title: '综合评分', dataIndex: 'score', key: 'score', width: 110, sorter: (left, right) => left.score - right.score, render: (value: number) => <strong className="base-demo-score">{value}</strong> },
    { title: '所在城市', dataIndex: 'city', key: 'city', width: 100 },
    { title: '优先级', dataIndex: 'priority', key: 'priority', width: 90, render: (value: Candidate['priority']) => <Tag color={value === '高' ? 'red' : value === '中' ? 'gold' : 'default'}>{value}</Tag> },
    { title: '人才标签', dataIndex: 'tags', key: 'tags', width: 220, render: (values: readonly string[]) => <Space size={[0, 4]} wrap>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> },
    { title: '下次面试', dataIndex: 'nextInterview', key: 'nextInterview', width: 130 },
  ], []);
  return <Table<Candidate> className="base-demo-table" rowKey="key" dataSource={[...candidates]} columns={columns} pagination={false} scroll={{ x: 1480, y: 510 }} size="middle" />;
}

function CandidateKanban() {
  const stages: readonly Stage[] = ['人才寻访', '简历筛选', '面试中', 'Offer', '已录用'];
  return <div className="base-demo-kanban">{stages.map((stage) => { const rows = candidates.filter((candidate) => candidate.stage === stage); return <section key={stage}><header><span><i className={`stage-${stage}`} />{stage}</span><b>{rows.length}</b></header><div>{rows.map((candidate) => <article key={candidate.key}><div><strong>{candidate.name}</strong><Tag color={candidate.priority === '高' ? 'red' : 'default'}>{candidate.priority}</Tag></div><span className="base-demo-card-relation">{candidate.job}</span><p>{candidate.department} · {candidate.city}</p><footer><span>{candidate.owner}</span><b>{candidate.score}</b></footer></article>)}</div></section>; })}</div>;
}

function CandidateDashboard() {
  const stages: readonly Stage[] = ['人才寻访', '简历筛选', '面试中', 'Offer', '已录用'];
  const sourceCounts = ['内部推荐', '招聘官网', '社交招聘', '猎头'].map((source) => ({ source, count: candidates.filter((candidate) => candidate.source === source).length }));
  return <div className="base-demo-dashboard"><section className="base-demo-funnel"><header><h3>招聘漏斗</h3><span>当前管道 8 人</span></header>{stages.map((stage) => { const count = candidates.filter((candidate) => candidate.stage === stage).length; return <div key={stage}><span>{stage}</span><Progress percent={(count / candidates.length) * 100} showInfo={false} strokeColor={stageProgressColors[stage]} /><strong>{count}</strong></div>; })}</section><section className="base-demo-sources"><header><h3>候选来源</h3><span>虚构样例</span></header>{sourceCounts.map((item) => <div key={item.source}><span>{item.source}</span><strong>{item.count}</strong><small>{Math.round((item.count / candidates.length) * 100)}%</small></div>)}</section><section className="base-demo-attention"><header><h3>本周关注</h3><span>规则自动聚合</span></header><div><b>4</b><span>待进行面试</span></div><div><b>2</b><span>Offer 阶段</span></div><div><b>88</b><span>平均评分</span></div></section></div>;
}

function JobGrid() {
  const columns: ColumnsType<Job> = [
    { title: '职位名称', dataIndex: 'title', key: 'title', width: 210, render: (value: string) => <strong>{value}</strong> },
    { title: '所属部门', dataIndex: 'department', key: 'department', width: 150 },
    { title: '工作地点', dataIndex: 'location', key: 'location', width: 110 },
    { title: '招聘人数', dataIndex: 'headcount', key: 'headcount', width: 100 },
    { title: '职位状态', dataIndex: 'status', key: 'status', width: 110, render: (value: Job['status']) => <Tag color={value === '招聘中' ? 'green' : 'gold'}>{value}</Tag> },
    { title: '招聘负责人', dataIndex: 'recruiter', key: 'recruiter', width: 130 },
    { title: '开放日期', dataIndex: 'openDate', key: 'openDate', width: 130 },
    { title: '职位标签', dataIndex: 'tags', key: 'tags', render: (values: readonly string[]) => <Space size={[0, 4]} wrap>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> },
  ];
  return <Table<Job> className="base-demo-table" rowKey="key" dataSource={[...jobs]} columns={columns} pagination={false} scroll={{ x: 1050 }} />;
}

function InterviewGrid() {
  const columns: ColumnsType<Interview> = [
    { title: '候选人（关联）', dataIndex: 'candidate', key: 'candidate', width: 180, render: (value: string) => <span className="base-demo-relation"><LinkOutlined />{value}</span> },
    { title: '当前招聘阶段（关联）', dataIndex: 'stage', key: 'stage', width: 180, render: (value: Stage) => <Tag color={stageColors[value]}>{value}</Tag> },
    { title: '面试轮次', dataIndex: 'round', key: 'round', width: 120 },
    { title: '面试官', dataIndex: 'interviewer', key: 'interviewer', width: 130 },
    { title: '面试时间', dataIndex: 'scheduledAt', key: 'scheduledAt', width: 140 },
    { title: '面试方式', dataIndex: 'mode', key: 'mode', width: 110 },
    { title: '面试结果', dataIndex: 'result', key: 'result', width: 110, render: (value: Interview['result']) => <Tag color={value === '通过' ? 'green' : 'default'}>{value}</Tag> },
    { title: '面试评分', dataIndex: 'score', key: 'score', render: (value: number | null) => value ?? '—' },
  ];
  return <Table<Interview> className="base-demo-table" rowKey="key" dataSource={[...interviews]} columns={columns} pagination={false} scroll={{ x: 1100 }} />;
}

function InterviewCalendar() {
  return <div className="base-demo-calendar"><header><h3>2026 年 8 月</h3><span>本周面试安排</span></header><div className="base-demo-week"><span>周一</span><span>周二</span><span>周三</span><span>周四</span><span>周五</span></div><div className="base-demo-days">{[10, 11, 12, 13, 14].map((day) => <section key={day}><b>{day}</b>{interviews.filter((item) => item.scheduledAt.startsWith(`08-${String(day).padStart(2, '0')}`)).map((item) => <article key={item.key}><time>{item.scheduledAt.slice(6)}</time><strong>{item.candidate}</strong><span>{item.round} · {item.mode}</span></article>)}</section>)}</div></div>;
}
