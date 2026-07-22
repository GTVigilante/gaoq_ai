'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { createIdempotencyKey, ErpApiError, erpFetch, isDefinitiveWriteRejection, strongEtag } from '../lib/api-client';
import {
  parseApprovalDelegations,
  type ApprovalDelegationView,
  type IdentityProfileView,
} from '../lib/approval-contract';
import {
  buildApprovalDelegationCreateInput,
  type ApprovalDelegationCreateInput,
} from '../lib/approval-task-contract';

interface PendingCreate {
  readonly body: ApprovalDelegationCreateInput;
  readonly actorId: string;
  readonly key: string;
}

interface PendingRevoke {
  readonly item: ApprovalDelegationView;
  readonly actorId: string;
  readonly key: string;
}

/** H5 本人限期委托管理；AI 仍只能读取委托 Resource。 */
export function MobileApprovalDelegation(props: {
  readonly open: boolean;
  readonly identity: IdentityProfileView | null;
  readonly onClose: () => void;
}) {
  const [items, setItems] = useState<readonly ApprovalDelegationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState(defaultPeriod);
  const [delegateId, setDelegateId] = useState('');
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<PendingRevoke | null>(null);
  const canRead = props.identity?.scopes.includes('erp:approval:delegation:read') ?? false;
  const canWrite = props.identity?.scopes.includes('erp:approval:delegation:write') ?? false;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await erpFetch<unknown>('/api/approvals/delegations/mine', {
        ...(signal === undefined ? {} : { signal }),
      });
      setItems(parseApprovalDelegations(response.data));
    } catch (value) {
      if (value instanceof DOMException && value.name === 'AbortError') return;
      setError(errorMessage(value, '审批委托加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!props.open || !canRead) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [canRead, load, props.open]);

  const finishCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingCreate !== null || pendingRevoke !== null || writing || !canWrite || props.identity === null) return;
    let body: ApprovalDelegationCreateInput;
    try {
      body = buildApprovalDelegationCreateInput({ delegateId, ...period }, props.identity.actorId);
    } catch {
      setError('代理主体或有效期无效；单次委托不能超过 30 天');
      return;
    }
    const attempt = Object.freeze({
      body,
      actorId: props.identity.actorId,
      key: createIdempotencyKey('mobile-approval-delegation-create'),
    });
    setPendingCreate(attempt);
    await create(attempt);
  };

  const create = async (attempt: PendingCreate) => {
    if (props.identity?.actorId !== attempt.actorId) {
      setPendingCreate(null);
      setError('登录主体已变化，请重新创建委托');
      return;
    }
    setWriting(true);
    setError(null);
    try {
      await erpFetch<unknown>('/api/approvals/delegations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': attempt.key },
        body: JSON.stringify(attempt.body),
      });
      setPendingCreate(null);
      setDelegateId('');
      setPeriod(defaultPeriod());
      await load();
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPendingCreate(null);
      setError(errorMessage(value, '创建结果未知；请使用当前按钮重试'));
    } finally {
      setWriting(false);
    }
  };

  const requestRevoke = async (item: ApprovalDelegationView) => {
    if (!canWrite || writing || pendingCreate !== null || pendingRevoke !== null) return;
    if (!window.confirm(`确认撤销对 ${item.delegateId} 的审批委托？`)) return;
    const attempt = Object.freeze({
      item,
      actorId: props.identity?.actorId ?? '',
      key: createIdempotencyKey('mobile-approval-delegation-revoke'),
    });
    setPendingRevoke(attempt);
    await revoke(attempt);
  };

  const revoke = async (attempt: PendingRevoke) => {
    if (props.identity?.actorId !== attempt.actorId) {
      setPendingRevoke(null);
      setError('登录主体已变化，请重新选择要撤销的委托');
      return;
    }
    setWriting(true);
    setError(null);
    try {
      await erpFetch<unknown>(`/api/approvals/delegations/${encodeURIComponent(attempt.item.id)}/revoke`, {
        method: 'POST',
        headers: { 'if-match': strongEtag(attempt.item.version), 'idempotency-key': attempt.key },
      });
      setPendingRevoke(null);
      await load();
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPendingRevoke(null);
      setError(errorMessage(value, '撤销结果未知；请复用当前请求重试'));
    } finally {
      setWriting(false);
    }
  };

  if (!props.open || !canRead || props.identity === null) return null;
  return <div className="mobile-sheet-backdrop mobile-operation-backdrop" role="presentation" onClick={props.onClose}>
    <section className="mobile-detail-sheet mobile-initiation-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-delegation-title" onClick={(event) => event.stopPropagation()}>
      <header>
        <div><p>持续授权</p><h2 id="mobile-delegation-title">审批委托</h2></div>
        <button type="button" aria-label="关闭审批委托" onClick={props.onClose}>关闭</button>
      </header>
      <div className="mobile-initiation-body">
        <section className="mobile-initiation-notice"><strong>限期授权边界</strong><p>只能为本人创建最长 30 天且不重叠的委托。AI 可读取，不能授予或撤销权限。</p></section>
        {error === null ? null : <p className="mobile-detail-error" role="alert">{error}</p>}
        {pendingCreate === null ? null : <section className="mobile-initiation-notice"><strong>创建结果尚未确认</strong><p>请勿刷新；将复用相同正文和幂等键重试。</p></section>}
        {pendingRevoke === null ? null : <section className="mobile-initiation-notice"><strong>撤销结果尚未确认</strong><p>委托 {pendingRevoke.item.id} 将使用原版本和幂等键重试。</p></section>}
        {canWrite ? <form className="mobile-initiation-form" onSubmit={(event) => { void finishCreate(event); }}>
          <label>代理主体
            <input required maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" autoComplete="off" disabled={pendingCreate !== null || pendingRevoke !== null} value={pendingCreate?.body.delegateId ?? delegateId} onChange={(event) => setDelegateId(event.target.value)} placeholder="ERP 主体标识" />
          </label>
          <div className="mobile-period-grid">
            <label>开始时间<input required type="datetime-local" disabled={pendingCreate !== null || pendingRevoke !== null} value={pendingCreate === null ? period.validFrom : localDateTime(new Date(pendingCreate.body.validFrom))} onChange={(event) => setPeriod((current) => ({ ...current, validFrom: event.target.value }))} /></label>
            <label>截止时间<input required type="datetime-local" disabled={pendingCreate !== null || pendingRevoke !== null} value={pendingCreate === null ? period.validUntil : localDateTime(new Date(pendingCreate.body.validUntil))} onChange={(event) => setPeriod((current) => ({ ...current, validUntil: event.target.value }))} /></label>
          </div>
          <button className="mobile-initiation-submit" type={pendingCreate === null ? 'submit' : 'button'} disabled={writing || pendingRevoke !== null} onClick={pendingCreate === null ? undefined : () => { void create(pendingCreate); }}>
            {writing ? '正在处理…' : pendingCreate === null ? '创建委托' : '重试同一创建请求'}
          </button>
        </form> : null}
        <section className="mobile-delegation-list" aria-label="我的审批委托">
          <h3>当前委托</h3>
          {loading ? <p>正在读取…</p> : items.length === 0 ? <p>暂无审批委托</p> : items.map((item) => <article key={item.id}>
            <div><strong>{item.principalApproverId === props.identity?.actorId ? `我 → ${item.delegateId}` : `${item.principalApproverId} → 我`}</strong><span>{item.status === 'active' ? '有效' : '已撤销'}</span></div>
            <p>{formatTime(item.validFrom)} — {formatTime(item.validUntil)}</p>
            {item.status === 'active' && item.principalApproverId === props.identity?.actorId && canWrite
              ? <button type="button" disabled={writing || pendingCreate !== null || (pendingRevoke !== null && pendingRevoke.item.id !== item.id)} onClick={() => pendingRevoke?.item.id === item.id ? void revoke(pendingRevoke) : void requestRevoke(item)}>{pendingRevoke?.item.id === item.id ? '重试撤销' : '撤销委托'}</button>
              : null}
          </article>)}
        </section>
      </div>
    </section>
  </div>;
}

function defaultPeriod(): { readonly validFrom: string; readonly validUntil: string } {
  const start = new Date(Date.now() + 5 * 60 * 1_000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1_000);
  return { validFrom: localDateTime(start), validUntil: localDateTime(end) };
}

function localDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

function errorMessage(value: unknown, fallback: string): string {
  if (!(value instanceof ErpApiError)) return fallback;
  return `${value.message}${value.traceId === null ? '' : `（追踪标识：${value.traceId}）`}`;
}
