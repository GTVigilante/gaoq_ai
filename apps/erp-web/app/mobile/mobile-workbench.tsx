'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  parseApprovalSummaries,
  parseApprovalTimeline,
  parseApprovalView,
  type ApprovalStatus,
  type ApprovalSummary,
  type ApprovalTimelineEntry,
  type ApprovalView,
} from '../lib/approval-contract';
import { createIdempotencyKey, ErpApiError, erpFetch, strongEtag } from '../lib/api-client';
import { MobileApprovalInitiation } from './mobile-approval-initiation';

type MobileTab = 'home' | 'approvals' | 'knowledge' | 'profile';
const STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = {
  draft: '草稿', running: '审批中', approved: '已通过', rejected: '已驳回',
  withdrawn: '已撤回', archived: '已归档',
};

/** H5 工作台不使用 localStorage/IndexedDB，敏感状态只保留在当前页面内存。 */
export function MobileWorkbench() {
  const [tab, setTab] = useState<MobileTab>('home');
  const [approvals, setApprovals] = useState<readonly ApprovalSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [detail, setDetail] = useState<ApprovalView | null>(null);
  const [timeline, setTimeline] = useState<readonly ApprovalTimelineEntry[]>([]);
  const [actorId, setActorId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [initiating, setInitiating] = useState(false);

  const loadApprovals = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setState('loading');
    try {
      const response = await erpFetch<unknown>('/api/approvals/instances/inbox', {
        ...(signal === undefined ? {} : { signal }),
      });
      const items = parseApprovalSummaries(response.data);
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

  const openApproval = useCallback(async (id: string) => {
    setDetailState('loading');
    setDetailError(null);
    try {
      const [instance, actions, profile] = await Promise.all([
        erpFetch<unknown>(`/api/approvals/instances/${encodeURIComponent(id)}`),
        erpFetch<unknown>(`/api/approvals/instances/${encodeURIComponent(id)}/timeline`),
        erpFetch<unknown>('/api/auth/profile'),
      ]);
      setDetail(parseApprovalView(instance.data));
      setTimeline(parseApprovalTimeline(actions.data));
      setActorId(parseActorId(profile.data));
      setDetailState('ready');
    } catch (value) {
      const error = value instanceof ErpApiError ? value : null;
      setDetailError(error?.traceId === null || error === null ? (error?.message ?? '审批详情加载失败') : `${error.message} · ${error.traceId}`);
      setDetailState('error');
    }
  }, []);

  const decide = useCallback(async (outcome: 'approved' | 'rejected') => {
    if (detail === null || actorId === null || writing || detail.riskLevel === 'R2') return;
    const confirmed = window.confirm(outcome === 'approved' ? '确认通过此审批？' : '确认拒绝此审批？');
    if (!confirmed) return;
    setWriting(true);
    setDetailError(null);
    try {
      await erpFetch(`/api/approvals/instances/${encodeURIComponent(detail.id)}/decisions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': strongEtag(detail.version),
          'idempotency-key': createIdempotencyKey('mobile-approval-decision'),
        },
        body: JSON.stringify({ principalApproverId: actorId, outcome }),
      });
      setDetail(null);
      setDetailState('idle');
      await loadApprovals();
    } catch (value) {
      const error = value instanceof ErpApiError ? value : null;
      setDetailError(error?.traceId === null || error === null ? (error?.message ?? '审批提交失败') : `${error.message} · ${error.traceId}`);
    } finally {
      setWriting(false);
    }
  }, [actorId, detail, loadApprovals, writing]);

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
          <>
            <div className="mobile-approval-toolbar"><p>只显示当前身份有权处理的待办。</p><button type="button" onClick={() => setInitiating(true)}>发起审批</button></div>
            <ApprovalPanel approvals={approvals} state={state} onRetry={() => { void loadApprovals(); }} onOpen={(id) => { void openApproval(id); }} />
          </>
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
      {detailState === 'idle' ? null : (
        <ApprovalDetailSheet
          detail={detail}
          timeline={timeline}
          state={detailState}
          error={detailError}
          writing={writing}
          onClose={() => { setDetail(null); setDetailState('idle'); setDetailError(null); }}
          onDecide={(outcome) => { void decide(outcome); }}
        />
      )}
      <MobileApprovalInitiation
        open={initiating}
        onClose={() => setInitiating(false)}
        onSubmitted={loadApprovals}
      />
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
  readonly onOpen: (id: string) => void;
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
          <button type="button" className="mobile-card-action" onClick={() => props.onOpen(approval.id)}>查看详情与时间线</button>
        </article>
      ))}
    </section>
  );
}

function ApprovalDetailSheet(props: {
  readonly detail: ApprovalView | null;
  readonly timeline: readonly ApprovalTimelineEntry[];
  readonly state: 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly writing: boolean;
  readonly onClose: () => void;
  readonly onDecide: (outcome: 'approved' | 'rejected') => void;
}) {
  return <div className="mobile-sheet-backdrop" role="presentation" onClick={props.onClose}>
    <section className="mobile-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-detail-title" onClick={(event) => event.stopPropagation()}>
      <header><div><p>审批详情</p><h2 id="mobile-detail-title">{props.detail?.title ?? '读取中'}</h2></div><button type="button" aria-label="关闭审批详情" onClick={props.onClose}>关闭</button></header>
      {props.state === 'loading' ? <PanelState title="正在读取详情" detail="同时校验权限和动作时间线。" /> : null}
      {props.error === null ? null : <p className="mobile-detail-error" role="alert">{props.error}</p>}
      {props.state === 'error' ? <PanelState title="无法读取审批详情" detail="关闭后可刷新待办重试。" /> : null}
      {props.state === 'ready' && props.detail !== null ? <div className="mobile-detail-body">
        {props.detail.riskLevel === 'R2' ? <div className="mobile-r2-notice"><strong>R2 强认证操作</strong><p>移动工作台仅查看。请使用绑定操作摘要与会话的 WebAuthn 受控确认流程。</p><Link href="/security/passkeys">管理 Passkey</Link></div> : null}
        <dl className="mobile-detail-meta">
          <div><dt>状态</dt><dd>{STATUS_LABEL[props.detail.status]}</dd></div>
          <div><dt>流程</dt><dd>{props.detail.templateCode} · r{props.detail.templateRevision}</dd></div>
          <div><dt>版本</dt><dd>v{props.detail.version}</dd></div>
          <div><dt>发起人</dt><dd>{props.detail.initiatorId}</dd></div>
        </dl>
        <section><h3>表单数据</h3><dl className="mobile-detail-fields">{Object.entries(props.detail.formData).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{formatFormValue(value)}</dd></div>)}</dl></section>
        <section><h3>动作时间线</h3>{props.timeline.length === 0 ? <p className="mobile-detail-muted">尚无动作记录</p> : <ol className="mobile-timeline">{props.timeline.map((entry) => <li key={entry.actionId}><span>{timelineLabel(entry)}</span><strong>{entry.actorId}</strong><time>{formatTime(entry.occurredAt)} · v{entry.aggregateVersion}</time></li>)}</ol>}</section>
        {props.detail.status === 'running' && props.detail.riskLevel === 'R1' ? <div className="mobile-decision-actions"><button type="button" className="reject" disabled={props.writing} onClick={() => props.onDecide('rejected')}>拒绝</button><button type="button" className="approve" disabled={props.writing} onClick={() => props.onDecide('approved')}>{props.writing ? '提交中…' : '通过'}</button></div> : null}
      </div> : null}
    </section>
  </div>;
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

function formatTime(value: string | null): string {
  if (value === null) return '尚未提交';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function parseActorId(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new Error('IDENTITY_PROFILE_INVALID');
  const actorId = (value as Readonly<Record<string, unknown>>).actorId;
  if (typeof actorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(actorId)) throw new Error('IDENTITY_PROFILE_INVALID');
  return actorId;
}

function formatFormValue(value: unknown): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).redacted === true) return '已脱敏';
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function timelineLabel(entry: ApprovalTimelineEntry): string {
  const labels: Readonly<Record<ApprovalTimelineEntry['actionType'], string>> = {
    'instance.submitted': '提交审批',
    'instance.decided': entry.outcome === 'approved' ? '审批通过' : '审批拒绝',
    'instance.approver_transferred': '转交审批人',
    'instance.approver_added': '新增审批人',
    'instance.withdrawn': '撤回审批',
    'instance.archived': '归档审批',
  };
  return `${labels[entry.actionType]}${entry.delegated ? '（委托）' : ''}`;
}

function tabTitle(tab: MobileTab): string {
  return ({ home: '移动工作台', approvals: '审批待办', knowledge: '知识中心', profile: '我的' })[tab];
}
