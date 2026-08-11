'use client';

import { CheckCircleOutlined, DingdingOutlined, LoadingOutlined } from '@ant-design/icons';
import { Button, Card, Result, Typography } from 'antd';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { ErpApiError, erpPublicFetch } from '../../../lib/api-client';
import { parseSsoCallbackInput, parseSsoCompletion } from '../../../lib/sso-browser-contract';

type CallbackState =
  | { readonly kind: 'verifying' }
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed'; readonly message: string; readonly traceId: string | null };

/** 完成一次性身份平台回调；Refresh Token 仅由 API 写入 HttpOnly Cookie。 */
export function SsoCallbackClient() {
  const params = useParams<{ provider: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<CallbackState>({ kind: 'verifying' });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const complete = async () => {
      try {
        const input = parseSsoCallbackInput(params.provider, new URLSearchParams(search.toString()));
        const result = await erpPublicFetch<unknown>(`/api/auth/sso/${input.provider}/callback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: input.state, code: input.code }),
        });
        const completion = parseSsoCompletion(result.data);
        setState({ kind: 'succeeded' });
        router.replace(completion.returnPath);
      } catch (value) {
        const error = value instanceof ErpApiError ? value : null;
        setState({
          kind: 'failed',
          message: error?.message ?? '登录回调无效或已过期，请重新扫码',
          traceId: error?.traceId ?? null,
        });
      }
    };
    void complete();
  }, [params.provider, router, search]);

  return <main className="sso-callback-shell" aria-live="polite">
    <Card bordered={false} className="sso-callback-card">
      {state.kind === 'failed' ? <Result
        status="error"
        title="未能完成登录"
        subTitle={state.traceId === null ? state.message : `${state.message}（追踪标识：${state.traceId}）`}
        extra={<Button type="primary" href="/login">返回重新扫码</Button>}
      /> : <Result
        icon={state.kind === 'verifying'
          ? <LoadingOutlined spin />
          : <CheckCircleOutlined className="sso-callback-success" />}
        title={state.kind === 'verifying' ? '正在验证钉钉企业身份' : '身份验证成功'}
        subTitle={state.kind === 'verifying'
          ? '请保持页面打开，系统正在核对企业、员工绑定与一次性登录状态。'
          : '正在进入 GaoQ-OS 工作台…'}
      />}
      <Typography.Text type="secondary" className="sso-callback-footnote">
        <DingdingOutlined /> GaoQ-OS 不会保存钉钉访问令牌或扫码内容
      </Typography.Text>
    </Card>
  </main>;
}
