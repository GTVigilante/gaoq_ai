'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { Locale } from '../lib/content';

const API_ORIGIN = process.env.NEXT_PUBLIC_ERP_API_ORIGIN ?? 'http://localhost:3001';
const CAPTCHA_WIDGET_URL = process.env.NEXT_PUBLIC_MARKETING_CAPTCHA_WIDGET_URL;

/** 双边预约表单；租户与站点始终由服务端固定映射。 */
export function LeadForm({ locale, audience }: {
  readonly locale: Locale;
  readonly audience: 'creator' | 'brand';
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [captchaToken, setCaptchaToken] = useState('');
  const zh = locale === 'zh-CN';

  useEffect(() => {
    if (CAPTCHA_WIDGET_URL === undefined) return;
    const expectedOrigin = new URL(CAPTCHA_WIDGET_URL).origin;
    const listener = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== expectedOrigin ||
        typeof event.data !== 'object' ||
        event.data === null ||
        !('captchaToken' in event.data) ||
        typeof event.data.captchaToken !== 'string'
      ) return;
      setCaptchaToken(event.data.captchaToken);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('sending');
    const form = new FormData(event.currentTarget);
    const response = await fetch(`${API_ORIGIN}/api/marketing/public/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audience,
        name: form.get('name'),
        contact: form.get('contact'),
        requestSummary: form.get('requestSummary'),
        privacyAccepted: form.get('privacyAccepted') === 'on',
        website: form.get('website'),
        captchaToken,
      }),
    }).catch(() => null);
    setState(response?.ok === true ? 'success' : 'error');
  }

  if (state === 'success') return (
    <div className="form-success" role="status">
      <strong>{zh ? '已收到你的需求' : 'Thank you — we have your enquiry.'}</strong>
      <p>{zh ? '顾问会尽快与你联系。' : 'A specialist will get back to you shortly.'}</p>
    </div>
  );
  return (
    <form className="lead-form" onSubmit={(event) => void submit(event)}>
      <label>{zh ? '称呼' : 'Name'}<input name="name" required maxLength={100} /></label>
      <label>{zh ? '联系方式' : 'Email or phone'}<input name="contact" required maxLength={254} /></label>
      <label className="form-wide">{zh ? '你希望解决什么问题？' : 'What would you like to achieve?'}
        <textarea name="requestSummary" required minLength={10} maxLength={2000} rows={5} />
      </label>
      <input className="honeypot" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
      <label className="form-wide checkbox">
        <input type="checkbox" name="privacyAccepted" required />
        {zh ? '我同意按照隐私政策处理本次咨询信息' : 'I agree to the processing described in the privacy policy'}
      </label>
      {CAPTCHA_WIDGET_URL === undefined ? (
        <p className="form-wide form-error">
          {zh ? '预约验证组件尚未配置。' : 'The enquiry verification widget is not configured.'}
        </p>
      ) : (
        <iframe
          className="captcha-frame"
          src={CAPTCHA_WIDGET_URL}
          title={zh ? '人机验证' : 'Human verification'}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      )}
      <button type="submit" disabled={state === 'sending' || captchaToken === ''}>
        {state === 'sending' ? (zh ? '正在提交…' : 'Sending…') : (zh ? '提交预约' : 'Send enquiry')}
      </button>
      {state === 'error' ? <p className="form-error">{zh ? '暂时无法提交，请稍后重试。' : 'Unable to send. Please try again.'}</p> : null}
    </form>
  );
}
