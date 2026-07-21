'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPasskey } from '../../webauthn-client';

const API_ORIGIN = process.env.NEXT_PUBLIC_ERP_API_ORIGIN ?? 'http://localhost:3001';

interface PasskeyView {
  readonly credentialId: string;
  readonly deviceType: 'singleDevice' | 'multiDevice';
  readonly backedUp: boolean;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** Passkey 登记页；私钥永远留在认证器内，浏览器只向 ERP 返回公钥证明。 */
export function PasskeyRegistrationClient() {
  const [status, setStatus] = useState<'ready' | 'submitting' | 'success' | 'error'>('ready');
  const [message, setMessage] = useState('登记后，R2 审批决策将要求设备解锁、指纹或 PIN。');
  const [passkeys, setPasskeys] = useState<readonly PasskeyView[]>([]);

  const loadPasskeys = useCallback(async (): Promise<void> => {
    const response = await fetch(`${API_ORIGIN}/api/auth/passkeys`, {
      credentials: 'include', headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error('list');
    const body = await response.json() as { readonly items?: unknown };
    if (!Array.isArray(body.items)) throw new Error('list');
    setPasskeys(body.items as readonly PasskeyView[]);
  }, []);

  useEffect(() => {
    void loadPasskeys().catch(() => {
      setStatus('error');
      setMessage('无法读取 Passkey，登录可能已失效或当前账号没有管理权限。');
    });
  }, [loadPasskeys]);

  const register = async (): Promise<void> => {
    if (status === 'submitting') return;
    setStatus('submitting');
    setMessage('正在启动设备强认证…');
    try {
      const optionsResponse = await fetch(`${API_ORIGIN}/api/auth/passkeys/registration/options`, {
        method: 'POST', credentials: 'include', headers: { accept: 'application/json' },
      });
      if (!optionsResponse.ok) throw new Error('options');
      const ceremony = await optionsResponse.json() as {
        readonly ceremonyId: string;
        readonly options: Parameters<typeof createPasskey>[0];
      };
      const credential = await createPasskey(ceremony.options);
      const verifyResponse = await fetch(`${API_ORIGIN}/api/auth/passkeys/registration/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ceremonyId: ceremony.ceremonyId, response: credential }),
      });
      if (!verifyResponse.ok) throw new Error('verify');
      await loadPasskeys();
      setStatus('success');
      setMessage('Passkey 已登记。现在可以确认 R2 操作。');
    } catch {
      setStatus('error');
      setMessage('登记失败、登录失效或当前账号没有登记权限。');
    }
  };

  const revoke = async (credentialId: string): Promise<void> => {
    setStatus('submitting');
    setMessage('正在撤销 Passkey…');
    try {
      const response = await fetch(
        `${API_ORIGIN}/api/auth/passkeys/${encodeURIComponent(credentialId)}`,
        { method: 'DELETE', credentials: 'include', headers: { accept: 'application/json' } },
      );
      if (!response.ok) throw new Error('revoke');
      await loadPasskeys();
      setStatus('ready');
      setMessage('Passkey 已撤销，后续断言将被拒绝。');
    } catch {
      setStatus('error');
      setMessage('撤销失败、登录失效或凭据已被撤销。');
    }
  };

  return (
    <main className="shell">
      <section className="consent-card" aria-labelledby="passkey-title">
        <p className="eyebrow">GaoQ-OS · 安全设置</p>
        <h1 id="passkey-title">登记 Passkey</h1>
        <p className="summary" role="status">{message}</p>
        <p className="notice">
          ERP 要求认证器执行用户验证。私钥不会上传；服务端只保存公钥、计数器和设备备份状态。
        </p>
        <h2>已登记凭据</h2>
        {passkeys.length === 0 ? <p className="notice">当前没有有效 Passkey。</p> : (
          <dl className="impact-list">
            {passkeys.map((passkey) => (
              <div key={passkey.credentialId}>
                <dt>{passkey.deviceType === 'multiDevice' ? '同步 Passkey' : '单设备 Passkey'}</dt>
                <dd>
                  <span>{new Date(passkey.createdAt).toLocaleString('zh-CN')}</span>{' '}
                  <button
                    type="button"
                    className="button"
                    disabled={status === 'submitting'}
                    onClick={() => { void revoke(passkey.credentialId); }}
                  >
                    撤销
                  </button>
                </dd>
              </div>
            ))}
          </dl>
        )}
        <div className="consent-actions">
          <button
            type="button"
            className="button primary"
            disabled={status === 'submitting'}
            onClick={() => { void register(); }}
          >
            登记此设备
          </button>
        </div>
      </section>
    </main>
  );
}
