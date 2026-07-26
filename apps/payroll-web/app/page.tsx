import { Button, Card, Space, Tag, Typography } from 'antd';
import { cookies } from 'next/headers';

const { Title, Paragraph, Text } = Typography;

export default async function HomePage() {
  const authenticated = (await cookies()).has('payroll_access_token');
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '64px 24px' }}>
      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Tag color="blue">工资唯一事实源</Tag>
            <Tag color={authenticated ? 'green' : 'default'}>
              {authenticated ? 'GaoQ SSO 已连接' : '未登录'}
            </Tag>
          </div>
          <Title level={1}>GaoQ 专业算薪</Title>
          <Paragraph>
            统一使用 GaoQ ERP 的租户、身份、组织、员工和劳动关系主数据；
            算薪系统独立负责规则、计算、工资条、薪税与发放结果。
          </Paragraph>
          {authenticated ? (
            <>
              <Text type="secondary">短期访问令牌仅保存在服务端 HttpOnly Cookie。</Text>
              <form action="/api/auth/logout" method="post">
                <Button htmlType="submit">退出算薪工作台</Button>
              </form>
            </>
          ) : (
            <Button type="primary" href="/api/auth/login">
              使用 GaoQ ERP 登录
            </Button>
          )}
        </Space>
      </Card>
    </main>
  );
}
