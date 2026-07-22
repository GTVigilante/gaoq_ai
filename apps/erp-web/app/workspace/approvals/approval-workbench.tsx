'use client';

import { AuditOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Segmented,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createIdempotencyKey,
  ErpApiError,
  erpFetch,
  strongEtag,
} from '../../lib/api-client';
import {
  parseApprovalSummaries,
  parseApprovalTimeline,
  parseApprovalView,
  type ApprovalStatus,
  type ApprovalSummary,
  type ApprovalTimelineEntry,
  type ApprovalView,
} from '../../lib/approval-contract';

interface IdentityProfile {
  readonly actorId: string;
  readonly actorType: string;
  readonly roleCodes: readonly string[];
  readonly scopes: readonly string[];
  readonly departmentIds: readonly string[];
}

interface DecisionResult { readonly instance: ApprovalSummary }

const STATUS_TEXT: Readonly<Record<ApprovalStatus, string>> = {
  draft: '草稿', running: '审批中', approved: '已通过', rejected: '已拒绝',
  withdrawn: '已撤回', archived: '已归档',
};

/** 服务端裁剪待办的 PC 工作台；R2 决策必须转入带强认证的受控流程。 */
export function ApprovalWorkbench() {
  const { message, modal } = AntApp.useApp();
  const [items, setItems] = useState<readonly ApprovalSummary[]>([]);
  const [profile, setProfile] = useState<IdentityProfile | null>(null);
  const [selected, setSelected] = useState<ApprovalView | null>(null);
  const [timeline, setTimeline] = useState<readonly ApprovalTimelineEntry[]>([]);
  const [status, setStatus] = useState<'all' | ApprovalStatus>('all');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<{ readonly message: string; readonly traceId: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [inbox, identity] = await Promise.all([
        erpFetch<unknown>('/api/approvals/instances/inbox'),
        erpFetch<IdentityProfile>('/api/auth/profile'),
      ]);
      setItems(parseApprovalSummaries(inbox.data));
      setProfile(identity.data);
    } catch (value) {
      const apiError = value instanceof ErpApiError ? value : null;
      setError({ message: apiError?.message ?? '待办加载失败', traceId: apiError?.traceId ?? null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const open = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const [instance, actions] = await Promise.all([
        erpFetch<unknown>(`/api/approvals/instances/${encodeURIComponent(id)}`),
        erpFetch<unknown>(`/api/approvals/instances/${encodeURIComponent(id)}/timeline`),
      ]);
      setSelected(parseApprovalView(instance.data));
      setTimeline(parseApprovalTimeline(actions.data));
    } catch (value) {
      const apiError = value instanceof ErpApiError ? value : null;
      void message.error(apiError?.message ?? '审批详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  }, [message]);

  const decide = useCallback(async (outcome: 'approved' | 'rejected') => {
    if (selected === null || profile === null || writing) return;
    if (selected.riskLevel === 'R2') {
      modal.warning({
        title: '必须执行强认证',
        content: 'R2 审批禁止从普通页面直接提交。请进入受控确认流程并使用已登记 Passkey 完成 WebAuthn 验证。',
      });
      return;
    }
    setWriting(true);
    try {
      const result = await erpFetch<DecisionResult>(`/api/approvals/instances/${encodeURIComponent(selected.id)}/decisions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': strongEtag(selected.version),
          'idempotency-key': createIdempotencyKey('approval-decision'),
        },
        body: JSON.stringify({ principalApproverId: profile.actorId, outcome }),
      });
      void message.success(outcome === 'approved' ? '审批已通过' : '审批已拒绝');
      setSelected(null);
      setItems((current) => current.map((item) => item.id === result.data.instance.id ? result.data.instance : item));
      await load();
    } catch (value) {
      const apiError = value instanceof ErpApiError ? value : null;
      modal.error({
        title: '审批提交失败',
        content: `${apiError?.message ?? '请刷新后重试'}${apiError?.traceId === null || apiError === null ? '' : `\n追踪标识：${apiError.traceId}`}`,
      });
    } finally {
      setWriting(false);
    }
  }, [load, message, modal, profile, selected, writing]);

  const filtered = useMemo(
    () => status === 'all' ? items : items.filter((item) => item.status === status),
    [items, status],
  );

  const columns: ColumnsType<ApprovalSummary> = [
    {
      title: '流程', key: 'template',
      render: (_, item) => <Space direction="vertical" size={0}><Typography.Text strong>{item.templateCode}</Typography.Text><Typography.Text type="secondary">修订 {item.templateRevision}</Typography.Text></Space>,
    },
    { title: '风险', dataIndex: 'riskLevel', width: 96, render: (risk: 'R1' | 'R2') => <Tag color={risk === 'R2' ? 'red' : 'gold'}>{risk}</Tag> },
    { title: '状态', dataIndex: 'status', width: 120, render: (value: ApprovalStatus) => STATUS_TEXT[value] },
    { title: '版本', dataIndex: 'version', width: 90, render: (value: number) => `v${value}` },
    { title: '提交时间', dataIndex: 'submittedAt', width: 190, render: (value: string | null) => value === null ? '—' : new Date(value).toLocaleString('zh-CN') },
    { title: '操作', key: 'action', width: 100, render: (_, item) => <Button type="link" onClick={() => { void open(item.id); }}>查看</Button> },
  ];

  return (
    <main aria-labelledby="approval-title">
      <Flex className="console-page-heading" justify="space-between" align="flex-end" gap={20} wrap>
        <div>
          <Typography.Text type="secondary"><AuditOutlined /> Workflow Operations</Typography.Text>
          <Typography.Title id="approval-title" level={1}>审批中心</Typography.Title>
          <Typography.Paragraph>待办和字段均由服务端按部门数据范围裁剪；写操作使用强版本与幂等键。</Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => { void load(); }} loading={loading}>刷新</Button>
      </Flex>
      {error === null ? null : <Alert className="console-alert" type="error" showIcon message={error.message} description={error.traceId === null ? '请重新登录或联系管理员。' : `追踪标识：${error.traceId}`} />}
      <Card bordered={false}>
        <Flex justify="space-between" align="center" gap={16} wrap className="console-toolbar">
          <Segmented value={status} onChange={setStatus} options={[
            { value: 'all', label: `全部 ${items.length}` }, { value: 'running', label: '审批中' },
            { value: 'approved', label: '已通过' }, { value: 'rejected', label: '已拒绝' },
          ]} />
          <Typography.Text type="secondary">当前主体：{profile?.actorId ?? '验证中'}</Typography.Text>
        </Flex>
        <Table rowKey="id" columns={columns} dataSource={[...filtered]} loading={loading} pagination={{ pageSize: 10 }} locale={{ emptyText: <Empty description="当前范围内没有审批任务" /> }} scroll={{ x: 820 }} />
      </Card>
      <Drawer title="审批详情" width={620} open={selected !== null} loading={detailLoading} onClose={() => { setSelected(null); setTimeline([]); }} extra={selected === null ? null : <Tag color={selected.riskLevel === 'R2' ? 'red' : 'gold'}>{selected.riskLevel}</Tag>}>
        {selected === null ? null : <Space direction="vertical" size="large" className="console-full-width">
          {selected.riskLevel === 'R2' ? <Alert type="warning" showIcon icon={<SafetyCertificateOutlined />} message="R2 强认证边界" description="本工作台仅查看 R2 数据；决策必须进入 WebAuthn 受控确认流程。" /> : null}
          <Descriptions column={1} bordered size="small" items={[
            { key: 'title', label: '标题', children: selected.title },
            { key: 'id', label: '实例标识', children: <Typography.Text copyable code>{selected.id}</Typography.Text> },
            { key: 'initiator', label: '发起人', children: selected.initiatorId },
            { key: 'status', label: '状态', children: STATUS_TEXT[selected.status] },
            { key: 'node', label: '当前节点', children: selected.currentNodeIndex === null ? '—' : selected.currentNodeIndex + 1 },
            { key: 'version', label: '并发版本', children: `v${selected.version}` },
          ]} />
          <Card size="small" title="表单数据（已按敏感级别脱敏）">
            {Object.keys(selected.formData).length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无字段" /> : <Descriptions column={1} size="small" items={Object.entries(selected.formData).map(([key, value]) => ({ key, label: key, children: formatValue(value) }))} />}
          </Card>
          <Card size="small" title="动作时间线">
            {timeline.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无动作记录" /> : <Timeline items={timeline.map((entry) => ({
              color: entry.outcome === 'rejected' ? 'red' : entry.outcome === 'approved' ? 'green' : 'blue',
              children: <Space direction="vertical" size={0}>
                <Typography.Text strong>{timelineText(entry)}</Typography.Text>
                <Typography.Text type="secondary">{entry.actorId} · {new Date(entry.occurredAt).toLocaleString('zh-CN')} · v{entry.aggregateVersion}</Typography.Text>
              </Space>,
            }))} />}
          </Card>
          {selected.status === 'running' ? <Flex justify="flex-end" gap={12}>
            <Button danger loading={writing} disabled={selected.riskLevel === 'R2'} onClick={() => {
              modal.confirm({ title: '确认拒绝此审批？', okText: '拒绝', okButtonProps: { danger: true }, onOk: async () => decide('rejected') });
            }}>拒绝</Button>
            <Button type="primary" loading={writing} disabled={selected.riskLevel === 'R2'} onClick={() => {
              modal.confirm({ title: '确认通过此审批？', onOk: async () => decide('approved') });
            }}>通过</Button>
          </Flex> : null}
        </Space>}
      </Drawer>
    </main>
  );
}

function timelineText(entry: ApprovalTimelineEntry): string {
  const labels: Readonly<Record<ApprovalTimelineEntry['actionType'], string>> = {
    'instance.submitted': '提交审批',
    'instance.decided': entry.outcome === 'approved' ? '审批通过' : '审批拒绝',
    'instance.approver_transferred': '转交审批人',
    'instance.approver_added': '新增审批人',
    'instance.withdrawn': '撤回审批',
    'instance.archived': '归档审批',
  };
  return `${labels[entry.actionType]}${entry.delegated ? '（委托）' : ''}`;
}

function formatValue(value: unknown): React.ReactNode {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).redacted === true) return <Tag>已脱敏</Tag>;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value === null) return '—';
  return <Typography.Text code>{JSON.stringify(value)}</Typography.Text>;
}
