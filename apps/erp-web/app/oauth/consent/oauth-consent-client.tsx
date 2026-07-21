'use client';

import { useEffect, useState } from 'react';

interface AuthorizationRequestView {
  readonly requestId: string;
  readonly clientName: string;
  readonly redirectOrigin: string;
  readonly scopes: readonly string[];
  readonly expiresIn: number;
}

const API_ORIGIN = process.env.NEXT_PUBLIC_ERP_API_ORIGIN ?? 'http://localhost:3001';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** MCP OAuth 用户同意组件；Cookie 只随 credentials 请求发送，前端代码不可读取。 */
export function OAuthConsentClient({ requestId }: { readonly requestId: string }) {
  const [authorization, setAuthorization] = useState<AuthorizationRequestView | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'submitting' | 'error'>('loading');
  const [message, setMessage] = useState('正在读取授权请求…');

  useEffect(() => {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      setStatus('error');
      setMessage('授权请求无效或已经过期。');
      return;
    }
    const controller = new AbortController();
    void fetch(`${API_ORIGIN}/api/auth/oauth/requests/${encodeURIComponent(requestId)}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('request unavailable');
      return response.json() as Promise<AuthorizationRequestView>;
    }).then((view) => {
      setAuthorization(view);
      setStatus('ready');
      setMessage('请确认此 AI 客户端可以访问的范围。');
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setStatus('error');
      setMessage('授权请求无效或已经过期。');
    });
    return () => controller.abort();
  }, [requestId]);

  const decide = async (approved: boolean): Promise<void> => {
    if (status !== 'ready') return;
    setStatus('submitting');
    setMessage(approved ? '正在确认授权…' : '正在拒绝授权…');
    try {
      const response = await fetch(
        `${API_ORIGIN}/api/auth/oauth/requests/${encodeURIComponent(requestId)}/decisions`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ approved }),
        },
      );
      if (response.status === 401) {
        throw new Error('session required');
      }
      if (!response.ok) throw new Error('decision failed');
      const result = await response.json() as { readonly redirect_to?: unknown };
      if (typeof result.redirect_to !== 'string') throw new Error('redirect missing');
      window.location.assign(result.redirect_to);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error && error.message === 'session required'
        ? 'ERP 登录已失效，请先重新登录后再发起连接。'
        : '授权处理失败，请返回 AI 客户端重新发起。');
    }
  };

  return (
    <main className="shell">
      <section className="consent-card" aria-labelledby="consent-title">
        <p className="eyebrow">GaoQ-OS · MCP OAuth</p>
        <h1 id="consent-title">授权 AI 客户端</h1>
        <p className="summary" role="status">{message}</p>
        {authorization === null ? null : (
          <>
            <dl className="consent-meta">
              <div><dt>客户端</dt><dd>{authorization.clientName}</dd></div>
              <div><dt>授权后返回</dt><dd>{authorization.redirectOrigin}</dd></div>
            </dl>
            <h2>请求的权限范围</h2>
            <ul className="scope-list">
              {authorization.scopes.map((scope) => <li key={scope}>{scope}</li>)}
            </ul>
            <p className="notice">客户端只能在你的 ERP 权限和数据范围内访问，不能获取更高权限。</p>
          </>
        )}
        <div className="consent-actions">
          <button type="button" className="button secondary" disabled={status !== 'ready'} onClick={() => { void decide(false); }}>
            拒绝
          </button>
          <button type="button" className="button primary" disabled={status !== 'ready'} onClick={() => { void decide(true); }}>
            同意连接
          </button>
        </div>
      </section>
    </main>
  );
}
