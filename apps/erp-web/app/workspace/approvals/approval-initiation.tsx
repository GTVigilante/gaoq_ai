'use client';

import { PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';

import { createIdempotencyKey, ErpApiError, erpFetch, isDefinitiveWriteRejection, strongEtag } from '../../lib/api-client';
import {
  buildApprovalCreateInput,
  parseCreatedApprovalInstance,
  type ApprovalCreateInput,
} from '../../lib/approval-initiation-contract';
import {
  parsePublishedTemplateForms,
  type ApprovalFormFieldView,
  type ApprovalPublishedTemplateForm,
  type ApprovalSummary,
} from '../../lib/approval-contract';

interface ApprovalInitiationProps {
  readonly onSubmitted: () => Promise<void> | void;
}

interface PendingDraft {
  readonly instance: ApprovalSummary;
  readonly submitKey: string;
}

interface PendingCreate {
  readonly input: ApprovalCreateInput;
  readonly createKey: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** 使用已发布模板发起审批；创建成功但提交失败时保留草稿并复用提交幂等键。 */
export function ApprovalInitiation({ onSubmitted }: ApprovalInitiationProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [templates, setTemplates] = useState<readonly ApprovalPublishedTemplateForm[]>([]);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const selectedCode = Form.useWatch('templateCode', form) as unknown;
  const selected = useMemo(
    () => typeof selectedCode === 'string' ? templates.find((item) => item.code === selectedCode) ?? null : null,
    [selectedCode, templates],
  );

  const show = async () => {
    setOpen(true);
    if (templates.length > 0) return;
    setLoading(true);
    try {
      const result = await erpFetch<unknown>('/api/approvals/templates/published');
      setTemplates(parsePublishedTemplateForms(result.data));
    } catch (value) {
      void message.error(errorMessage(value, '可发起模板加载失败'));
    } finally {
      setLoading(false);
    }
  };

  const finish = async (values: unknown) => {
    if (pendingCreate !== null || pendingDraft !== null || writing) return;
    let input: ApprovalCreateInput;
    try {
      input = buildApprovalCreateInput(values, selected);
    } catch {
      void message.error('审批表单包含无效字段，请检查后重试');
      return;
    }
    const attempt = Object.freeze({
      input,
      createKey: createIdempotencyKey('approval-instance-create'),
    });
    setPendingCreate(attempt);
    await create(attempt);
  };

  const create = async (attempt: PendingCreate) => {
    setWriting(true);
    try {
      const created = await erpFetch<unknown>('/api/approvals/instances', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': attempt.createKey,
        },
        body: JSON.stringify(attempt.input),
      });
      const draft: PendingDraft = Object.freeze({
        instance: parseCreatedApprovalInstance(created.data),
        submitKey: createIdempotencyKey('approval-instance-submit'),
      });
      setPendingCreate(null);
      setPendingDraft(draft);
      await submit(draft).catch(() => undefined);
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPendingCreate(null);
      void message.error(errorMessage(value, '草稿创建结果未知；请复用当前请求重试'));
    } finally {
      setWriting(false);
    }
  };

  const submit = async (draft: PendingDraft) => {
    try {
      await erpFetch<unknown>(`/api/approvals/instances/${encodeURIComponent(draft.instance.id)}/submit`, {
        method: 'POST',
        headers: {
          'if-match': strongEtag(draft.instance.version),
          'idempotency-key': draft.submitKey,
        },
      });
      void message.success('审批已提交');
      setPendingCreate(null);
      setPendingDraft(null);
      setOpen(false);
      form.resetFields();
      try {
        await onSubmitted();
      } catch {
        void message.warning('审批已提交，但列表刷新失败；请手动刷新');
      }
    } catch (value) {
      void message.warning(errorMessage(value, '草稿已创建，但提交失败；请重试提交'));
      throw value;
    }
  };

  const retry = async () => {
    if (pendingDraft === null || writing) return;
    setWriting(true);
    try {
      await submit(pendingDraft);
    } catch {
      // submit 已向用户报告可恢复错误，草稿与幂等键继续保留。
    } finally {
      setWriting(false);
    }
  };

  return <>
    <Button type="primary" icon={<PlusOutlined />} onClick={() => { void show(); }}>发起审批</Button>
    <Modal
      title="发起审批"
      open={open}
      width={720}
      okText={pendingDraft !== null ? '重试提交' : pendingCreate !== null ? '重试创建' : '创建并提交'}
      confirmLoading={writing}
      okButtonProps={{ disabled: loading || (pendingCreate === null && pendingDraft === null && selected === null) }}
      onOk={() => {
        if (pendingDraft !== null) void retry();
        else if (pendingCreate !== null) void create(pendingCreate);
        else form.submit();
      }}
      onCancel={() => setOpen(false)}
      destroyOnHidden={false}
    >
      <Spin spinning={loading}>
        <Space direction="vertical" size="middle" className="console-full-width">
          {pendingCreate === null ? null : <Alert
            type="warning"
            showIcon
            message="草稿创建结果尚未确认"
            description="将复用同一请求正文和幂等键重试，避免网络中断导致重复草稿。"
          />}
          {pendingDraft === null ? null : <Alert
            type="warning"
            showIcon
            message="草稿已安全保留"
            description={<span>请勿重复创建；直接重试提交。草稿标识：<Typography.Text copyable code>{pendingDraft.instance.id}</Typography.Text></span>}
          />}
          {selected?.riskLevel === 'R2' ? <Alert
            type="warning"
            showIcon
            icon={<SafetyCertificateOutlined />}
            message="R2 高风险流程"
            description="可以发起和提交；后续审批决策必须进入 WebAuthn 强认证流程。"
          /> : null}
          <Form form={form} layout="vertical" disabled={pendingCreate !== null || pendingDraft !== null} onFinish={(values: unknown) => { void finish(values); }}>
            <Form.Item name="templateCode" label="审批模板" rules={[{ required: true, message: '请选择审批模板' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="选择已发布模板"
                options={templates.map((template) => ({
                  value: template.code,
                  label: `${template.name} · 修订 ${template.revision} · ${template.riskLevel}`,
                }))}
              />
            </Form.Item>
            <Form.Item name="title" label="审批标题" rules={[{ required: true, whitespace: true, max: 256, message: '请输入 1..256 个字符的标题' }]}>
              <Input maxLength={256} showCount placeholder="说明本次申请事项" />
            </Form.Item>
            {selected === null ? null : <>
              <Typography.Text type="secondary">
                表单结构校验值 <Typography.Text code>{selected.definitionHash.slice(0, 12)}</Typography.Text>
                {' '}<Tag color={selected.riskLevel === 'R2' ? 'red' : 'gold'}>{selected.riskLevel}</Tag>
              </Typography.Text>
              {selected.fields.map((field) => <TemplateField key={field.key} field={field} />)}
            </>}
          </Form>
        </Space>
      </Spin>
    </Modal>
  </>;
}

function TemplateField({ field }: { readonly field: ApprovalFormFieldView }) {
  const rules = [{ required: field.required, message: `请填写${field.label}` }];
  const name = ['formData', field.key];
  switch (field.type) {
    case 'boolean':
      return <Form.Item name={name} label={field.label} valuePropName="checked" initialValue={false} rules={rules}><Switch /></Form.Item>;
    case 'number':
      return <Form.Item name={name} label={field.label} rules={rules}><InputNumber className="console-full-width" /></Form.Item>;
    case 'money_minor':
      return <Form.Item name={name} label={field.label} rules={rules}><InputNumber className="console-full-width" precision={0} addonAfter="分" /></Form.Item>;
    case 'date':
      return <Form.Item name={name} label={field.label} rules={rules}><Input type="date" /></Form.Item>;
    case 'single_select':
      return <Form.Item name={name} label={field.label} rules={rules}><Select options={(field.options ?? []).map((item) => ({ value: item.key, label: item.label }))} /></Form.Item>;
    case 'multi_select':
      return <Form.Item name={name} label={field.label} rules={rules}><Select mode="multiple" maxCount={200} options={(field.options ?? []).map((item) => ({ value: item.key, label: item.label }))} /></Form.Item>;
    case 'employee':
    case 'department':
      return <Form.Item name={name} label={field.label} rules={[...rules, { pattern: ID_PATTERN, message: '请输入有效的 ERP 标识' }]}><Input maxLength={128} /></Form.Item>;
    case 'file_reference':
      return <Form.Item name={name} label={field.label} rules={rules} extra="最多 20 个文件标识，使用英文逗号分隔"><Input /></Form.Item>;
    case 'text':
      return <Form.Item name={name} label={field.label} rules={rules}><Input.TextArea maxLength={field.maximumLength ?? 10_000} showCount autoSize={{ minRows: 2, maxRows: 8 }} /></Form.Item>;
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (!(value instanceof ErpApiError)) return fallback;
  return `${value.message}${value.traceId === null ? '' : `（追踪标识：${value.traceId}）`}`;
}
