'use client';

import { useEffect, useState } from 'react';
import { getPasskeyAssertion } from '../../webauthn-client';

interface ConfirmationView {
  readonly operationId: string;
  readonly operation: 'approval.submit' | 'approval.withdraw' | 'approval.decide';
  readonly riskLevel: 'R1' | 'R2';
  readonly digest: string;
  readonly expiresAt: string;
  readonly status: string;
  readonly impact: Readonly<Record<string, string | number>>;
}

const API_ORIGIN = process.env.NEXT_PUBLIC_ERP_API_ORIGIN ?? 'http://localhost:3001';
const OPERATION_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const OPERATION_LABELS: Readonly<Record<ConfirmationView['operation'], string>> = {
  'approval.submit': '提交审批',
  'approval.withdraw': '撤回审批',
  'approval.decide': '形成审批决策',
};

/** 用户必须在 ERP 原生页面核对摘要；确认凭据只显示一次，不写入浏览器存储。 */
export function McpConfirmationClient({ operationId }: { readonly operationId: string }) {
  const [view, setView] = useState<ConfirmationView | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'submitting' | 'confirmed' | 'error'>('loading');
  const [message, setMessage] = useState('正在读取待确认操作…');

  useEffect(() => {
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      setStatus('error');
      setMessage('操作标识无效或已经过期。');
      return;
    }
    const controller = new AbortController();
    void fetch(`${API_ORIGIN}/api/mcp/confirmations/${encodeURIComponent(operationId)}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('unavailable');
      return response.json() as Promise<ConfirmationView>;
    }).then((result) => {
      setView(result);
      setStatus(result.status === 'pending_confirmation' ? 'ready' : 'error');
      setMessage(result.status === 'pending_confirmation'
        ? '请核对以下影响。确认不会立即替你执行，AI 仍需提交一次性凭据。'
        : '该操作已确认、执行或失效，不能再次确认。');
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setStatus('error');
      setMessage('登录已失效、操作不存在或已经过期。');
    });
    return () => controller.abort();
  }, [operationId]);

  const confirm = async (): Promise<void> => {
    if (status !== 'ready') return;
    setStatus('submitting');
    setMessage('正在创建一次性确认凭据…');
    try {
      if (view?.riskLevel === 'R2') {
        const optionsResponse = await fetch(
          `${API_ORIGIN}/api/mcp/confirmations/${encodeURIComponent(operationId)}/webauthn/options`,
          { method: 'POST', credentials: 'include', headers: { accept: 'application/json' } },
        );
        if (!optionsResponse.ok) throw new Error(optionsResponse.status === 404 ? 'passkey-required' : 'strong-auth');
        const ceremony = await optionsResponse.json() as {
          readonly ceremonyId: string;
          readonly options: Parameters<typeof getPasskeyAssertion>[0];
        };
        const assertion = await getPasskeyAssertion(ceremony.options);
        const verifyResponse = await fetch(
          `${API_ORIGIN}/api/mcp/confirmations/${encodeURIComponent(operationId)}/webauthn/verify`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ ceremonyId: ceremony.ceremonyId, response: assertion }),
          },
        );
        const verified = await verifyResponse.json() as { readonly confirmationCredential?: unknown };
        if (!verifyResponse.ok || typeof verified.confirmationCredential !== 'string') {
          throw new Error('strong-auth');
        }
        setCredential(verified.confirmationCredential);
        setStatus('confirmed');
        setMessage('强认证与确认均已完成。请复制一次性凭据交给当前 AI 客户端。');
        return;
      }
      const response = await fetch(
        `${API_ORIGIN}/api/mcp/confirmations/${encodeURIComponent(operationId)}/confirm`,
        { method: 'POST', credentials: 'include', headers: { accept: 'application/json' } },
      );
      const body = await response.json() as {
        readonly confirmationCredential?: unknown;
        readonly message?: unknown;
      };
      if (!response.ok || typeof body.confirmationCredential !== 'string') {
        throw new Error(response.status === 503 ? 'strong-auth' : 'confirmation-failed');
      }
      setCredential(body.confirmationCredential);
      setStatus('confirmed');
      setMessage('确认完成。请复制一次性凭据交给当前 AI 客户端；页面关闭后无法再次查看。');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error && error.message === 'passkey-required'
        ? '尚未登记 Passkey。请先在 ERP 安全设置中登记强认证凭据。'
        : error instanceof Error && error.message === 'strong-auth'
        ? 'R2 强认证失败或状态已变化；系统不会降级为普通确认。'
        : '确认失败或状态已变化，请返回 AI 客户端重新准备。');
    }
  };

  return (
    <main className="shell">
      <section className="consent-card" aria-labelledby="confirmation-title">
        <p className="eyebrow">GaoQ-OS · MCP 安全确认</p>
        <h1 id="confirmation-title">确认 AI 操作</h1>
        <p className="summary" role="status">{message}</p>
        {view === null ? null : (
          <>
            <dl className="consent-meta">
              <div><dt>操作</dt><dd>{OPERATION_LABELS[view.operation]}</dd></div>
              <div><dt>风险等级</dt><dd>{view.riskLevel}</dd></div>
              <div><dt>到期时间</dt><dd>{view.expiresAt}</dd></div>
              <div><dt>不可变摘要</dt><dd className="digest">{view.digest}</dd></div>
            </dl>
            <h2>操作影响</h2>
            <dl className="impact-list">
              {Object.entries(view.impact).map(([key, value]) => (
                <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>
              ))}
            </dl>
            {view.riskLevel === 'R2' ? (
              <p className="warning">R2 操作必须完成强认证与独立审批约束，系统禁止降级为普通确认。</p>
            ) : null}
          </>
        )}
        {credential === null ? null : (
          <div className="credential-box">
            <span>一次性确认凭据</span>
            <code>{credential}</code>
          </div>
        )}
        <div className="consent-actions">
          <button
            type="button"
            className="button primary"
            disabled={status !== 'ready'}
            onClick={() => { void confirm(); }}
          >
            确认此操作
          </button>
        </div>
      </section>
    </main>
  );
}
