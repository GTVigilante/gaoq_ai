'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  parseApprovalSummaries,
  parseApprovalTimeline,
  parseApprovalView,
  parseIdentityProfile,
  type ApprovalStatus,
  type ApprovalSummary,
  type ApprovalTimelineEntry,
  type ApprovalView,
  type IdentityProfileView,
} from '../lib/approval-contract';
import { createIdempotencyKey, ErpApiError, erpFetch, isDefinitiveWriteRejection, strongEtag } from '../lib/api-client';
import { MobileApprovalDelegation } from './mobile-approval-delegation';
import { MobileApprovalInitiation } from './mobile-approval-initiation';
import { MobileApprovalTaskOperation, type MobileTaskOperation } from './mobile-approval-task-operation';
import { MobileKnowledgePanel } from './mobile-knowledge-panel';

type MobileTab = 'home' | 'approvals' | 'knowledge' | 'profile';
const STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = {
  draft: '草稿', running: '审批中', approved: '已通过', rejected: '已驳回',
  withdrawn: '已撤回', archived: '已归档',
};

interface PendingDecision {
  readonly instance: ApprovalView;
  readonly actorId: string;
  readonly outcome: 'approved' | 'rejected';
  readonly key: string;
}

/** H5 工作台不使用 localStorage/IndexedDB，敏感状态只保留在当前页面内存。 */
export function MobileWorkbench() {
  const [tab, setTab] = useState<MobileTab>('home');
  const [approvals, setApprovals] = useState<readonly ApprovalSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [detail, setDetail] = useState<ApprovalView | null>(null);
  const [timeline, setTimeline] = useState<readonly ApprovalTimelineEntry[]>([]);
  const [identity, setIdentity] = useState<IdentityProfileView | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const [initiating, setInitiating] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [taskOperation, setTaskOperation] = useState<MobileTaskOperation | null>(null);
  const [taskInstance, setTaskInstance] = useState<ApprovalSummary | null>(null);

  const loadApprovals = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setState('loading');
    try {
      const [response, profile] = await Promise.all([
        erpFetch<unknown>('/api/approvals/instances/inbox', { ...(signal === undefined ? {} : { signal }) }),
        erpFetch<unknown>('/api/auth/profile', { ...(signal === undefined ? {} : { signal }) }),
      ]);
      const items = parseApprovalSummaries(response.data);
      setApprovals(items);
      setIdentity(parseIdentityProfile(profile.data));
      setState(items.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setApprovals([]);
      setIdentity(null);
      setState('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadApprovals(controller.signal);
    return () => controller.abort();
  }, [loadApprovals]);

  useEffect(() => {
    if (pendingDecision !== null && identity?.actorId !== pendingDecision.actorId) {
      setPendingDecision(null);
      setDetailError('登录主体已变化，原待确认请求已失效');
    }
  }, [identity?.actorId, pendingDecision]);

  const openApproval = useCallback(async (id: string) => {
    setDetailState('loading');
    setDetailError(null);
    try {
      const [instance, actions] = await Promise.all([
        erpFetch<unknown>(`/api/approvals/instances/${encodeURIComponent(id)}`),
        erpFetch<unknown>(`/api/approvals/instances/${encodeURIComponent(id)}/timeline`),
      ]);
      setDetail(parseApprovalView(instance.data));
      setTimeline(parseApprovalTimeline(actions.data));
      setDetailState('ready');
    } catch (value) {
      const error = value instanceof ErpApiError ? value : null;
      setDetailError(error?.traceId === null || error === null ? (error?.message ?? '审批详情加载失败') : `${error.message} · ${error.traceId}`);
      setDetailState('error');
    }
  }, []);

  const executeDecision = useCallback(async (attempt: PendingDecision) => {
    if (identity?.actorId !== attempt.actorId) {
      setPendingDecision(null);
      setDetailError('登录主体已变化，请重新打开待办后操作');
      return;
    }
    setWriting(true);
    setDetailError(null);
    try {
      await erpFetch(`/api/approvals/instances/${encodeURIComponent(attempt.instance.id)}/decisions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': strongEtag(attempt.instance.version),
          'idempotency-key': attempt.key,
        },
        body: JSON.stringify({ principalApproverId: attempt.actorId, outcome: attempt.outcome }),
      });
      setPendingDecision(null);
      setDetail(null);
      setDetailState('idle');
      await loadApprovals();
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPendingDecision(null);
      const error = value instanceof ErpApiError ? value : null;
      setDetailError(error?.traceId === null || error === null ? (error?.message ?? '提交结果未知；请复用当前动作重试') : `${error.message} · ${error.traceId}`);
    } finally {
      setWriting(false);
    }
  }, [identity?.actorId, loadApprovals]);

  const decide = useCallback(async (outcome: 'approved' | 'rejected') => {
    if (
      detail === null || identity === null || writing || detail.riskLevel === 'R2' ||
      !identity.scopes.includes('erp:approval:task:decide')
    ) return;
    if (pendingDecision !== null) {
      if (pendingDecision.instance.id !== detail.id || pendingDecision.outcome !== outcome) {
        setDetailError('存在其他待确认审批请求，只能回到原审批并复用相同动作重试');
        return;
      }
      await executeDecision(pendingDecision);
      return;
    }
    const confirmed = window.confirm(outcome === 'approved' ? '确认通过此审批？' : '确认拒绝此审批？');
    if (!confirmed) return;
    const attempt = Object.freeze({
      instance: detail,
      actorId: identity.actorId,
      outcome,
      key: createIdempotencyKey('mobile-approval-decision'),
    });
    setPendingDecision(attempt);
    await executeDecision(attempt);
  }, [detail, executeDecision, identity, pendingDecision, writing]);

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
            <div className="mobile-approval-toolbar">
              <p>只显示当前身份有权处理的待办。</p>
              <div>
                {identity?.scopes.includes('erp:approval:delegation:read') ? <button type="button" className="secondary" onClick={() => setDelegating(true)}>审批委托</button> : null}
                <button type="button" onClick={() => setInitiating(true)}>发起审批</button>
              </div>
            </div>
            <ApprovalPanel approvals={approvals} state={state} onRetry={() => { void loadApprovals(); }} onOpen={(id) => { void openApproval(id); }} />
          </>
        ) : null}
        {tab === 'knowledge' ? <MobileKnowledgePanel key={`knowledge:${identity?.actorId ?? 'anonymous'}`} active canRead={identity?.scopes.includes('erp:knowledge:assignment:read') ?? false} /> : null}
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
          pendingDecision={pendingDecision}
          canDecide={identity?.scopes.includes('erp:approval:task:decide') ?? false}
          canTransfer={identity?.scopes.includes('erp:approval:task:transfer') ?? false}
          canAddSigner={identity?.scopes.includes('erp:approval:task:add_signer') ?? false}
          onClose={() => { setDetail(null); setDetailState('idle'); setDetailError(null); }}
          onDecide={(outcome) => { void decide(outcome); }}
          onTaskOperation={(operation) => {
            if (detail === null || pendingDecision !== null) return;
            setTaskInstance(detail);
            setTaskOperation(operation);
          }}
        />
      )}
      <MobileApprovalInitiation
        key={`initiation:${identity?.actorId ?? 'anonymous'}`}
        open={initiating}
        onClose={() => setInitiating(false)}
        onSubmitted={loadApprovals}
      />
      <MobileApprovalDelegation key={`delegation:${identity?.actorId ?? 'anonymous'}`} open={delegating} identity={identity} onClose={() => setDelegating(false)} />
      <MobileApprovalTaskOperation
        key={`task:${identity?.actorId ?? 'anonymous'}`}
        open={taskOperation !== null}
        operation={taskOperation}
        instance={taskInstance}
        identity={identity}
        onClose={() => setTaskOperation(null)}
        onCompleted={async () => {
          setDetail(null);
          setDetailState('idle');
          await loadApprovals();
        }}
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
  readonly pendingDecision: PendingDecision | null;
  readonly canDecide: boolean;
  readonly canTransfer: boolean;
  readonly canAddSigner: boolean;
  readonly onClose: () => void;
  readonly onDecide: (outcome: 'approved' | 'rejected') => void;
  readonly onTaskOperation: (operation: MobileTaskOperation) => void;
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
        {props.pendingDecision?.instance.id === props.detail.id ? <section className="mobile-initiation-notice"><strong>审批结果尚未确认</strong><p>请勿刷新页面；只能复用原版本、动作和幂等键重试。</p></section> : null}
        {props.detail.status === 'running' && props.detail.riskLevel === 'R1' && (props.canTransfer || props.canAddSigner) ? <div className="mobile-task-operation-actions">
          {props.canTransfer ? <button type="button" disabled={props.pendingDecision !== null} onClick={() => props.onTaskOperation('transfer')}>转交</button> : null}
          {props.canAddSigner ? <button type="button" disabled={props.pendingDecision !== null} onClick={() => props.onTaskOperation('add_signer')}>加签</button> : null}
        </div> : null}
        {props.detail.status === 'running' && props.detail.riskLevel === 'R1' && props.canDecide ? <div className="mobile-decision-actions"><button type="button" className="reject" disabled={props.writing || (props.pendingDecision !== null && (props.pendingDecision.instance.id !== props.detail.id || props.pendingDecision.outcome !== 'rejected'))} onClick={() => props.onDecide('rejected')}>{props.pendingDecision?.instance.id === props.detail.id && props.pendingDecision.outcome === 'rejected' ? '重试拒绝' : '拒绝'}</button><button type="button" className="approve" disabled={props.writing || (props.pendingDecision !== null && (props.pendingDecision.instance.id !== props.detail.id || props.pendingDecision.outcome !== 'approved'))} onClick={() => props.onDecide('approved')}>{props.writing ? '提交中…' : props.pendingDecision?.instance.id === props.detail.id && props.pendingDecision.outcome === 'approved' ? '重试通过' : '通过'}</button></div> : null}
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
