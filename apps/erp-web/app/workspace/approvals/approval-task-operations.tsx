'use client';

import { NodeIndexOutlined, UserAddOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { useState } from 'react';

import { createIdempotencyKey, ErpApiError, erpFetch, strongEtag } from '../../lib/api-client';
import { parseApprovalSummaries, type ApprovalSummary } from '../../lib/approval-contract';

interface ApprovalTaskOperationsProps {
  readonly instance: ApprovalSummary;
  readonly actorId: string;
  readonly scopes: readonly string[];
  readonly onCompleted: (instance: ApprovalSummary) => Promise<void> | void;
}

type TaskOperation = 'transfer' | 'add_signer';

interface PendingOperation {
  readonly operation: TaskOperation;
  readonly targetActorId: string;
  readonly key: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** R1 审批任务转交与加签；R2 不渲染任何普通页面写入口。 */
export function ApprovalTaskOperations({
  instance,
  actorId,
  scopes,
  onCompleted,
}: ApprovalTaskOperationsProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [operation, setOperation] = useState<TaskOperation | null>(null);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [writing, setWriting] = useState(false);
  const canTransfer = scopes.includes('erp:approval:task:transfer');
  const canAddSigner = scopes.includes('erp:approval:task:add_signer');

  if (instance.riskLevel !== 'R1' || (!canTransfer && !canAddSigner)) return null;

  const show = (next: TaskOperation) => {
    form.resetFields();
    setPending(null);
    setOperation(next);
  };

  const finish = async (value: unknown) => {
    if (operation === null || pending !== null || writing) return;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const targetActorId = (value as Readonly<Record<string, unknown>>).targetActorId;
    if (typeof targetActorId !== 'string' || !ID_PATTERN.test(targetActorId) || targetActorId === actorId) {
      void message.error('请输入不同于当前主体的有效 ERP 主体标识');
      return;
    }
    const attempt = Object.freeze({
      operation,
      targetActorId,
      key: createIdempotencyKey(`approval-${operation.replace('_', '-')}`),
    });
    setPending(attempt);
    await execute(attempt);
  };

  const execute = async (attempt: PendingOperation) => {
    setWriting(true);
    try {
      const transfer = attempt.operation === 'transfer';
      const result = await erpFetch<unknown>(
        `/api/approvals/instances/${encodeURIComponent(instance.id)}/${transfer ? 'transfers' : 'add-signers'}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'if-match': strongEtag(instance.version),
            'idempotency-key': attempt.key,
          },
          body: JSON.stringify(transfer
            ? { fromApproverId: actorId, toApproverId: attempt.targetActorId }
            : { approverId: attempt.targetActorId }),
        },
      );
      const updated = parseInstanceResponse(result.data);
      void message.success(transfer ? '审批任务已转交' : '审批人已加入当前会签');
      setPending(null);
      setOperation(null);
      form.resetFields();
      try {
        await onCompleted(updated);
      } catch {
        void message.warning('操作已完成，但列表刷新失败；请手动刷新');
      }
    } catch (value) {
      if (isDefinitiveClientRejection(value)) setPending(null);
      void message.error(errorMessage(value, '操作结果未知；请复用当前请求重试'));
    } finally {
      setWriting(false);
    }
  };

  return <>
    <Space>
      {canTransfer ? <Button icon={<NodeIndexOutlined />} onClick={() => show('transfer')}>转交</Button> : null}
      {canAddSigner ? <Button icon={<UserAddOutlined />} onClick={() => show('add_signer')}>加签</Button> : null}
    </Space>
    <Modal
      title={operation === 'transfer' ? '转交审批任务' : '当前会签节点加签'}
      open={operation !== null}
      okText={pending === null ? '确认' : '重试同一请求'}
      confirmLoading={writing}
      onOk={() => {
        if (pending === null) form.submit();
        else void execute(pending);
      }}
      onCancel={() => setOperation(null)}
      destroyOnHidden={false}
    >
      <Space direction="vertical" size="middle" className="console-full-width">
        {pending === null ? null : <Alert
          type="warning"
          showIcon
          message="操作结果尚未确认"
          description="将复用同一正文、版本和幂等键重试，避免网络中断造成重复副作用。"
        />}
        <Typography.Paragraph type="secondary">
          {operation === 'transfer'
            ? '转交后当前主体将失去此待办；目标必须是同租户内有效 ERP 主体。'
            : '仅会签节点允许加签；目标必须是同租户内有效且尚未在当前节点的 ERP 主体。'}
        </Typography.Paragraph>
        <Form form={form} layout="vertical" disabled={pending !== null} onFinish={(value: unknown) => { void finish(value); }}>
          <Form.Item
            name="targetActorId"
            label={operation === 'transfer' ? '转交目标主体' : '加签主体'}
            rules={[
              { required: true, message: '请输入目标 ERP 主体标识' },
              { pattern: ID_PATTERN, message: '目标主体标识不符合白名单' },
            ]}
          >
            <Input maxLength={128} autoComplete="off" />
          </Form.Item>
        </Form>
      </Space>
    </Modal>
  </>;
}

function parseInstanceResponse(value: unknown): ApprovalSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, 'instance')) {
    throw new Error('APPROVAL_TASK_RESPONSE_INVALID');
  }
  const instance = parseApprovalSummaries([(value as Readonly<Record<string, unknown>>).instance])[0];
  if (instance === undefined) throw new Error('APPROVAL_TASK_RESPONSE_INVALID');
  return instance;
}

function errorMessage(value: unknown, fallback: string): string {
  if (!(value instanceof ErpApiError)) return fallback;
  return `${value.message}${value.traceId === null ? '' : `（追踪标识：${value.traceId}）`}`;
}

function isDefinitiveClientRejection(value: unknown): boolean {
  return value instanceof ErpApiError && value.status >= 400 && value.status < 500 &&
    ![408, 409, 429].includes(value.status);
}
