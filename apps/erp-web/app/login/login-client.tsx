'use client';

import { DingdingOutlined, LockOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Segmented, Space, Typography } from 'antd';
import { useState } from 'react';

import { ErpApiError, erpPublicFetch } from '../lib/api-client';

type Provider = 'dingtalk' | 'feishu' | 'op';

interface StartSsoResult { readonly authorizationUrl: string; readonly expiresIn: number }

/** 企业 SSO 登录；state、PKCE 与租户绑定全部由 API 生成。 */
export function LoginClient() {
  const [provider, setProvider] = useState<Provider>('dingtalk');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ readonly message: string; readonly traceId: string | null } | null>(null);

  const submit = async ({ tenantSlug }: { readonly tenantSlug: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await erpPublicFetch<StartSsoResult>(`/api/auth/sso/${provider}/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantSlug, returnPath: '/workspace' }),
      });
      const target = new URL(result.data.authorizationUrl);
      if (target.protocol !== 'https:') throw new Error('SSO_AUTHORIZATION_URL_INVALID');
      window.location.assign(target.toString());
    } catch (value) {
      const apiError = value instanceof ErpApiError ? value : null;
      setError({ message: apiError?.message ?? '无法发起 SSO 登录', traceId: apiError?.traceId ?? null });
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell" aria-busy={submitting}>
      <Card className="login-card" bordered={false}>
        <Space direction="vertical" size="large" className="login-content">
          <div>
            <Typography.Text className="eyebrow">GaoQ-OS · Identity</Typography.Text>
            <Typography.Title level={1}>登录企业运营系统</Typography.Title>
            <Typography.Paragraph>选择已登记的企业身份源。系统不会接收客户端租户 ID，也不会在浏览器持久化访问令牌。</Typography.Paragraph>
          </div>
          {error === null ? null : (
            <Alert
              role="alert"
              type="error"
              showIcon
              message={error.message}
              description={error.traceId === null ? '请联系管理员检查租户绑定。' : `追踪标识：${error.traceId}`}
            />
          )}
          <Segmented<Provider>
            block
            value={provider}
            onChange={setProvider}
            options={[
              { value: 'dingtalk', label: '钉钉' },
              { value: 'feishu', label: '飞书' },
              { value: 'op', label: 'OP' },
            ]}
          />
          <Form layout="vertical" onFinish={(values: unknown) => {
            if (isLoginValues(values)) void submit(values);
          }}>
            <Form.Item
              label="企业标识"
              name="tenantSlug"
              rules={[
                { required: true, message: '请输入企业标识' },
                { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, message: '仅允许小写字母、数字和连字符' },
              ]}
            >
              <Input prefix={<LockOutlined />} autoComplete="organization" maxLength={64} placeholder="例如 gaoq" />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={submitting} icon={<DingdingOutlined />}>
              {provider === 'dingtalk' ? '使用钉钉扫码登录' : '使用企业 SSO 登录'}
            </Button>
          </Form>
          <Typography.Text type="secondary">钉钉登录会打开官方扫码授权页；授权回调必须匹配一次性 state 与 HttpOnly 绑定 Cookie。</Typography.Text>
        </Space>
      </Card>
    </main>
  );
}

function isLoginValues(value: unknown): value is { readonly tenantSlug: string } {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).tenantSlug === 'string';
}
