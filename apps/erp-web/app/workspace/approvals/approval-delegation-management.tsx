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

import { createIdempotencyKey, ErpApiError, erpFetch, isDefinitiveWriteRejection, strongEtag } from '../../lib/api-client';
import { parseApprovalDelegations, type ApprovalDelegationView } from '../../lib/approval-contract';
import { buildApprovalDelegationCreateInput } from '../../lib/approval-task-contract';

interface ApprovalDelegationManagementProps {
  readonly actorId: string;
  readonly scopes: readonly string[];
}

interface PendingCreate {
  readonly body: { readonly delegateId: string; readonly validFrom: string; readonly validUntil: string };
  readonly actorId: string;
  readonly key: string;
}

interface PendingRevoke {
  readonly item: ApprovalDelegationView;
  readonly actorId: string;
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
  const [pendingRevoke, setPendingRevoke] = useState<PendingRevoke | null>(null);
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
    if (pendingCreate !== null || pendingRevoke !== null || writing || !canWrite) return;
    let body: PendingCreate['body'];
    try {
      body = buildApprovalDelegationCreateInput(value, actorId);
    } catch {
      void message.error('委托主体或有效期无效');
      return;
    }
    const attempt = Object.freeze({
      body,
      actorId,
      key: createIdempotencyKey('approval-delegation-create'),
    });
    setPendingCreate(attempt);
    await create(attempt);
  };

  const create = async (attempt: PendingCreate) => {
    if (attempt.actorId !== actorId) {
      setPendingCreate(null);
      void message.error('登录主体已变化，请重新创建委托');
      return;
    }
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
      if (isDefinitiveWriteRejection(value)) setPendingCreate(null);
      void message.error(errorMessage(value, '创建结果未知；请复用当前请求重试'));
    } finally {
      setWriting(false);
    }
  };

  const confirmRevoke = (item: ApprovalDelegationView) => {
    if (pendingCreate !== null || pendingRevoke !== null || writing) return;
    modal.confirm({
      title: '确认撤销审批委托？',
      content: `撤销后 ${item.delegateId} 将不能再以你的名义处理新动作。`,
      okText: '撤销',
      okButtonProps: { danger: true },
      onOk: async () => {
        const attempt = Object.freeze({
          item,
          actorId,
          key: createIdempotencyKey('approval-delegation-revoke'),
        });
        setPendingRevoke(attempt);
        await revoke(attempt);
      },
    });
  };

  const revoke = async (attempt: PendingRevoke) => {
    if (attempt.actorId !== actorId) {
      setPendingRevoke(null);
      void message.error('登录主体已变化，请重新选择要撤销的委托');
      return;
    }
    setWriting(true);
    try {
      await erpFetch<unknown>(`/api/approvals/delegations/${encodeURIComponent(attempt.item.id)}/revoke`, {
        method: 'POST',
        headers: {
          'if-match': strongEtag(attempt.item.version),
          'idempotency-key': attempt.key,
        },
      });
      setPendingRevoke(null);
      void message.success('审批委托已撤销');
      await load();
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPendingRevoke(null);
      void message.error(errorMessage(value, '撤销结果未知；请复用当前请求重试'));
    } finally {
      setWriting(false);
    }
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
        ? <Button
            danger
            type="link"
            icon={<StopOutlined />}
            disabled={writing || pendingCreate !== null || (pendingRevoke !== null && pendingRevoke.item.id !== item.id)}
            onClick={() => pendingRevoke?.item.id === item.id ? void revoke(pendingRevoke) : confirmRevoke(item)}
          >{pendingRevoke?.item.id === item.id ? '重试撤销' : '撤销'}</Button>
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
          disabled={pendingCreate !== null || pendingRevoke !== null}
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
            <Button type="primary" loading={writing} disabled={pendingRevoke !== null} onClick={() => {
              if (pendingCreate === null) form.submit();
              else void create(pendingCreate);
            }}>{pendingCreate === null ? '创建委托' : '重试同一请求'}</Button>
          </Form.Item>
        </Form> : null}
        {pendingCreate === null ? null : <Alert type="warning" showIcon message="创建结果尚未确认，将复用同一正文与幂等键重试" />}
        {pendingRevoke === null ? null : <Alert type="warning" showIcon message={`委托 ${pendingRevoke.item.id} 的撤销结果尚未确认，将复用原版本与幂等键重试`} />}
        <Table rowKey="id" columns={columns} dataSource={[...items]} loading={loading} pagination={{ pageSize: 8 }} />
      </Space>
    </Modal>
  </>;
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
