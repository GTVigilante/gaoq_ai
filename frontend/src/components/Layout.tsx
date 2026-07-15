import { useState } from 'react';
import { Layout as AntLayout, Menu, Avatar, Dropdown, Breadcrumb, Button } from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  DashboardOutlined,
  TeamOutlined,
  ApartmentOutlined,
  WalletOutlined,
  FileTextOutlined,
  CalendarOutlined,
  InsuranceOutlined,
  CalculatorOutlined,
  SettingOutlined,
  BarChartOutlined,
  AuditOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { logout } from '@/services/auth';
import { message } from 'antd';

const { Sider, Header, Content, Footer } = AntLayout;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/employees', icon: <TeamOutlined />, label: '员工管理' },
  { key: '/departments', icon: <ApartmentOutlined />, label: '部门管理' },
  { key: '/pay-items', icon: <WalletOutlined />, label: '薪酬项目' },
  { key: '/pay-schemes', icon: <FileTextOutlined />, label: '薪酬方案' },
  { key: '/salary-records', icon: <FileTextOutlined />, label: '薪资记录' },
  { key: '/attendance', icon: <CalendarOutlined />, label: '考勤管理' },
  { key: '/si-policies', icon: <InsuranceOutlined />, label: '社保政策' },
  { key: '/tax-policies', icon: <CalculatorOutlined />, label: '个税政策' },
  { key: '/payroll', icon: <WalletOutlined />, label: '薪资计算' },
  { key: '/reports', icon: <BarChartOutlined />, label: '报表分析' },
  { key: '/audit-logs', icon: <AuditOutlined />, label: '审计日志' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
];

const Layout = () => {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, setUser } = useAuth();

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // ignore
    } finally {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setUser(null);
      message.success('已退出登录');
      navigate('/login');
    }
  };

  const breadcrumbMap: Record<string, string> = {
    '/': '仪表盘',
    '/employees': '员工列表',
    '/employees/import': '导入员工',
    '/departments': '部门管理',
    '/pay-items': '薪酬项目',
    '/pay-schemes': '薪酬方案',
    '/salary-records': '薪资记录',
    '/attendance': '考勤管理',
    '/si-policies': '社保政策',
    '/tax-policies': '个税政策',
    '/payroll': '薪资计算',
    '/reports': '报表分析',
    '/audit-logs': '审计日志',
    '/settings': '系统设置',
  };

  const path = location.pathname;
  const matched = Object.keys(breadcrumbMap).find((k) => path === k || path.startsWith(k + '/'));
  const breadcrumbLabel = matched ? breadcrumbMap[matched] : '';

  const selectedKeys = [matched || path];

  return (
    <AntLayout>
      <Sider trigger={null} collapsible collapsed={collapsed}>
        <div style={{ height: 32, margin: 16, background: 'rgba(255,255,255,0.2)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
          {!collapsed ? '智能薪酬系统' : '薪酬'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selectedKeys}
          items={menuItems.map((item) => ({
            key: item.key,
            icon: item.icon,
            label: <Link to={item.key}>{item.label}</Link>,
          }))}
        />
      </Sider>
      <AntLayout>
        <Header style={{ padding: '0 24px', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span>{user?.name || user?.username}</span>
            <Dropdown
              menu={{
                items: [
                  { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, onClick: handleLogout },
                ],
              }}
            >
              <Avatar style={{ cursor: 'pointer', backgroundColor: '#1890ff' }}>
                {(user?.name || user?.username || 'U').charAt(0).toUpperCase()}
              </Avatar>
            </Dropdown>
          </div>
        </Header>
        <Content>
          <Breadcrumb style={{ marginBottom: 16 }}>
            <Breadcrumb.Item>首页</Breadcrumb.Item>
            {breadcrumbLabel && <Breadcrumb.Item>{breadcrumbLabel}</Breadcrumb.Item>}
          </Breadcrumb>
          <Outlet />
        </Content>
        <Footer style={{ textAlign: 'center' }}>智能薪酬系统 © 2026</Footer>
      </AntLayout>
    </AntLayout>
  );
};

export default Layout;
