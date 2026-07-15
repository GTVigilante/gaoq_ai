import { Card, Descriptions } from 'antd';

const Settings = () => {
  return (
    <Card title="系统设置">
      <Descriptions bordered column={1}>
        <Descriptions.Item label="系统名称">智能薪酬系统</Descriptions.Item>
        <Descriptions.Item label="版本">v1.0.0</Descriptions.Item>
        <Descriptions.Item label="构建日期">2026-01-15</Descriptions.Item>
        <Descriptions.Item label="技术支持">support@example.com</Descriptions.Item>
      </Descriptions>
    </Card>
  );
};

export default Settings;
