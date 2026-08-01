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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createIdempotencyKey,
  ErpApiError,
  erpFetch,
  isDefinitiveWriteRejection,
  strongEtag,
} from '../../lib/api-client';
import {
  parseIdentityProfile,
  type IdentityProfileView,
} from '../../lib/approval-contract';
import {
  buildTouchpointCreateInput,
  canCloseTalentTouchpoint,
  canRetryTalentTouchpoint,
  canWriteTalentTouchpoint,
  parseTalentLifecycleDetail,
  parseTalentLifecycleList,
  parseTouchpointMutationResult,
  type LifecycleDetail,
  type LifecycleStage,
  type LifecycleSummary,
  type Touchpoint,
  type TouchpointCreateInput,
} from '../../lib/talent-lifecycle-contract';

const { Title, Paragraph, Text } = Typography;

interface TouchpointForm {
  readonly kind: string;
  readonly channel: string;
  readonly direction: string;
  readonly outcome: string;
  readonly occurredAt: string;
  readonly nextActionAt?: string;
  readonly note?: string;
}

interface PendingTouchpointCreate {
  readonly actorId: string;
  readonly candidateId: string;
  readonly input: TouchpointCreateInput;
  readonly key: string;
}

interface PendingTouchpointClose {
  readonly actorId: string;
  readonly candidateId: string;
  readonly ownerActorId: string;
  readonly touchpointId: string;
  readonly version: number;
  readonly input: { readonly status: 'completed' };
  readonly key: string;
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

const DOMAIN_COLORS: Readonly<Record<LifecycleDetail['timeline'][number]['domain'], string>> = {
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
  const [profile, setProfile] = useState<IdentityProfileView | null>(null);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<LifecycleStage | undefined>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [touchpointOpen, setTouchpointOpen] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingTouchpointCreate | null>(null);
  const [pendingClose, setPendingClose] = useState<PendingTouchpointClose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<TouchpointForm>();
  const loadGeneration = useRef(0);
  const detailGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setError(null);
    setItems([]);
    setProfile(null);
    const query = new URLSearchParams({ limit: '50' });
    if (search.trim().length > 0) query.set('search', search.trim());
    if (stage !== undefined) query.set('stage', stage);
    try {
      const [listResult, profileResult] = await Promise.all([
        erpFetch<unknown>(`/api/talent-lifecycle/people?${query.toString()}`),
        erpFetch<unknown>('/api/auth/profile'),
      ]);
      const nextItems = parseTalentLifecycleList(listResult.data);
      const nextProfile = parseIdentityProfile(profileResult.data);
      if (generation !== loadGeneration.current) return;
      setItems(nextItems);
      setProfile(nextProfile);
    } catch (value) {
      if (generation !== loadGeneration.current) return;
      setError(errorMessage(value, '人才全周期列表加载失败'));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [search, stage]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (profile === null) return;
    setPendingCreate((current) =>
      current !== null && !canRetryTalentTouchpoint(profile, current.actorId) ? null : current);
    setPendingClose((current) =>
      current !== null &&
      !canRetryTalentTouchpoint(profile, current.actorId, current.ownerActorId)
        ? null
        : current);
  }, [profile]);

  async function openDetail(candidateId: string): Promise<void> {
    const generation = detailGeneration.current + 1;
    detailGeneration.current = generation;
    setDetailLoading(true);
    setError(null);
    setActive(null);
    try {
      const result = await erpFetch<unknown>(
        `/api/talent-lifecycle/people/${candidateId}`,
      );
      const detail = parseTalentLifecycleDetail(result.data);
      if (detail.candidateId !== candidateId) throw new Error('TALENT_LIFECYCLE_TARGET_MISMATCH');
      if (generation !== detailGeneration.current) return;
      setActive(detail);
    } catch (value) {
      if (generation !== detailGeneration.current) return;
      setError(errorMessage(value, '人才全景加载失败'));
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  }

  async function executeCreate(attempt: PendingTouchpointCreate): Promise<void> {
    if (!canRetryTalentTouchpoint(profile, attempt.actorId)) {
      if (profile !== null) setPendingCreate(null);
      setError(profile === null
        ? '请先刷新并确认当前身份，再重试原服务跟进请求。'
        : '当前身份或授权已变化，原服务跟进请求已清除。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await erpFetch<unknown>(
        `/api/talent-lifecycle/people/${attempt.candidateId}/touchpoints`,
        {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': attempt.key,
        },
        body: JSON.stringify(attempt.input),
      });
      const parsed = parseTouchpointMutationResult(result.data);
      if (parsed.touchpoint.candidateId !== attempt.candidateId) {
        throw new Error('TALENT_TOUCHPOINT_TARGET_MISMATCH');
      }
      setPendingCreate(null);
      setTouchpointOpen(false);
      form.resetFields();
      await openDetail(attempt.candidateId);
      await load();
    } catch (value) {
      const definitive = isDefinitiveWriteRejection(value);
      if (definitive) setPendingCreate(null);
      setError(writeErrorMessage(value, '服务跟进保存失败', !definitive));
    } finally {
      setSaving(false);
    }
  }

  async function createTouchpoint(values: TouchpointForm): Promise<void> {
    if (
      active === null ||
      profile === null ||
      !canWriteTalentTouchpoint(profile.scopes) ||
      pendingCreate !== null ||
      pendingClose !== null
    ) return;
    const attempt = Object.freeze({
      actorId: profile.actorId,
      candidateId: active.candidateId,
      input: buildTouchpointCreateInput(values),
      key: createIdempotencyKey('talent.touchpoint.create'),
    });
    setPendingCreate(attempt);
    await executeCreate(attempt);
  }

  async function executeClose(attempt: PendingTouchpointClose): Promise<void> {
    if (!canRetryTalentTouchpoint(profile, attempt.actorId, attempt.ownerActorId)) {
      if (profile !== null) setPendingClose(null);
      setError(profile === null
        ? '请先刷新并确认当前身份，再重试原关闭请求。'
        : '当前身份或授权已变化，原关闭请求已清除。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await erpFetch<unknown>(
        `/api/talent-lifecycle/touchpoints/${attempt.touchpointId}/close`,
        {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': attempt.key,
          'if-match': strongEtag(attempt.version),
        },
        body: JSON.stringify(attempt.input),
      });
      const parsed = parseTouchpointMutationResult(result.data);
      if (
        parsed.touchpoint.id !== attempt.touchpointId ||
        parsed.touchpoint.candidateId !== attempt.candidateId ||
        parsed.touchpoint.status !== attempt.input.status ||
        parsed.touchpoint.version !== attempt.version + 1
      ) throw new Error('TALENT_TOUCHPOINT_CLOSE_RESULT_MISMATCH');
      setPendingClose(null);
      await openDetail(attempt.candidateId);
      await load();
    } catch (value) {
      const definitive = isDefinitiveWriteRejection(value);
      if (definitive) setPendingClose(null);
      setError(writeErrorMessage(value, '跟进行动关闭失败', !definitive));
    } finally {
      setSaving(false);
    }
  }

  async function closeTouchpoint(touchpoint: Touchpoint): Promise<void> {
    if (
      active === null ||
      profile === null ||
      !canCloseTalentTouchpoint(profile, touchpoint) ||
      pendingCreate !== null ||
      pendingClose !== null
    ) return;
    const attempt = Object.freeze({
      actorId: profile.actorId,
      candidateId: active.candidateId,
      ownerActorId: touchpoint.ownerActorId,
      touchpointId: touchpoint.id,
      version: touchpoint.version,
      input: Object.freeze({ status: 'completed' as const }),
      key: createIdempotencyKey('talent.touchpoint.close'),
    });
    setPendingClose(attempt);
    await executeClose(attempt);
  }

  const canWrite = profile !== null && canWriteTalentTouchpoint(profile.scopes);
  const hasPendingWrite = pendingCreate !== null || pendingClose !== null;

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
        {!loading && profile !== null && !canWrite ? (
          <Alert
            type="info"
            showIcon
            message="当前身份仅可查看人才全周期"
            description="服务触点写入同时需要读取与 erp:talent-lifecycle:touchpoint:write Scope。"
          />
        ) : null}

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
        closable={!hasPendingWrite && !saving}
        keyboard={!hasPendingWrite && !saving}
        maskClosable={!hasPendingWrite && !saving}
        onClose={() => {
          if (!hasPendingWrite && !saving) setActive(null);
        }}
        extra={active === null || !canWrite ? null : (
          <Button type="primary" onClick={() => {
            form.setFieldsValue({ occurredAt: localInputTime(new Date()) });
            setTouchpointOpen(true);
          }} disabled={hasPendingWrite || saving}>
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
              {pendingClose === null ? null : (
                <Alert
                  type="warning"
                  showIcon
                  message="上次关闭结果尚未确认"
                  description="只能重试原关闭请求；系统会复用同一主体、版本、正文和幂等键。"
                  style={{ marginBottom: 12 }}
                />
              )}
              <List
                dataSource={[...active.touchpoints]}
                locale={{ emptyText: '尚无服务跟进记录' }}
                renderItem={(item) => (
                  <List.Item
                    actions={
                      pendingClose?.touchpointId === item.id
                        ? [(
                          <Button
                            key="retry"
                            type="link"
                            loading={saving}
                            onClick={() => void executeClose(pendingClose)}
                          >
                            重试原关闭请求
                          </Button>
                        )]
                        : pendingClose === null && canCloseTalentTouchpoint(profile, item)
                          ? [(
                            <Button
                              key="done"
                              type="link"
                              loading={saving}
                              disabled={pendingCreate !== null}
                              onClick={() => void closeTouchpoint(item)}
                            >
                              标记完成
                            </Button>
                          )]
                          : []
                    }
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
        okText={pendingCreate === null ? '保存' : '重试原请求'}
        cancelButtonProps={{ disabled: pendingCreate !== null || saving }}
        closable={pendingCreate === null && !saving}
        keyboard={pendingCreate === null && !saving}
        maskClosable={pendingCreate === null && !saving}
        onOk={() => {
          if (pendingCreate === null) form.submit();
          else void executeCreate(pendingCreate);
        }}
        onCancel={() => {
          if (pendingCreate === null && !saving) setTouchpointOpen(false);
        }}
      >
        {pendingCreate === null ? null : (
          <Alert
            type="warning"
            showIcon
            message="上次保存结果尚未确认"
            description="重试会复用完全相同的主体、候选人、正文和幂等键，不会创建第二条服务触点。"
            style={{ marginBottom: 12 }}
          />
        )}
        <Form
          form={form}
          layout="vertical"
          disabled={saving || pendingCreate !== null}
          onFinish={(values) => void createTouchpoint(values)}
        >
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

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof ErpApiError) {
    return value.traceId === null ? value.message : `${value.message}（追踪标识：${value.traceId}）`;
  }
  return value instanceof Error ? value.message : fallback;
}

function writeErrorMessage(value: unknown, fallback: string, uncertain: boolean): string {
  const message = errorMessage(value, fallback);
  return uncertain
    ? `${message}；结果尚未确认，请使用“重试原请求”，系统会复用同一幂等键。`
    : message;
}
