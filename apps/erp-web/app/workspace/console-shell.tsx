'use client';

import {
  ApartmentOutlined,
  AuditOutlined,
  DashboardOutlined,
  FileTextOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MobileOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Badge, Button, Layout, Menu, Space, Typography } from 'antd';
import type { MenuProps } from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';

const { Header, Sider, Content } = Layout;

const NAVIGATION: NonNullable<MenuProps['items']> = [
  { key: '/workspace', icon: <DashboardOutlined />, label: <Link href="/workspace">工作台</Link> },
  { key: '/workspace/approvals', icon: <AuditOutlined />, label: <Link href="/workspace/approvals">审批中心</Link> },
  { key: '/workspace/forms', icon: <FileTextOutlined />, label: <Link href="/workspace/forms">表单设计</Link> },
  { key: '/workspace/org', icon: <ApartmentOutlined />, label: <Link href="/workspace/org">组织管理</Link> },
  { key: '/workspace/profile', icon: <UserOutlined />, label: <Link href="/workspace/profile">个人中心</Link> },
];

/** PC 应用壳只负责导航与状态呈现，不在浏览器推导权限。 */
export function ConsoleShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const selected = NAVIGATION.map((item) => String(item?.key))
    .filter((key) => pathname === key || (key !== '/workspace' && pathname.startsWith(`${key}/`)))
    .sort((left, right) => right.length - left.length)[0] ?? '/workspace';
  return (
    <Layout className="console-layout">
      <Sider
        width={236}
        collapsedWidth={72}
        collapsed={collapsed}
        className="console-sider"
        aria-label="ERP 主导航"
      >
        <Link className="console-brand" href="/workspace" aria-label="GaoQ-OS 工作台">
          <span className="console-brand-mark"><RobotOutlined /></span>
          {!collapsed ? <span><strong>GaoQ-OS</strong><small>企业运营系统</small></span> : null}
        </Link>
        <Menu theme="dark" mode="inline" selectedKeys={[selected]} items={NAVIGATION} />
        {!collapsed ? (
          <section className="console-trust-note" aria-label="安全边界">
            <SafetyCertificateOutlined />
            <div><strong>可信权限上下文</strong><span>租户、角色和数据范围由服务端令牌决定</span></div>
          </section>
        ) : null}
      </Sider>
      <Layout>
        <Header className="console-header">
          <Button
            type="text"
            aria-label={collapsed ? '展开导航' : '收起导航'}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed((value) => !value)}
          />
          <Space size="large">
            <Badge status="success" text="安全会话" />
            <Link href="/management/dashboard"><TeamOutlined /> 管理驾驶舱</Link>
            <Link href="/mobile"><MobileOutlined /> 移动端</Link>
          </Space>
        </Header>
        <Content className="console-content">
          <Typography.Text className="console-environment">生产职责由受保护发布流程控制</Typography.Text>
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
