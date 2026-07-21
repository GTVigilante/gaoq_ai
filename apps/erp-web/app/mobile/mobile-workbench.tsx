'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

type MobileTab = 'home' | 'approvals' | 'knowledge' | 'profile';
type ApprovalStatus = 'draft' | 'running' | 'approved' | 'rejected' | 'withdrawn' | 'archived';

interface ApprovalSummary {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly templateCode: string;
  readonly templateRevision: number;
  readonly riskLevel: 'R1' | 'R2';
  readonly version: number;
  readonly submittedAt: string | null;
  readonly completedAt: string | null;
}

const API_ORIGIN = process.env.NEXT_PUBLIC_ERP_API_ORIGIN ?? 'http://localhost:3001';
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = {
  draft: '草稿', running: '审批中', approved: '已通过', rejected: '已驳回',
  withdrawn: '已撤回', archived: '已归档',
};

/** H5 工作台不使用 localStorage/IndexedDB，敏感状态只保留在当前页面内存。 */
export function MobileWorkbench() {
  const [tab, setTab] = useState<MobileTab>('home');
  const [approvals, setApprovals] = useState<readonly ApprovalSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');

  const loadApprovals = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setState('loading');
    try {
      const response = await fetch(`${API_ORIGIN}/api/approvals/instances/inbox`, {
        credentials: 'include', cache: 'no-store',
        ...(signal === undefined ? {} : { signal }),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(response.status === 401 ? 'unauthorized' : 'unavailable');
      const value = await response.json() as unknown;
      const items = parseApprovalSummaries(value);
      setApprovals(items);
      setState(items.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setApprovals([]);
      setState('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadApprovals(controller.signal);
    return () => controller.abort();
  }, [loadApprovals]);

  return (
    <main className="mobile-shell">
      <header className="mobile-header">
        <div>
          <p className="mobile-kicker">GaoQ-OS</p>
          <h1>{tabTitle(tab)}</h1>
        </div>
        <span className="mobile-secure-badge">安全会话</span>
      </header>

      <div className="mobile-content">
        {tab === 'home' ? <HomePanel approvals={approvals} state={state} onOpen={() => setTab('approvals')} /> : null}
        {tab === 'approvals' ? (
          <ApprovalPanel approvals={approvals} state={state} onRetry={() => { void loadApprovals(); }} />
        ) : null}
        {tab === 'knowledge' ? <ComingSoon title="知识中心" text="培训任务将复用 ERP 知识应用服务与现有权限投影。" /> : null}
        {tab === 'profile' ? <ComingSoon title="我的" text="账号、安全设置和 Passkey 管理将保持服务端可信身份边界。" /> : null}
      </div>

      <nav className="mobile-tabs" aria-label="移动工作台主导航">
        {([
          ['home', '首页'], ['approvals', '审批'], ['knowledge', '知识'], ['profile', '我的'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? 'is-active' : undefined}
            aria-current={tab === value ? 'page' : undefined}
            onClick={() => setTab(value)}
          >
            <span className="mobile-tab-mark" aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
    </main>
  );
}

function HomePanel(props: {
  readonly approvals: readonly ApprovalSummary[];
  readonly state: 'loading' | 'ready' | 'empty' | 'error';
  readonly onOpen: () => void;
}) {
  const running = props.approvals.filter((item) => item.status === 'running').length;
  return (
    <section aria-labelledby="mobile-home-title">
      <div className="mobile-hero-card">
        <p>今日工作</p>
        <h2 id="mobile-home-title">把需要你处理的事，放在最前面。</h2>
        <button type="button" onClick={props.onOpen}>查看审批待办</button>
      </div>
      <div className="mobile-stat-grid" aria-label="工作摘要">
        <article><span>待处理审批</span><strong>{props.state === 'ready' ? running : '—'}</strong></article>
        <article><span>数据策略</span><strong>不离线缓存</strong></article>
      </div>
      <section className="mobile-notice" aria-label="安全提示">
        <strong>服务端权限生效</strong>
        <p>移动端不接受租户参数，不在浏览器持久化审批或员工敏感数据。</p>
      </section>
    </section>
  );
}

function ApprovalPanel(props: {
  readonly approvals: readonly ApprovalSummary[];
  readonly state: 'loading' | 'ready' | 'empty' | 'error';
  readonly onRetry: () => void;
}) {
  if (props.state === 'loading') return <PanelState title="正在读取审批待办" detail="数据仅保留在当前页面。" />;
  if (props.state === 'error') return (
    <PanelState title="暂时无法读取待办" detail="请确认登录状态或稍后重试。">
      <button type="button" className="mobile-retry" onClick={props.onRetry}>重新加载</button>
    </PanelState>
  );
  if (props.state === 'empty') return <PanelState title="没有待办审批" detail="新的审批任务会显示在这里。" />;
  return (
    <section className="mobile-list" aria-label="审批待办列表">
      {props.approvals.map((approval) => (
        <article key={approval.id} className="mobile-approval-card">
          <div className="mobile-card-heading">
            <span className={`mobile-status status-${approval.status}`}>
              {STATUS_LABEL[approval.status]}
            </span>
            <span>{approval.riskLevel}</span>
          </div>
          <h2>{approval.templateCode}</h2>
          <dl>
            <div><dt>实例</dt><dd>{approval.id}</dd></div>
            <div><dt>版本</dt><dd>v{approval.version}</dd></div>
            <div><dt>提交</dt><dd>{formatTime(approval.submittedAt)}</dd></div>
          </dl>
          <p>审批决策必须进入详情页并使用服务端版本、权限与强认证约束。</p>
        </article>
      ))}
    </section>
  );
}

function PanelState(props: {
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
}) {
  return <section className="mobile-panel-state"><h2>{props.title}</h2><p>{props.detail}</p>{props.children}</section>;
}

function ComingSoon({ title, text }: { readonly title: string; readonly text: string }) {
  return <section className="mobile-panel-state"><span>规划中</span><h2>{title}</h2><p>{text}</p></section>;
}

function parseApprovalSummaries(value: unknown): readonly ApprovalSummary[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('APPROVAL_RESPONSE_INVALID');
  return Object.freeze(value.map((item): ApprovalSummary => {
    if (typeof item !== 'object' || item === null) throw new Error('APPROVAL_RESPONSE_INVALID');
    const record = item as Readonly<Record<string, unknown>>;
    const status = record.status;
    if (
      typeof record.id !== 'string' || !ULID_PATTERN.test(record.id) ||
      typeof record.templateCode !== 'string' || record.templateCode.length < 1 ||
      record.templateCode.length > 64 ||
      !['draft', 'running', 'approved', 'rejected', 'withdrawn', 'archived'].includes(String(status)) ||
      (record.riskLevel !== 'R1' && record.riskLevel !== 'R2') ||
      typeof record.templateRevision !== 'number' || !Number.isInteger(record.templateRevision) ||
      record.templateRevision < 1 ||
      typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 1 ||
      (record.submittedAt !== null && typeof record.submittedAt !== 'string') ||
      (record.completedAt !== null && typeof record.completedAt !== 'string')
    ) throw new Error('APPROVAL_RESPONSE_INVALID');
    return Object.freeze({
      id: record.id, status: status as ApprovalStatus, templateCode: record.templateCode,
      templateRevision: record.templateRevision, riskLevel: record.riskLevel,
      version: record.version, submittedAt: record.submittedAt,
      completedAt: record.completedAt,
    });
  }));
}

function formatTime(value: string | null): string {
  if (value === null) return '尚未提交';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function tabTitle(tab: MobileTab): string {
  return ({ home: '移动工作台', approvals: '审批待办', knowledge: '知识中心', profile: '我的' })[tab];
}
