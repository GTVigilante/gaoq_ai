'use client';

import { useState, type FormEvent } from 'react';

import { createIdempotencyKey, ErpApiError, erpFetch, isDefinitiveWriteRejection, strongEtag } from '../lib/api-client';
import { type ApprovalSummary, type IdentityProfileView } from '../lib/approval-contract';
import { parseApprovalTaskResponse } from '../lib/approval-task-contract';

export type MobileTaskOperation = 'transfer' | 'add_signer';

interface PendingOperation {
  readonly instance: ApprovalSummary;
  readonly operation: MobileTaskOperation;
  readonly actorId: string;
  readonly targetActorId: string;
  readonly key: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** H5 R1 转交与加签；不确定结果隐藏面板后仍保留原版本、正文和幂等键。 */
export function MobileApprovalTaskOperation(props: {
  readonly open: boolean;
  readonly operation: MobileTaskOperation | null;
  readonly instance: ApprovalSummary | null;
  readonly identity: IdentityProfileView | null;
  readonly onClose: () => void;
  readonly onCompleted: (instance: ApprovalSummary) => Promise<void> | void;
}) {
  const [targetActorId, setTargetActorId] = useState('');
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveOperation = pending?.operation ?? props.operation;

  const finish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending !== null || writing || props.instance === null || props.identity === null || props.operation === null) return;
    const target = targetActorId.trim();
    if (!ID_PATTERN.test(target) || target === props.identity.actorId || props.instance.riskLevel !== 'R1') {
      setError('请输入不同于当前主体的有效 ERP 主体标识');
      return;
    }
    const attempt = Object.freeze({
      instance: props.instance,
      operation: props.operation,
      actorId: props.identity.actorId,
      targetActorId: target,
      key: createIdempotencyKey(`mobile-approval-${props.operation.replace('_', '-')}`),
    });
    setPending(attempt);
    await execute(attempt);
  };

  const execute = async (attempt: PendingOperation) => {
    if (props.identity?.actorId !== attempt.actorId) {
      setPending(null);
      setError('登录主体已变化，请重新打开待办后操作');
      return;
    }
    setWriting(true);
    setError(null);
    try {
      const transfer = attempt.operation === 'transfer';
      const response = await erpFetch<unknown>(
        `/api/approvals/instances/${encodeURIComponent(attempt.instance.id)}/${transfer ? 'transfers' : 'add-signers'}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'if-match': strongEtag(attempt.instance.version),
            'idempotency-key': attempt.key,
          },
          body: JSON.stringify(transfer
            ? { fromApproverId: attempt.actorId, toApproverId: attempt.targetActorId }
            : { approverId: attempt.targetActorId }),
        },
      );
      const updated = parseApprovalTaskResponse(response.data);
      setPending(null);
      setTargetActorId('');
      props.onClose();
      try {
        await props.onCompleted(updated);
      } catch {
        // 服务端操作已成功，刷新失败不能回退为写入失败。
      }
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPending(null);
      setError(errorMessage(value, '操作结果未知；请使用当前按钮重试'));
    } finally {
      setWriting(false);
    }
  };

  if (!props.open || effectiveOperation === null) return null;
  const transfer = effectiveOperation === 'transfer';
  return <div className="mobile-sheet-backdrop mobile-operation-backdrop" role="presentation" onClick={props.onClose}>
    <section className="mobile-detail-sheet mobile-operation-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-operation-title" onClick={(event) => event.stopPropagation()}>
      <header>
        <div><p>R1 任务操作</p><h2 id="mobile-operation-title">{transfer ? '转交审批任务' : '当前会签节点加签'}</h2></div>
        <button type="button" aria-label="关闭任务操作" onClick={props.onClose}>关闭</button>
      </header>
      <div className="mobile-initiation-body">
        <section className="mobile-initiation-notice">
          <strong>{transfer ? '转交边界' : '加签边界'}</strong>
          <p>{transfer ? '转交后当前主体将失去此待办。' : '仅当前会签节点允许加入新审批人。'}目标必须是同租户有效 ERP 主体。</p>
        </section>
        {pending === null ? null : <section className="mobile-initiation-notice"><strong>操作结果尚未确认</strong><p>请勿刷新页面；将复用同一正文、版本和幂等键重试。</p></section>}
        {error === null ? null : <p className="mobile-detail-error" role="alert">{error}</p>}
        <form className="mobile-initiation-form" onSubmit={(event) => { void finish(event); }}>
          <label>{transfer ? '转交目标主体' : '加签主体'}
            <input
              required
              maxLength={128}
              pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
              autoComplete="off"
              disabled={pending !== null}
              value={pending?.targetActorId ?? targetActorId}
              onChange={(event) => setTargetActorId(event.target.value)}
              placeholder="ERP 主体标识"
            />
          </label>
          <button className="mobile-initiation-submit" type={pending === null ? 'submit' : 'button'} disabled={writing} onClick={pending === null ? undefined : () => { void execute(pending); }}>
            {writing ? '正在处理…' : pending === null ? '确认操作' : '重试同一请求'}
          </button>
        </form>
      </div>
    </section>
  </div>;
}

function errorMessage(value: unknown, fallback: string): string {
  if (!(value instanceof ErpApiError)) return fallback;
  return `${value.message}${value.traceId === null ? '' : `（追踪标识：${value.traceId}）`}`;
}
