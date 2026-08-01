'use client';

import { KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Col, Descriptions, Flex, Row, Space, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { clearBrowserSession, ErpApiError, erpFetch, getBrowserSession } from '../../lib/api-client';

interface IdentityProfile {
  readonly actorId: string;
  readonly actorType: 'user' | 'service' | 'mcp_client' | 'system_job';
  readonly roleCodes: readonly string[];
  readonly scopes: readonly string[];
  readonly departmentIds: readonly string[];
}

interface SessionSummary { readonly scopes: readonly string[]; readonly expiresAt: number }

/** 个人安全中心只呈现已验证授权快照，不暴露租户标识或令牌内容。 */
export function ProfileConsole() {
  const { message, modal } = AntApp.useApp();
  const router = useRouter();
  const [profile, setProfile] = useState<IdentityProfile | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<{ readonly message: string; readonly traceId: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [identity, browser] = await Promise.all([erpFetch<IdentityProfile>('/api/auth/profile'), getBrowserSession()]);
      setProfile(identity.data);
      setSession(browser);
      setError(null);
    } catch (value) {
      const apiError = value instanceof ErpApiError ? value : null;
      setError({ message: apiError?.message ?? '身份摘要加载失败', traceId: apiError?.traceId ?? null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async () => {
    setRevoking(true);
    try {
      await erpFetch<{ readonly revoked: boolean }>('/api/auth/sessions/current/revoke', { method: 'POST' });
      clearBrowserSession();
      void message.success('当前会话已吊销');
      router.replace('/login');
    } catch (value) {
      const apiError = value instanceof ErpApiError ? value : null;
      modal.error({ title: '会话吊销失败', content: `${apiError?.message ?? '请稍后重试'}${apiError?.traceId === null || apiError === null ? '' : `\n追踪标识：${apiError.traceId}`}` });
    } finally {
      setRevoking(false);
    }
  };

  return <main aria-labelledby="profile-title">
    <Flex className="console-page-heading" justify="space-between" align="flex-end" gap={20} wrap>
      <div><Typography.Text type="secondary"><SafetyCertificateOutlined /> Zero Trust Identity</Typography.Text><Typography.Title id="profile-title" level={1}>个人与安全中心</Typography.Title><Typography.Paragraph>以下内容来自当前已验签访问令牌；浏览器不会持久化令牌或租户上下文。</Typography.Paragraph></div>
      <Button danger icon={<LogoutOutlined />} loading={revoking} onClick={() => {
        modal.confirm({ title: '吊销当前会话？', content: '当前设备将立即退出，HttpOnly 刷新凭据同时失效。', okText: '吊销并退出', okButtonProps: { danger: true }, onOk: revoke });
      }}>安全退出</Button>
    </Flex>
    {error === null ? null : <Alert className="console-alert" type="error" showIcon message={error.message} description={error.traceId === null ? '请重新登录。' : `追踪标识：${error.traceId}`} />}
    <Row gutter={[18, 18]}>
      <Col xs={24} xl={15}><Card bordered={false} title={<Space><UserOutlined />身份快照</Space>} loading={loading}>
        {profile === null ? null : <Descriptions column={1} bordered items={[
          { key: 'actor', label: '主体标识', children: <Typography.Text code copyable>{profile.actorId}</Typography.Text> },
          { key: 'type', label: '主体类型', children: profile.actorType },
          { key: 'roles', label: '角色', children: <TagList values={profile.roleCodes} empty="未分配角色" /> },
          { key: 'departments', label: '数据范围部门', children: <TagList values={profile.departmentIds} empty="无部门范围" /> },
          { key: 'expiry', label: '访问会话到期', children: session === null ? '—' : new Date(session.expiresAt).toLocaleString('zh-CN') },
        ]} />}
      </Card></Col>
      <Col xs={24} xl={9}><Card bordered={false} title={<Space><KeyOutlined />强认证</Space>} loading={loading}>
        <Alert type="info" showIcon message="Passkey / WebAuthn" description="R2 工资、付款、电子签等高风险操作需要独立挑战、摘要绑定与防重放验证。" />
        <Link href="/security/passkeys"><Button type="primary" block size="large" className="console-security-action">管理本设备 Passkey</Button></Link>
      </Card></Col>
      <Col span={24}><Card bordered={false} title="授权 Scope" loading={loading}><Flex gap={8} wrap>{profile?.scopes.length === 0 ? <Typography.Text type="secondary">当前会话没有业务 Scope</Typography.Text> : profile?.scopes.map((scope) => <Tag key={scope} color="blue">{scope}</Tag>)}</Flex></Card></Col>
    </Row>
  </main>;
}

function TagList({ values, empty }: { readonly values: readonly string[]; readonly empty: string }) {
  if (values.length === 0) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return <Flex gap={6} wrap>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Flex>;
}
