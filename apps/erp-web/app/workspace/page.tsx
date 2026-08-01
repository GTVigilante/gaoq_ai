'use client';

import {
  ApartmentOutlined,
  AuditOutlined,
  FileTextOutlined,
  GlobalOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SolutionOutlined,
} from '@ant-design/icons';
import { Card, Col, Row, Space, Tag, Typography } from 'antd';
import Link from 'next/link';

const { Title, Paragraph, Text } = Typography;

const modules = [
  {
    href: '/workspace/marketing', icon: <GlobalOutlined />, title: '官网 CMS',
    description: '管理中英文营销内容、版本审核与官网发布，AI 生成内容必须人工确认。',
    tag: 'Marketing',
  },
  {
    href: '/workspace/recruitment', icon: <SolutionOutlined />, title: '智能简历库',
    description: 'AI 读取脱敏简历，生成结构化履历和受控标签；招聘人员确认后进入人才检索。',
    tag: 'Recruitment',
  },
  {
    href: '/workspace/approvals', icon: <AuditOutlined />, title: '审批中心',
    description: '查看服务端裁剪的待办与表单详情，按版本形成幂等审批决策。',
    tag: 'Phase 2',
  },
  {
    href: '/workspace/forms', icon: <FileTextOutlined />, title: '表单与流程',
    description: '创建版本化字段与审批节点，发布动作执行职责分离。',
    tag: '治理',
  },
  {
    href: '/workspace/org', icon: <ApartmentOutlined />, title: '组织主数据',
    description: 'ERP 是部门与员工唯一主数据源；外部平台只接收版本化下发。',
    tag: 'Phase 1',
  },
  {
    href: '/workspace/profile', icon: <SafetyCertificateOutlined />, title: '身份与安全',
    description: '查看已验证授权快照、管理 Passkey，并吊销当前会话。',
    tag: '零信任',
  },
] as const;

export default function WorkspacePage() {
  return (
    <main aria-labelledby="workspace-title">
      <div className="console-page-heading">
        <Space direction="vertical" size={4}>
          <Text type="secondary"><RobotOutlined /> GaoQ-OS / Workspace</Text>
          <Title id="workspace-title" level={1}>企业运营工作台</Title>
          <Paragraph>统一处理组织、审批和身份安全。页面不接受租户参数，也不持久化访问令牌或业务敏感数据。</Paragraph>
        </Space>
      </div>
      <Row gutter={[18, 18]}>
        {modules.map((module) => (
          <Col key={module.href} xs={24} md={12} xl={6}>
            <Link href={module.href} className="console-module-link">
              <Card className="console-module-card" bordered={false}>
                <Space direction="vertical" size="middle">
                  <span className="console-module-icon">{module.icon}</span>
                  <Space><Title level={3}>{module.title}</Title><Tag color="blue">{module.tag}</Tag></Space>
                  <Paragraph>{module.description}</Paragraph>
                  <Text strong>进入模块 →</Text>
                </Space>
              </Card>
            </Link>
          </Col>
        ))}
      </Row>
    </main>
  );
}
