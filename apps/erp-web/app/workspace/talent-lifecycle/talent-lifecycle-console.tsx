'use client';

import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  List,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createIdempotencyKey,
  erpFetch,
  strongEtag,
} from '../../lib/api-client';

const { Title, Paragraph, Text } = Typography;

type LifecycleStage =
  | 'talent_pool'
  | 'recruiting'
  | 'offer'
  | 'onboarding'
  | 'employed'
  | 'offboarding'
  | 'alumni'
  | 'former_employee'
  | 'inactive';

interface LifecycleSummary {
  readonly candidateId: string;
  readonly displayName: string | null;
  readonly stage: LifecycleStage;
  readonly candidateStatus: string;
  readonly currentApplicationStage: string | null;
  readonly currentPositionTitle: string | null;
  readonly employeeStatus: string | null;
  readonly activeCareStatus: string | null;
  readonly alumniConsentStatus: string | null;
  readonly openFollowUpCount: number;
  readonly nextActionAt: string | null;
  readonly updatedAt: string;
}

interface TimelineEntry {
  readonly id: string;
  readonly domain: 'recruitment' | 'onboarding' | 'org' | 'care' | 'alumni' | 'service';
  readonly eventType: string;
  readonly title: string;
  readonly occurredAt: string;
  readonly referenceType: string;
  readonly referenceId: string;
}

interface Touchpoint {
  readonly id: string;
  readonly candidateId: string;
  readonly kind: string;
  readonly channel: string;
  readonly direction: string;
  readonly outcome: string;
  readonly ownerActorId: string;
  readonly occurredAt: string;
  readonly nextActionAt: string | null;
  readonly status: 'open' | 'completed' | 'cancelled';
  readonly note: string | null;
  readonly version: number;
}

interface LifecycleDetail extends LifecycleSummary {
  readonly personId: string | null;
  readonly applications: readonly {
    readonly id: string;
    readonly positionTitle: string;
    readonly stage: string;
    readonly sourceChannel: string;
    readonly appliedAt: string;
  }[];
  readonly onboarding: readonly {
    readonly id: string;
    readonly status: string;
    readonly proposedStartDate: string;
  }[];
  readonly employments: readonly {
    readonly id: string;
    readonly employeeNo: string;
    readonly displayName: string;
    readonly status: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
  readonly care: {
    readonly cases: readonly {
      readonly id: string;
      readonly status: string;
      readonly lastWorkingDate: string;
    }[];
    readonly alumniConsents: readonly {
      readonly id: string;
      readonly purpose: string;
      readonly status: string;
      readonly expiresAt: string;
    }[];
  };
  readonly touchpoints: readonly Touchpoint[];
  readonly timeline: readonly TimelineEntry[];
}

interface TouchpointForm {
  readonly kind: string;
  readonly channel: string;
  readonly direction: string;
  readonly outcome: string;
  readonly occurredAt: string;
  readonly nextActionAt?: string;
  readonly note?: string;
}

const STAGES: Readonly<Record<LifecycleStage, {
  readonly label: string;
  readonly color: string;
}>> = {
  talent_pool: { label: '人才库', color: 'default' },
  recruiting: { label: '招聘中', color: 'blue' },
  offer: { label: 'Offer', color: 'purple' },
  onboarding: { label: '入职中', color: 'cyan' },
  employed: { label: '在职', color: 'green' },
  offboarding: { label: '离职办理', color: 'orange' },
  alumni: { label: '校友', color: 'gold' },
  former_employee: { label: '已离职', color: 'default' },
  inactive: { label: '已失效', color: 'red' },
};

const DOMAIN_COLORS: Readonly<Record<TimelineEntry['domain'], string>> = {
  recruitment: 'blue',
  onboarding: 'cyan',
  org: 'green',
  care: 'orange',
  alumni: 'gold',
  service: 'purple',
};

/** 人才全周期工作台：统一读取跨域事实，服务备注仅由受权人员查看和维护。 */
export function TalentLifecycleConsole() {
  const [items, setItems] = useState<readonly LifecycleSummary[]>([]);
  const [active, setActive] = useState<LifecycleDetail | null>(null);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<LifecycleStage | undefined>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [touchpointOpen, setTouchpointOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<TouchpointForm>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ limit: '50' });
    if (search.trim().length > 0) query.set('search', search.trim());
    if (stage !== undefined) query.set('stage', stage);
    try {
      const result = await erpFetch<{ readonly items: readonly LifecycleSummary[] }>(
        `/api/talent-lifecycle/people?${query.toString()}`,
      );
      setItems(result.data.items);
    } catch (value) {
      setError(value instanceof Error ? value.message : '人才全周期列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [search, stage]);

  useEffect(() => { void load(); }, [load]);

  async function openDetail(candidateId: string): Promise<void> {
    setDetailLoading(true);
    setError(null);
    try {
      const result = await erpFetch<LifecycleDetail>(
        `/api/talent-lifecycle/people/${candidateId}`,
      );
      setActive(result.data);
    } catch (value) {
      setError(value instanceof Error ? value.message : '人才全景加载失败');
    } finally {
      setDetailLoading(false);
    }
  }

  async function createTouchpoint(values: TouchpointForm): Promise<void> {
    if (active === null) return;
    setSaving(true);
    setError(null);
    try {
      await erpFetch(`/api/talent-lifecycle/people/${active.candidateId}/touchpoints`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': createIdempotencyKey('talent.touchpoint.create'),
        },
        body: JSON.stringify({
          ...values,
          occurredAt: new Date(values.occurredAt).toISOString(),
          ...(values.nextActionAt === undefined || values.nextActionAt.length === 0
            ? {}
            : { nextActionAt: new Date(values.nextActionAt).toISOString() }),
          ...(values.note === undefined || values.note.trim().length === 0
            ? {}
            : { note: values.note.trim() }),
        }),
      });
      setTouchpointOpen(false);
      form.resetFields();
      await openDetail(active.candidateId);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : '服务跟进保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function closeTouchpoint(touchpoint: Touchpoint): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await erpFetch(`/api/talent-lifecycle/touchpoints/${touchpoint.id}/close`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': createIdempotencyKey('talent.touchpoint.close'),
          'if-match': strongEtag(touchpoint.version),
        },
        body: JSON.stringify({ status: 'completed' }),
      });
      if (active !== null) await openDetail(active.candidateId);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : '跟进行动关闭失败');
    } finally {
      setSaving(false);
    }
  }

  const counts = useMemo(() => ({
    total: items.length,
    recruiting: items.filter((item) => ['recruiting', 'offer', 'onboarding'].includes(item.stage)).length,
    employed: items.filter((item) => item.stage === 'employed').length,
    followUps: items.reduce((total, item) => total + item.openFollowUpCount, 0),
  }), [items]);

  const columns: ColumnsType<LifecycleSummary> = [
    {
      title: '人才',
      key: 'person',
      render: (_, item) => (
        <Space direction="vertical" size={0}>
          <Text strong>{item.displayName ?? '已匿名化'}</Text>
          <Text type="secondary">{item.candidateId}</Text>
        </Space>
      ),
    },
    {
      title: '当前阶段',
      dataIndex: 'stage',
      render: (value: LifecycleStage) => (
        <Tag color={STAGES[value].color}>{STAGES[value].label}</Tag>
      ),
    },
    {
      title: '职位 / 招聘状态',
      key: 'application',
      render: (_, item) => (
        <Space direction="vertical" size={0}>
          <Text>{item.currentPositionTitle ?? '暂无当前职位'}</Text>
          <Text type="secondary">{item.currentApplicationStage ?? '—'}</Text>
        </Space>
      ),
    },
    {
      title: '待跟进',
      key: 'followUp',
      render: (_, item) => (
        <Space direction="vertical" size={0}>
          <Text strong={item.openFollowUpCount > 0}>{item.openFollowUpCount} 项</Text>
          <Text type="secondary">
            {item.nextActionAt === null ? '暂无计划' : formatTime(item.nextActionAt)}
          </Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_, item) => (
        <Button type="link" onClick={() => void openDetail(item.candidateId)}>查看全景</Button>
      ),
    },
  ];

  return (
    <main aria-labelledby="talent-lifecycle-title">
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div className="console-page-heading">
          <Space direction="vertical" size={4}>
            <Text type="secondary">Talent / Lifecycle 360</Text>
            <Title id="talent-lifecycle-title" level={1}>人才全周期</Title>
            <Paragraph>
              从简历投递、招聘、入职、在职、离职到校友，以统一身份引用呈现业务事实和服务跟进。
            </Paragraph>
          </Space>
        </div>

        <Alert
          showIcon
          type="info"
          message="统一视图，不改变各域事实"
          description="招聘、组织、入职和离职状态仍由各自业务流程维护；此处只组装全景，并记录受控服务触点。"
        />
        {error === null ? null : (
          <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />
        )}

        <Row gutter={[16, 16]}>
          <Col xs={12} lg={6}><Card><Statistic title="当前人才" value={counts.total} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="招聘至入职" value={counts.recruiting} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="在职人才" value={counts.employed} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="待跟进行动" value={counts.followUps} /></Card></Col>
        </Row>

        <Card>
          <Space wrap style={{ marginBottom: 16 }}>
            <Input.Search
              allowClear
              placeholder="搜索姓名、候选人 ID 或职位"
              style={{ width: 320 }}
              defaultValue={search}
              onSearch={setSearch}
            />
            <Select
              allowClear
              placeholder="生命周期阶段"
              style={{ width: 180 }}
              value={stage}
              options={Object.entries(STAGES).map(([value, item]) => ({
                value,
                label: item.label,
              }))}
              onChange={(value) => setStage(value)}
            />
            <Button onClick={() => void load()}>刷新</Button>
          </Space>
          <Table
            rowKey="candidateId"
            loading={loading}
            columns={columns}
            dataSource={[...items]}
            pagination={{ pageSize: 20, showSizeChanger: false }}
          />
        </Card>
      </Space>

      <Drawer
        title={active === null ? '人才全景' : `${active.displayName ?? '已匿名化'} · 人才全景`}
        width={760}
        open={active !== null || detailLoading}
        loading={detailLoading}
        onClose={() => setActive(null)}
        extra={active === null ? null : (
          <Button type="primary" onClick={() => {
            form.setFieldsValue({ occurredAt: localInputTime(new Date()) });
            setTouchpointOpen(true);
          }}>
            记录服务跟进
          </Button>
        )}
      >
        {active === null ? null : (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="生命周期">
                <Tag color={STAGES[active.stage].color}>{STAGES[active.stage].label}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="候选人 ID">{active.candidateId}</Descriptions.Item>
              <Descriptions.Item label="当前职位">
                {active.currentPositionTitle ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="员工状态">
                {active.employeeStatus ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="待跟进">
                {active.openFollowUpCount} 项
              </Descriptions.Item>
              <Descriptions.Item label="下一行动">
                {active.nextActionAt === null ? '—' : formatTime(active.nextActionAt)}
              </Descriptions.Item>
            </Descriptions>

            <Card size="small" title="服务跟进">
              <List
                dataSource={[...active.touchpoints]}
                locale={{ emptyText: '尚无服务跟进记录' }}
                renderItem={(item) => (
                  <List.Item
                    actions={item.status === 'open'
                      ? [<Button key="done" type="link" loading={saving} onClick={() => void closeTouchpoint(item)}>标记完成</Button>]
                      : []}
                  >
                    <List.Item.Meta
                      title={(
                        <Space wrap>
                          <Tag color={item.status === 'open' ? 'processing' : 'default'}>
                            {item.status}
                          </Tag>
                          <Text>{item.kind} · {item.outcome}</Text>
                        </Space>
                      )}
                      description={(
                        <Space direction="vertical" size={2}>
                          <Text type="secondary">
                            {item.channel} · {formatTime(item.occurredAt)} · 负责人 {item.ownerActorId}
                          </Text>
                          {item.note === null ? null : <Text>{item.note}</Text>}
                          {item.nextActionAt === null ? null : (
                            <Text type="warning">下一行动：{formatTime(item.nextActionAt)}</Text>
                          )}
                        </Space>
                      )}
                    />
                  </List.Item>
                )}
              />
            </Card>

            <Card size="small" title="生命周期时间线">
              <Timeline
                items={active.timeline.map((item) => ({
                  color: DOMAIN_COLORS[item.domain],
                  children: (
                    <Space direction="vertical" size={0}>
                      <Text strong>{item.title}</Text>
                      <Text type="secondary">
                        {formatTime(item.occurredAt)} · {item.domain}
                      </Text>
                    </Space>
                  ),
                }))}
              />
            </Card>
          </Space>
        )}
      </Drawer>

      <Modal
        title="记录服务跟进"
        open={touchpointOpen}
        confirmLoading={saving}
        okText="保存"
        onOk={() => form.submit()}
        onCancel={() => setTouchpointOpen(false)}
      >
        <Form form={form} layout="vertical" onFinish={(values) => void createTouchpoint(values)}>
          <Form.Item name="kind" label="服务类型" rules={[{ required: true }]}>
            <Select options={[
              ['candidate_outreach', '候选人沟通'],
              ['interview_support', '面试支持'],
              ['offer_support', 'Offer 支持'],
              ['onboarding_support', '入职支持'],
              ['employee_care', '在职关怀'],
              ['offboarding_support', '离职支持'],
              ['alumni_engagement', '校友互动'],
              ['rehire_contact', '返聘联系'],
            ].map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="channel" label="渠道" rules={[{ required: true }]}>
                <Select options={['email', 'phone', 'wechat', 'meeting', 'portal', 'internal']
                  .map((value) => ({ value, label: value }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="direction" label="方向" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'inbound', label: '候选人发起' },
                  { value: 'outbound', label: '公司发起' },
                  { value: 'internal', label: '内部跟进' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="outcome" label="结果" rules={[{ required: true }]}>
                <Select options={[
                  'contacted', 'no_response', 'follow_up_required', 'resolved',
                  'declined', 'joined', 'departed', 'consent_withdrawn',
                ].map((value) => ({ value, label: value }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="occurredAt" label="发生时间" rules={[{ required: true }]}>
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="nextActionAt" label="下一行动时间">
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item
            name="note"
            label="服务备注"
            extra="备注加密保存，请勿录入证件、薪酬、医疗或其他无关敏感信息。"
          >
            <Input.TextArea maxLength={1_000} showCount rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </main>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function localInputTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}
