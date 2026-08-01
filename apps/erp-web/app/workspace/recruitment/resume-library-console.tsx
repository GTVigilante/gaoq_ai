'use client';

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
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

type AnalysisStatus = 'queued' | 'processing' | 'review_required' | 'approved' | 'failed';
type TagStatus = 'suggested' | 'confirmed' | 'rejected';

interface ResumeTag {
  readonly category: string;
  readonly code: string;
  readonly label: string;
  readonly confidence: number;
  readonly evidence: string;
  readonly source: 'ai' | 'manual';
  readonly status: TagStatus;
}

interface ResumeAnalysis {
  readonly id: string;
  readonly candidateId: string;
  readonly candidateName: string | null;
  readonly resumeEvidenceId: string;
  readonly status: AnalysisStatus;
  readonly profile: {
    readonly headline: string;
    readonly summary: string;
    readonly yearsExperience: number;
    readonly educationLevel: string;
    readonly skills: readonly string[];
    readonly jobTitles: readonly string[];
    readonly industries: readonly string[];
    readonly languages: readonly string[];
  } | null;
  readonly tags: readonly ResumeTag[];
  readonly aiModel: string | null;
  readonly failureCode: string | null;
  readonly attempts: number;
  readonly version: number;
  readonly updatedAt: string;
}

interface TagDefinition {
  readonly category: string;
  readonly code: string;
  readonly label: string;
}

interface RequestForm {
  readonly candidateId: string;
  readonly resumeEvidenceId: string;
}

const STATUS: Readonly<Record<AnalysisStatus, { readonly label: string; readonly color: string }>> = {
  queued: { label: '等待解析', color: 'default' },
  processing: { label: 'AI 处理中', color: 'processing' },
  review_required: { label: '待人工确认', color: 'warning' },
  approved: { label: '已确认入库', color: 'success' },
  failed: { label: '处理失败', color: 'error' },
};

/** 简历库工作台：AI 只建议职业标签，招聘人员确认后才进入正式人才检索。 */
export function ResumeLibraryConsole() {
  const [items, setItems] = useState<readonly ResumeAnalysis[]>([]);
  const [taxonomy, setTaxonomy] = useState<readonly TagDefinition[]>([]);
  const [status, setStatus] = useState<AnalysisStatus | undefined>();
  const [tagCode, setTagCode] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [active, setActive] = useState<ResumeAnalysis | null>(null);
  const [confirmedCodes, setConfirmedCodes] = useState<readonly string[]>([]);
  const [manualCodes, setManualCodes] = useState<readonly string[]>([]);
  const [form] = Form.useForm<RequestForm>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = new URLSearchParams();
    if (status !== undefined) query.set('status', status);
    if (tagCode !== undefined) query.set('tag', tagCode);
    try {
      const result = await erpFetch<{
        readonly items: readonly ResumeAnalysis[];
        readonly taxonomy: readonly TagDefinition[];
      }>(`/api/recruitment/resume-library/analyses${query.size === 0 ? '' : `?${query.toString()}`}`);
      setItems(result.data.items);
      setTaxonomy(result.data.taxonomy);
    } catch (value) {
      setError(value instanceof Error ? value.message : '简历库加载失败');
    } finally {
      setLoading(false);
    }
  }, [status, tagCode]);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({
    all: items.length,
    pending: items.filter((item) => item.status === 'review_required').length,
    approved: items.filter((item) => item.status === 'approved').length,
    failed: items.filter((item) => item.status === 'failed').length,
  }), [items]);

  async function requestAnalysis(values: RequestForm): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await erpFetch(`/api/recruitment/resume-library/candidates/${values.candidateId}/analyses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': createIdempotencyKey('recruitment.resume.analyze'),
        },
        body: JSON.stringify({ resumeEvidenceId: values.resumeEvidenceId }),
      });
      setRequestOpen(false);
      form.resetFields();
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : '简历分析任务创建失败');
    } finally {
      setSaving(false);
    }
  }

  function openReview(item: ResumeAnalysis): void {
    setActive(item);
    setConfirmedCodes(
      item.tags.filter((tag) => tag.source === 'ai' && tag.status === 'confirmed')
        .map((tag) => tag.code),
    );
    setManualCodes(
      item.tags.filter((tag) => tag.source === 'manual' && tag.status === 'confirmed')
        .map((tag) => tag.code),
    );
  }

  async function review(): Promise<void> {
    if (active === null) return;
    setSaving(true);
    setError(null);
    try {
      const suggested = active.tags.filter((tag) => tag.source === 'ai');
      await erpFetch(`/api/recruitment/resume-library/analyses/${active.id}/review`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': createIdempotencyKey('recruitment.resume.review'),
          'if-match': strongEtag(active.version),
        },
        body: JSON.stringify({
          decisions: suggested.map((tag) => ({
            code: tag.code,
            status: confirmedCodes.includes(tag.code) ? 'confirmed' : 'rejected',
          })),
          manualTagCodes: manualCodes,
        }),
      });
      setActive(null);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : '标签确认失败');
    } finally {
      setSaving(false);
    }
  }

  const columns: ColumnsType<ResumeAnalysis> = [
    {
      title: '候选人',
      key: 'candidate',
      render: (_, item) => (
        <Space direction="vertical" size={0}>
          <Text strong>{item.candidateName ?? '已匿名化'}</Text>
          <Text type="secondary">{item.candidateId}</Text>
        </Space>
      ),
    },
    {
      title: 'AI 结构摘要',
      key: 'profile',
      render: (_, item) => (
        <Space direction="vertical" size={0}>
          <Text>{item.profile?.headline ?? '等待生成'}</Text>
          {item.profile === null ? null : (
            <Text type="secondary">{item.profile.yearsExperience} 年相关经验</Text>
          )}
        </Space>
      ),
    },
    {
      title: '分类与标签',
      key: 'tags',
      render: (_, item) => (
        <Space size={[4, 4]} wrap>
          {item.tags.filter((tag) => tag.status !== 'rejected').slice(0, 6).map((tag) => (
            <Tag
              key={`${tag.source}:${tag.code}`}
              color={tag.status === 'confirmed' ? 'green' : 'gold'}
            >
              {tag.label}{tag.status === 'suggested' ? ` ${Math.round(tag.confidence * 100)}%` : ''}
            </Tag>
          ))}
          {item.tags.length === 0 ? <Text type="secondary">暂无</Text> : null}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: AnalysisStatus) => <Tag color={STATUS[value].color}>{STATUS[value].label}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      render: (_, item) => (
        <Button
          type={item.status === 'review_required' ? 'primary' : 'default'}
          disabled={!['review_required', 'approved'].includes(item.status)}
          onClick={() => openReview(item)}
        >
          {item.status === 'approved' ? '查看/调整' : '确认标签'}
        </Button>
      ),
    },
  ];

  return (
    <main aria-labelledby="resume-library-title">
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div className="console-page-heading">
          <Space direction="vertical" size={4}>
            <Text type="secondary">Recruitment / Resume Library</Text>
            <Title id="resume-library-title" level={1}>智能简历库</Title>
            <Paragraph>
              简历先经恶意文件扫描和身份信息脱敏，再由 AI 生成结构化履历、职业分类和受控标签。
              AI 不做录用或淘汰决定；建议标签经招聘人员确认后才进入正式检索。
            </Paragraph>
          </Space>
          <Button type="primary" onClick={() => setRequestOpen(true)}>发起简历解析</Button>
        </div>

        <Alert
          type="info"
          showIcon
          message="AI 辅助边界"
          description="不会根据年龄、性别、民族、婚育、宗教、健康、照片或证件信息分类，也不会自动排序候选人。"
        />
        {error === null ? null : <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}

        <Row gutter={[16, 16]}>
          <Col xs={12} lg={6}><Card><Statistic title="当前结果" value={counts.all} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="待人工确认" value={counts.pending} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="已确认入库" value={counts.approved} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="需处理失败" value={counts.failed} /></Card></Col>
        </Row>

        <Card>
          <Space wrap style={{ marginBottom: 16 }}>
            <Select
              allowClear
              placeholder="按状态筛选"
              style={{ width: 180 }}
              value={status}
              options={Object.entries(STATUS).map(([value, item]) => ({
                value, label: item.label,
              }))}
              onChange={(value) => setStatus(value)}
            />
            <Select
              showSearch
              allowClear
              optionFilterProp="label"
              placeholder="按已确认标签筛选"
              style={{ width: 220 }}
              value={tagCode}
              options={taxonomy.map((item) => ({ value: item.code, label: item.label }))}
              onChange={(value) => setTagCode(value)}
            />
            <Button onClick={() => void load()}>刷新</Button>
          </Space>
          <Table
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={[...items]}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            scroll={{ x: 960 }}
          />
        </Card>
      </Space>

      <Modal
        title="发起简历 AI 解析"
        open={requestOpen}
        confirmLoading={saving}
        onCancel={() => setRequestOpen(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message="只能使用已完成扫描并绑定该候选人的简历证据 ID"
          style={{ marginBottom: 16 }}
        />
        <Form form={form} layout="vertical" onFinish={(values) => void requestAnalysis(values)}>
          <Form.Item
            label="候选人 ID"
            name="candidateId"
            rules={[{ required: true }, { pattern: /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, message: '请输入有效候选人 ID' }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="简历证据 ID"
            name="resumeEvidenceId"
            rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, message: '请输入有效证据 ID' }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        width={760}
        title={active === null ? '简历标签复核' : `${active.candidateName ?? '候选人'} · 简历标签复核`}
        open={active !== null}
        confirmLoading={saving}
        okText="确认并入库"
        onCancel={() => setActive(null)}
        onOk={() => void review()}
        destroyOnHidden
      >
        {active?.profile === null || active === null ? null : (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="职业概览" span={2}>{active.profile.headline}</Descriptions.Item>
              <Descriptions.Item label="经验年限">{active.profile.yearsExperience} 年</Descriptions.Item>
              <Descriptions.Item label="教育层次">{active.profile.educationLevel}</Descriptions.Item>
              <Descriptions.Item label="结构摘要" span={2}>{active.profile.summary}</Descriptions.Item>
              <Descriptions.Item label="识别技能" span={2}>{active.profile.skills.join('、') || '无'}</Descriptions.Item>
            </Descriptions>
            <section>
              <Title level={4}>AI 建议标签</Title>
              <Checkbox.Group
                value={[...confirmedCodes]}
                onChange={(values) => setConfirmedCodes(values.map(String))}
              >
                <Space direction="vertical">
                  {active.tags.filter((tag) => tag.source === 'ai').map((tag) => (
                    <Checkbox key={tag.code} value={tag.code}>
                      <Tag color="gold">{tag.label} · {Math.round(tag.confidence * 100)}%</Tag>
                      <Text type="secondary">{tag.evidence}</Text>
                    </Checkbox>
                  ))}
                </Space>
              </Checkbox.Group>
            </section>
            <section>
              <Title level={4}>人工补充标签</Title>
              <Select
                mode="multiple"
                style={{ width: '100%' }}
                value={[...manualCodes]}
                options={taxonomy.map((item) => ({ value: item.code, label: item.label }))}
                onChange={(values) => setManualCodes(values)}
                placeholder="从受控词表选择"
              />
            </section>
          </Space>
        )}
      </Modal>
    </main>
  );
}
