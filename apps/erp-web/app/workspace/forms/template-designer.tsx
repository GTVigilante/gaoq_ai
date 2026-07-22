'use client';

import { DeleteOutlined, FileAddOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Divider,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';

import { createIdempotencyKey, ErpApiError, erpFetch, strongEtag } from '../../lib/api-client';

interface DraftResult {
  readonly template: { readonly id: string; readonly code: string; readonly revision: number; readonly status: string; readonly riskLevel: 'R1' | 'R2'; readonly definitionHash: string; readonly version: number };
}

interface DesignerValues {
  readonly code: string;
  readonly name: string;
  readonly riskLevel: 'R1' | 'R2';
  readonly fields: readonly { readonly key: string; readonly label: string; readonly type: string; readonly required?: boolean; readonly sensitivity: string; readonly maximumLength?: number }[];
  readonly nodes: readonly { readonly id: string; readonly name: string; readonly roleCodes: string; readonly approvalMode: 'all' | 'any' }[];
}

/** 版本化表单设计器；创建与发布分成两个独立职责面板。 */
export function TemplateDesigner() {
  const { message, modal } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [created, setCreated] = useState<DraftResult['template'] | null>(null);
  const [publishForm] = Form.useForm();

  const create = async (values: DesignerValues) => {
    setSaving(true);
    try {
      const definition = {
        fields: values.fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required ?? false,
          sensitivity: field.sensitivity,
          ...(field.maximumLength === undefined || field.type !== 'text' ? {} : { maximumLength: field.maximumLength }),
        })),
        nodes: values.nodes.map((node) => ({
          id: node.id,
          name: node.name,
          type: 'approval',
          approvalMode: node.approvalMode,
          resolver: { type: 'roles', roleCodes: node.roleCodes.split(',').map((item) => item.trim()).filter(Boolean), scope: 'tenant' },
        })),
      };
      const result = await erpFetch<DraftResult>('/api/approvals/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('approval-template-create') },
        body: JSON.stringify({ code: values.code, name: values.name, riskLevel: values.riskLevel, definition }),
      });
      setCreated(result.data.template);
      publishForm.setFieldsValue({ templateId: result.data.template.id, version: result.data.template.version });
      void message.success(`模板 ${result.data.template.code} 修订 ${result.data.template.revision} 已保存为草稿`);
    } catch (value) {
      showError(modal, value, '模板草稿保存失败');
    } finally {
      setSaving(false);
    }
  };

  const publish = async ({ templateId, version }: { readonly templateId: string; readonly version: number }) => {
    setPublishing(true);
    try {
      const result = await erpFetch<DraftResult>(`/api/approvals/templates/${encodeURIComponent(templateId)}/publish`, {
        method: 'POST',
        headers: { 'if-match': strongEtag(version), 'idempotency-key': createIdempotencyKey('approval-template-publish') },
      });
      setCreated(result.data.template);
      void message.success('模板已发布');
    } catch (value) {
      showError(modal, value, '模板发布失败；创建人与发布人必须职责分离');
    } finally {
      setPublishing(false);
    }
  };

  return <main aria-labelledby="forms-title">
    <div className="console-page-heading">
      <Typography.Text type="secondary"><FileAddOutlined /> Versioned Workflow Definition</Typography.Text>
      <Typography.Title id="forms-title" level={1}>表单与流程设计</Typography.Title>
      <Typography.Paragraph>字段类型、敏感级别和审批人解析器全部使用白名单；每次保存产生不可变修订。</Typography.Paragraph>
    </div>
    <Row gutter={[20, 20]}>
      <Col xs={24} xl={16}>
        <Card bordered={false} title="模板草稿">
          <Form<DesignerValues>
            layout="vertical"
            onFinish={(values) => { void create(values); }}
            initialValues={{ riskLevel: 'R1', fields: [{ type: 'text', required: true, sensitivity: 'L1', maximumLength: 200 }], nodes: [{ approvalMode: 'all', roleCodes: 'department_manager' }] }}
          >
            <Row gutter={16}>
              <Col xs={24} md={8}><Form.Item name="code" label="模板编码" rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, message: '编码不符合白名单' }]}><Input placeholder="expense_claim" /></Form.Item></Col>
              <Col xs={24} md={10}><Form.Item name="name" label="模板名称" rules={[{ required: true, max: 128 }]}><Input placeholder="费用报销" /></Form.Item></Col>
              <Col xs={24} md={6}><Form.Item name="riskLevel" label="风险等级" rules={[{ required: true }]}><Select options={[{ value: 'R1', label: 'R1 常规审批' }, { value: 'R2', label: 'R2 强认证' }]} /></Form.Item></Col>
            </Row>
            <Divider titlePlacement="start">字段定义</Divider>
            <Form.List name="fields" rules={[{ validator: (_, fields: unknown) => Array.isArray(fields) && fields.length > 0 ? Promise.resolve() : Promise.reject(new Error('至少需要一个字段')) }]}>
              {(fields, { add, remove }, { errors }) => <Space direction="vertical" className="console-full-width">
                {fields.map(({ key, name, ...rest }) => <Card key={key} size="small">
                  <Row gutter={12} align="middle">
                    <Col xs={24} md={5}><Form.Item {...rest} name={[name, 'key']} label="字段键" rules={[{ required: true }, { pattern: /^[A-Za-z][A-Za-z0-9_]{0,63}$/u }]}><Input /></Form.Item></Col>
                    <Col xs={24} md={5}><Form.Item {...rest} name={[name, 'label']} label="标签" rules={[{ required: true, max: 128 }]}><Input /></Form.Item></Col>
                    <Col xs={12} md={5}><Form.Item {...rest} name={[name, 'type']} label="类型" rules={[{ required: true }]}><Select options={['text', 'number', 'money_minor', 'boolean', 'date', 'employee', 'department', 'file_reference'].map((value) => ({ value, label: value }))} /></Form.Item></Col>
                    <Col xs={12} md={3}><Form.Item {...rest} name={[name, 'sensitivity']} label="敏感级别" rules={[{ required: true }]}><Select options={['L1', 'L2', 'L3', 'L4'].map((value) => ({ value, label: value }))} /></Form.Item></Col>
                    <Col xs={12} md={3}><Form.Item {...rest} name={[name, 'maximumLength']} label="文本上限"><InputNumber min={1} max={10000} /></Form.Item></Col>
                    <Col xs={8} md={2}><Form.Item {...rest} name={[name, 'required']} label="必填" valuePropName="checked"><Switch /></Form.Item></Col>
                    <Col xs={4} md={1}><Button danger type="text" aria-label="删除字段" icon={<DeleteOutlined />} onClick={() => remove(name)} /></Col>
                  </Row>
                </Card>)}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ type: 'text', required: false, sensitivity: 'L1', maximumLength: 200 })}>添加字段</Button>
                <Form.ErrorList errors={errors} />
              </Space>}
            </Form.List>
            <Divider titlePlacement="start">审批节点</Divider>
            <Form.List name="nodes" rules={[{ validator: (_, nodes: unknown) => Array.isArray(nodes) && nodes.length > 0 ? Promise.resolve() : Promise.reject(new Error('至少需要一个审批节点')) }]}>
              {(nodes, { add, remove }, { errors }) => <Space direction="vertical" className="console-full-width">
                {nodes.map(({ key, name, ...rest }) => <Card key={key} size="small">
                  <Row gutter={12} align="middle">
                    <Col xs={24} md={5}><Form.Item {...rest} name={[name, 'id']} label="节点编码" rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u }]}><Input placeholder="manager_review" /></Form.Item></Col>
                    <Col xs={24} md={5}><Form.Item {...rest} name={[name, 'name']} label="节点名称" rules={[{ required: true, max: 128 }]}><Input /></Form.Item></Col>
                    <Col xs={24} md={8}><Form.Item {...rest} name={[name, 'roleCodes']} label="审批角色（逗号分隔）" rules={[{ required: true }]}><Input placeholder="department_manager" /></Form.Item></Col>
                    <Col xs={18} md={4}><Form.Item {...rest} name={[name, 'approvalMode']} label="会签方式"><Select options={[{ value: 'all', label: '全部通过' }, { value: 'any', label: '任一通过' }]} /></Form.Item></Col>
                    <Col xs={6} md={2}><Button danger type="text" aria-label="删除节点" icon={<DeleteOutlined />} onClick={() => remove(name)} /></Col>
                  </Row>
                </Card>)}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ approvalMode: 'all', roleCodes: 'department_manager' })}>添加审批节点</Button>
                <Form.ErrorList errors={errors} />
              </Space>}
            </Form.List>
            <Flex justify="flex-end" className="console-form-actions"><Button type="primary" htmlType="submit" loading={saving}>保存新修订</Button></Flex>
          </Form>
        </Card>
      </Col>
      <Col xs={24} xl={8}>
        <Card bordered={false} title={<Space><SafetyCertificateOutlined />独立发布复核</Space>}>
          <Alert type="warning" showIcon message="职责分离（SoD）" description="创建者不能发布自己的草稿。请由拥有发布权限的独立复核人登录后核验定义哈希并执行发布。" />
          {created === null ? null : <Card size="small" className="console-result-card">
            <Space direction="vertical"><Tag color={created.status === 'published' ? 'green' : 'blue'}>{created.status}</Tag><Typography.Text strong>{created.code} / 修订 {created.revision}</Typography.Text><Typography.Text code copyable>{created.definitionHash}</Typography.Text></Space>
          </Card>}
          <Form form={publishForm} layout="vertical" onFinish={(values: unknown) => {
            if (isPublishValues(values)) void publish(values);
          }} className="console-publish-form">
            <Form.Item name="templateId" label="模板 ULID" rules={[{ required: true }, { pattern: /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u }]}><Input /></Form.Item>
            <Form.Item name="version" label="当前版本" rules={[{ required: true, type: 'number', min: 1 }]}><InputNumber min={1} precision={0} className="console-full-width" /></Form.Item>
            <Button type="primary" htmlType="submit" block loading={publishing}>复核并发布</Button>
          </Form>
        </Card>
      </Col>
    </Row>
  </main>;
}

function showError(modal: ReturnType<typeof AntApp.useApp>['modal'], value: unknown, fallback: string): void {
  const error = value instanceof ErpApiError ? value : null;
  modal.error({ title: fallback, content: `${error?.message ?? fallback}${error?.traceId === null || error === null ? '' : `\n追踪标识：${error.traceId}`}` });
}

function isPublishValues(value: unknown): value is { readonly templateId: string; readonly version: number } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.templateId === 'string' && typeof record.version === 'number';
}
