'use client';

import { CalendarOutlined, StopOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { createIdempotencyKey, ErpApiError, erpFetch, strongEtag } from '../../lib/api-client';
import { parseApprovalDelegations, type ApprovalDelegationView } from '../../lib/approval-contract';

interface ApprovalDelegationManagementProps {
  readonly actorId: string;
  readonly scopes: readonly string[];
}

interface PendingCreate {
  readonly body: { readonly delegateId: string; readonly validFrom: string; readonly validUntil: string };
  readonly key: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** 本人审批委托管理；授权写入只在 ERP UI 执行，不提供 AI 写 Tool。 */
export function ApprovalDelegationManagement({ actorId, scopes }: ApprovalDelegationManagementProps) {
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<readonly ApprovalDelegationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const canRead = scopes.includes('erp:approval:delegation:read');
  const canWrite = scopes.includes('erp:approval:delegation:write');

  if (!canRead) return null;

  const load = async () => {
    setLoading(true);
    try {
      const result = await erpFetch<unknown>('/api/approvals/delegations/mine');
      setItems(parseApprovalDelegations(result.data));
    } catch (value) {
      void message.error(errorMessage(value, '审批委托加载失败'));
    } finally {
      setLoading(false);
    }
  };

  const show = () => {
    setOpen(true);
    form.setFieldsValue(defaultPeriod());
    void load();
  };

  const finish = async (value: unknown) => {
    if (pendingCreate !== null || writing || !canWrite) return;
    const body = parseCreateInput(value, actorId);
    if (body === null) {
      void message.error('委托主体或有效期无效');
      return;
    }
    const attempt = Object.freeze({
      body,
      key: createIdempotencyKey('approval-delegation-create'),
    });
    setPendingCreate(attempt);
    await create(attempt);
  };

  const create = async (attempt: PendingCreate) => {
    setWriting(true);
    try {
      await erpFetch<unknown>('/api/approvals/delegations', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': attempt.key,
        },
        body: JSON.stringify(attempt.body),
      });
      setPendingCreate(null);
      form.resetFields();
      form.setFieldsValue(defaultPeriod());
      void message.success('审批委托已创建');
      await load();
    } catch (value) {
      if (isDefinitiveClientRejection(value)) setPendingCreate(null);
      void message.error(errorMessage(value, '创建结果未知；请复用当前请求重试'));
    } finally {
      setWriting(false);
    }
  };

  const confirmRevoke = (item: ApprovalDelegationView) => {
    const key = createIdempotencyKey('approval-delegation-revoke');
    modal.confirm({
      title: '确认撤销审批委托？',
      content: `撤销后 ${item.delegateId} 将不能再以你的名义处理新动作。`,
      okText: '撤销',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await erpFetch<unknown>(`/api/approvals/delegations/${encodeURIComponent(item.id)}/revoke`, {
            method: 'POST',
            headers: {
              'if-match': strongEtag(item.version),
              'idempotency-key': key,
            },
          });
          void message.success('审批委托已撤销');
          await load();
        } catch (value) {
          void message.error(errorMessage(value, '撤销失败；请刷新后重试'));
          throw value;
        }
      },
    });
  };

  const columns: ColumnsType<ApprovalDelegationView> = [
    {
      title: '关系', key: 'relation',
      render: (_, item) => item.principalApproverId === actorId
        ? <span>我 → <Typography.Text strong>{item.delegateId}</Typography.Text></span>
        : <span><Typography.Text strong>{item.principalApproverId}</Typography.Text> → 我</span>,
    },
    {
      title: '有效期', key: 'period', width: 300,
      render: (_, item) => `${formatTime(item.validFrom)} — ${formatTime(item.validUntil)}`,
    },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (status: ApprovalDelegationView['status']) => <Tag color={status === 'active' ? 'green' : 'default'}>{status === 'active' ? '有效' : '已撤销'}</Tag>,
    },
    {
      title: '操作', key: 'action', width: 90,
      render: (_, item) => item.status === 'active' && item.principalApproverId === actorId && canWrite
        ? <Button danger type="link" icon={<StopOutlined />} onClick={() => confirmRevoke(item)}>撤销</Button>
        : '—',
    },
  ];

  return <>
    <Button icon={<CalendarOutlined />} onClick={show}>审批委托</Button>
    <Modal
      title="审批委托管理"
      open={open}
      width={900}
      footer={null}
      onCancel={() => setOpen(false)}
      destroyOnHidden={false}
    >
      <Space direction="vertical" size="large" className="console-full-width">
        <Alert
          type="info"
          showIcon
          message="限期授权边界"
          description="只能为本人创建最长 30 天且不重叠的委托；代理人必须是同租户有效 ERP 主体。AI 只可读取，不能授予或撤销权限。"
        />
        {canWrite ? <Form
          form={form}
          layout="inline"
          disabled={pendingCreate !== null}
          onFinish={(value: unknown) => { void finish(value); }}
        >
          <Form.Item name="delegateId" label="代理主体" rules={[{ required: true }, { pattern: ID_PATTERN }]}>
            <Input maxLength={128} autoComplete="off" placeholder="ERP 主体标识" />
          </Form.Item>
          <Form.Item name="validFrom" label="开始" rules={[{ required: true }]}>
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="validUntil" label="截止" rules={[{ required: true }]}>
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" loading={writing} onClick={() => {
              if (pendingCreate === null) form.submit();
              else void create(pendingCreate);
            }}>{pendingCreate === null ? '创建委托' : '重试同一请求'}</Button>
          </Form.Item>
        </Form> : null}
        {pendingCreate === null ? null : <Alert type="warning" showIcon message="创建结果尚未确认，将复用同一正文与幂等键重试" />}
        <Table rowKey="id" columns={columns} dataSource={[...items]} loading={loading} pagination={{ pageSize: 8 }} />
      </Space>
    </Modal>
  </>;
}

function parseCreateInput(
  value: unknown,
  actorId: string,
): PendingCreate['body'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.delegateId !== 'string' || !ID_PATTERN.test(record.delegateId) ||
    record.delegateId === actorId || typeof record.validFrom !== 'string' ||
    typeof record.validUntil !== 'string'
  ) return null;
  const validFrom = new Date(record.validFrom);
  const validUntil = new Date(record.validUntil);
  if (
    Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime()) ||
    validUntil.getTime() <= validFrom.getTime() ||
    validUntil.getTime() - validFrom.getTime() > 30 * 24 * 60 * 60 * 1_000
  ) return null;
  return Object.freeze({
    delegateId: record.delegateId,
    validFrom: validFrom.toISOString(),
    validUntil: validUntil.toISOString(),
  });
}

function defaultPeriod(): { readonly validFrom: string; readonly validUntil: string } {
  const start = new Date(Date.now() + 5 * 60 * 1_000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1_000);
  return { validFrom: localDateTime(start), validUntil: localDateTime(end) };
}

function localDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

function errorMessage(value: unknown, fallback: string): string {
  if (!(value instanceof ErpApiError)) return fallback;
  return `${value.message}${value.traceId === null ? '' : `（追踪标识：${value.traceId}）`}`;
}

function isDefinitiveClientRejection(value: unknown): boolean {
  return value instanceof ErpApiError && value.status >= 400 && value.status < 500 &&
    ![408, 409, 429].includes(value.status);
}
