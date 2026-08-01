'use client';

import { useCallback, useEffect, useState } from 'react';

import { erpFetch } from '../../lib/api-client';

interface Dashboard {
  readonly asOf: string;
  readonly window: { readonly from: string; readonly to: string; readonly timezone: 'Asia/Shanghai' };
  readonly generatedAt: string;
  readonly freshness: {
    readonly transactional: 'live';
    readonly operatingSummaryDate: string | null;
    readonly payrollPeriod: string | null;
  };
  readonly workforce: {
    readonly activeHeadcount: number;
    readonly probationHeadcount: number;
    readonly suspendedHeadcount: number;
  };
  readonly approvals: {
    readonly running: number;
    readonly overdue48h: number;
    readonly completed30d: number;
    readonly approvalRateBps: number | null;
  };
  readonly recruitment: {
    readonly openPositionCount: number;
    readonly openHeadcount: number;
    readonly activeApplicationCount: number;
    readonly hired30d: number;
  };
  readonly learning: {
    readonly mandatoryAssignments: number;
    readonly completedMandatoryAssignments: number;
    readonly expiredMandatoryAssignments: number;
    readonly completionRateBps: number | null;
  };
  readonly payroll: {
    readonly period: string | null;
    readonly status: PayrollStatus | null;
    readonly employeeCount: number | null;
  };
  readonly operating: {
    readonly summaryDate: string | null;
    readonly revision: number | null;
    readonly currency: 'CNY' | null;
    readonly gmvMinor: number | null;
    readonly paidOrderCount: number | null;
    readonly refundMinor: number | null;
  };
  readonly sources: readonly string[];
}

type PayrollStatus =
  | 'draft' | 'collecting' | 'review' | 'pending_approval' | 'approved'
  | 'locked' | 'disbursing' | 'reconciling' | 'reconciled';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DASHBOARD_SOURCES = Object.freeze([
  'org_employees',
  'approval_instances',
  'approval_actions',
  'recruitment_positions',
  'recruitment_applications',
  'knowledge_training_assignments',
  'payroll_periods',
  'op_operating_summaries',
] as const);
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  org_employees: '员工主数据', approval_instances: '审批实例', approval_actions: '审批动作日志',
  recruitment_positions: '招聘职位', recruitment_applications: '候选申请',
  knowledge_training_assignments: '培训任务', payroll_periods: '薪资周期',
  op_operating_summaries: 'OP 经营日摘要',
};
const PAYROLL_STATUS_LABELS: Readonly<Record<PayrollStatus, string>> = {
  draft: '草稿', collecting: '采集中', review: '复核中', pending_approval: '待审批',
  approved: '已审批', locked: '已锁定', disbursing: '发放中',
  reconciling: '对账中', reconciled: '已对账',
};

/** 管理指标仅保留于页面内存，不写入浏览器持久化存储。 */
export function ManagementDashboard({ initialAsOf }: { readonly initialAsOf: string }) {
  const [asOf, setAsOf] = useState(initialAsOf);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async (date: string, signal?: AbortSignal): Promise<void> => {
    if (!DATE_PATTERN.test(date)) return;
    setState('loading');
    try {
      const response = await erpFetch<unknown>(
        `/api/analytics/management-dashboard?asOf=${encodeURIComponent(date)}`,
        { ...(signal === undefined ? {} : { signal }) },
      );
      setDashboard(parseDashboard(response.data));
      setState('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setDashboard(null);
      setState('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(initialAsOf, controller.signal);
    return () => controller.abort();
  }, [initialAsOf, load]);

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-kicker">GaoQ-OS / Management</p>
          <h1>管理驾驶舱</h1>
          <p>固定口径的组织与经营健康度。当前未配置目标基线，不作红黄绿绩效判定。</p>
        </div>
        <form
          className="dashboard-date-form"
          onSubmit={(event) => { event.preventDefault(); void load(asOf); }}
        >
          <label htmlFor="dashboard-as-of">口径日（上海时区）</label>
          <div>
            <input
              id="dashboard-as-of" type="date" value={asOf} max={initialAsOf}
              onChange={(event) => setAsOf(event.target.value)} required
            />
            <button type="submit" disabled={state === 'loading'}>刷新</button>
          </div>
        </form>
      </header>

      {state === 'loading' ? <DashboardState title="正在计算固定口径指标" detail="交易集合实时聚合，页面不会读取个人明细。" /> : null}
      {state === 'error' ? (
        <DashboardState title="暂时无法读取驾驶舱" detail="请确认登录与管理分析权限，或稍后重试。">
          <button type="button" onClick={() => { void load(asOf); }}>重新加载</button>
        </DashboardState>
      ) : null}
      {state === 'ready' && dashboard !== null ? <DashboardContent dashboard={dashboard} /> : null}
    </main>
  );
}

function DashboardContent({ dashboard }: { readonly dashboard: Dashboard }) {
  const overdueBps = ratioBps(dashboard.approvals.overdue48h, dashboard.approvals.running);
  return (
    <>
      <section className="dashboard-summary" aria-label="核心指标">
        <MetricCard label="在职人数" value={integer(dashboard.workforce.activeHeadcount)} note={`试用 ${integer(dashboard.workforce.probationHeadcount)} · 停职 ${integer(dashboard.workforce.suspendedHeadcount)}`} />
        <MetricCard label="进行中审批" value={integer(dashboard.approvals.running)} note={`其中超 48 小时 ${integer(dashboard.approvals.overdue48h)}`} />
        <MetricCard label="开放 HC" value={integer(dashboard.recruitment.openHeadcount)} note={`${integer(dashboard.recruitment.openPositionCount)} 个开放职位`} />
        <MetricCard label="最新日 GMV" value={money(dashboard.operating.gmvMinor)} note={coverage(dashboard.operating.summaryDate)} />
      </section>

      <section className="dashboard-columns">
        <article className="dashboard-panel">
          <header><div><p>30 日运营效率</p><h2>审批与人才流动</h2></div><span>{dashboard.window.from}—{dashboard.window.to}</span></header>
          <dl className="dashboard-detail-grid">
            <Detail label="完成审批" value={integer(dashboard.approvals.completed30d)} />
            <Detail label="审批通过率" value={percent(dashboard.approvals.approvalRateBps)} />
            <Detail label="活跃申请" value={integer(dashboard.recruitment.activeApplicationCount)} />
            <Detail label="30 日入职" value={integer(dashboard.recruitment.hired30d)} />
          </dl>
          <RatioBar label="审批通过占已完成" value={dashboard.approvals.approvalRateBps} />
          <RatioBar label="超时占进行中" value={overdueBps} />
        </article>

        <article className="dashboard-panel">
          <header><div><p>组织守护指标</p><h2>必修学习与薪资覆盖</h2></div><span>不含工资金额</span></header>
          <dl className="dashboard-detail-grid">
            <Detail label="必修任务" value={integer(dashboard.learning.mandatoryAssignments)} />
            <Detail label="已完成" value={integer(dashboard.learning.completedMandatoryAssignments)} />
            <Detail label="已过期" value={integer(dashboard.learning.expiredMandatoryAssignments)} />
            <Detail label="薪资覆盖人数" value={nullableInteger(dashboard.payroll.employeeCount)} />
          </dl>
          <RatioBar label="必修完成占比" value={dashboard.learning.completionRateBps} />
          <p className="dashboard-payroll-note">最新薪资周期：{dashboard.payroll.period ?? '暂无'} · 状态：{payrollStatus(dashboard.payroll.status)}</p>
        </article>
      </section>

      <section className="dashboard-provenance" aria-labelledby="dashboard-provenance-title">
        <div>
          <p>数据可追溯性</p>
          <h2 id="dashboard-provenance-title">口径、新鲜度与权威来源</h2>
        </div>
        <dl>
          <Detail label="计算时间" value={dateTime(dashboard.generatedAt)} />
          <Detail label="交易指标" value="实时查询" />
          <Detail label="OP 覆盖日" value={dashboard.freshness.operatingSummaryDate ?? '暂无'} />
          <Detail label="薪资覆盖月" value={dashboard.freshness.payrollPeriod ?? '暂无'} />
        </dl>
        <ul>{dashboard.sources.map((source) => <li key={source}>{SOURCE_LABELS[source] ?? source}<code>{source}</code></li>)}</ul>
      </section>
    </>
  );
}

function MetricCard(props: { readonly label: string; readonly value: string; readonly note: string }) {
  return <article className="dashboard-metric"><span>{props.label}</span><strong>{props.value}</strong><p>{props.note}</p></article>;
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function RatioBar({ label, value }: { readonly label: string; readonly value: number | null }) {
  const width = value === null ? 0 : Math.min(100, Math.max(0, value / 100));
  return (
    <div className="dashboard-ratio">
      <div><span>{label}</span><strong>{percent(value)}</strong></div>
      <div className="dashboard-ratio-track" role="img" aria-label={`${label} ${percent(value)}`}>
        <span style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function DashboardState(props: {
  readonly title: string; readonly detail: string; readonly children?: React.ReactNode;
}) {
  return <section className="dashboard-state"><h2>{props.title}</h2><p>{props.detail}</p>{props.children}</section>;
}

function parseDashboard(value: unknown): Dashboard {
  const root = record(value);
  const window = record(root.window);
  const freshness = record(root.freshness);
  const workforce = record(root.workforce);
  const approvals = record(root.approvals);
  const recruitment = record(root.recruitment);
  const learning = record(root.learning);
  const payroll = record(root.payroll);
  const operating = record(root.operating);
  const sources = root.sources;
  const result: Dashboard = {
    asOf: date(root.asOf),
    window: { from: date(window.from), to: date(window.to), timezone: literal(window.timezone, 'Asia/Shanghai') },
    generatedAt: isoDateTime(root.generatedAt),
    freshness: {
      transactional: literal(freshness.transactional, 'live'),
      operatingSummaryDate: nullableDate(freshness.operatingSummaryDate),
      payrollPeriod: nullableMonth(freshness.payrollPeriod),
    },
    workforce: {
      activeHeadcount: count(workforce.activeHeadcount), probationHeadcount: count(workforce.probationHeadcount),
      suspendedHeadcount: count(workforce.suspendedHeadcount),
    },
    approvals: {
      running: count(approvals.running), overdue48h: count(approvals.overdue48h),
      completed30d: count(approvals.completed30d), approvalRateBps: nullableBps(approvals.approvalRateBps),
    },
    recruitment: {
      openPositionCount: count(recruitment.openPositionCount), openHeadcount: count(recruitment.openHeadcount),
      activeApplicationCount: count(recruitment.activeApplicationCount), hired30d: count(recruitment.hired30d),
    },
    learning: {
      mandatoryAssignments: count(learning.mandatoryAssignments),
      completedMandatoryAssignments: count(learning.completedMandatoryAssignments),
      expiredMandatoryAssignments: count(learning.expiredMandatoryAssignments),
      completionRateBps: nullableBps(learning.completionRateBps),
    },
    payroll: {
      period: nullableMonth(payroll.period), status: nullablePayrollStatus(payroll.status),
      employeeCount: nullableCount(payroll.employeeCount),
    },
    operating: {
      summaryDate: nullableDate(operating.summaryDate), revision: nullablePositiveInteger(operating.revision),
      currency: operating.currency === null ? null : literal(operating.currency, 'CNY'),
      gmvMinor: nullableCount(operating.gmvMinor), paidOrderCount: nullableCount(operating.paidOrderCount),
      refundMinor: nullableCount(operating.refundMinor),
    },
    sources: parseSources(sources),
  };
  return Object.freeze(result);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  return value as Readonly<Record<string, unknown>>;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

function nullableCount(value: unknown): number | null { return value === null ? null : count(value); }
function nullablePositiveInteger(value: unknown): number | null {
  if (value === null) return null;
  const parsed = count(value);
  if (parsed < 1) throw invalid();
  return parsed;
}
function nullableBps(value: unknown): number | null {
  const parsed = nullableCount(value);
  if (parsed !== null && parsed > 10_000) throw invalid();
  return parsed;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw invalid();
  return value;
}
function nullableDate(value: unknown): string | null { return value === null ? null : date(value); }
function nullableMonth(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw invalid();
  return value;
}
function isoDateTime(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) throw invalid();
  return value;
}
function literal<T extends string>(value: unknown, expected: T): T {
  if (value !== expected) throw invalid();
  return expected;
}
function nullablePayrollStatus(value: unknown): PayrollStatus | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !(value in PAYROLL_STATUS_LABELS)) throw invalid();
  return value as PayrollStatus;
}
function parseSources(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length !== DASHBOARD_SOURCES.length ||
    value.some((item, index) => item !== DASHBOARD_SOURCES[index])) throw invalid();
  return Object.freeze([...DASHBOARD_SOURCES]);
}
function invalid(): Error { return new Error('DASHBOARD_RESPONSE_INVALID'); }

function integer(value: number): string { return new Intl.NumberFormat('zh-CN').format(value); }
function nullableInteger(value: number | null): string { return value === null ? '暂无' : integer(value); }
function percent(value: number | null): string {
  return value === null ? '暂无基数' : `${(value / 100).toFixed(1)}%`;
}
function money(value: number | null): string {
  if (value === null) return '暂无';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: 'CNY', maximumFractionDigits: 0,
  }).format(value / 100);
}
function coverage(value: string | null): string { return value === null ? '暂无 OP 覆盖数据' : `覆盖至 ${value}`; }
function payrollStatus(value: PayrollStatus | null): string {
  return value === null ? '暂无' : PAYROLL_STATUS_LABELS[value];
}
function dateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short', hour12: false,
  }).format(new Date(value));
}
function ratioBps(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round(numerator * 10_000 / denominator);
}
