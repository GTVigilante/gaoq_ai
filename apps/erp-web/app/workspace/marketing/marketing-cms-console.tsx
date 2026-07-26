'use client';

import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  createIdempotencyKey,
  erpFetch,
  strongEtag,
} from '../../lib/api-client';

const { Title, Paragraph, Text } = Typography;
type Locale = 'zh-CN' | 'en';
type ContentStatus = 'draft' | 'in_review' | 'approved' | 'scheduled' | 'published' | 'archived';
interface ContentItem {
  readonly id: string;
  readonly siteId: string;
  readonly type: string;
  readonly locale: Locale;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly status: ContentStatus;
  readonly revision: number;
  readonly version: number;
}
interface ContentForm {
  readonly siteId: string;
  readonly type: string;
  readonly locale: Locale;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string;
  readonly heroTitle: string;
  readonly heroBody: string;
  readonly seoTitle?: string;
  readonly seoDescription?: string;
}
interface LeadItem {
  readonly id: string;
  readonly audience: 'creator' | 'brand';
  readonly name: string;
  readonly contact: string;
  readonly requestSummary: string;
  readonly status: string;
  readonly version: number;
  readonly createdAt: string;
}
interface MediaItem {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly status: string;
  readonly version: number;
  readonly variants: Readonly<Record<string, string>>;
}

const STATUS: Record<ContentStatus, { readonly text: string; readonly color: string }> = {
  draft: { text: '草稿', color: 'default' },
  in_review: { text: '审核中', color: 'processing' },
  approved: { text: '已批准', color: 'cyan' },
  scheduled: { text: '已排期', color: 'purple' },
  published: { text: '已发布', color: 'success' },
  archived: { text: '已归档', color: 'warning' },
};

/** 营销 CMS 首版控制台：受控内容创建、审核与发布。 */
export function MarketingCmsConsole() {
  const [items, setItems] = useState<readonly ContentItem[]>([]);
  const [leads, setLeads] = useState<readonly LeadItem[]>([]);
  const [media, setMedia] = useState<readonly MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ContentForm>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await erpFetch<{ readonly items: readonly ContentItem[] }>('/api/marketing-cms/contents');
      setItems(result.data.items);
      try {
        const leadResult = await erpFetch<{ readonly items: readonly LeadItem[] }>('/api/marketing-cms/leads');
        setLeads(leadResult.data.items);
      } catch {
        setLeads([]);
      }
      try {
        const mediaResult = await erpFetch<{ readonly items: readonly MediaItem[] }>('/api/marketing-cms/media');
        setMedia(mediaResult.data.items);
      } catch {
        setMedia([]);
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : '内容列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const counts = useMemo(() => ({
    all: items.length,
    review: items.filter((item) => item.status === 'in_review').length,
    live: items.filter((item) => item.status === 'published').length,
    untranslated: items.filter((item) => item.locale === 'zh-CN' &&
      !items.some((candidate) => candidate.locale === 'en' && candidate.type === item.type && candidate.slug === item.slug)).length,
  }), [items]);

  async function create(values: ContentForm) {
    setSaving(true);
    setError(null);
    try {
      await erpFetch('/api/marketing-cms/contents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey('marketing.create') },
        body: JSON.stringify({
          siteId: values.siteId, type: values.type, locale: values.locale,
          slug: values.slug, title: values.title, summary: values.summary ?? '',
          blocks: [{ type: 'hero', data: { title: values.heroTitle, body: values.heroBody } }],
          seo: { title: values.seoTitle ?? values.title, description: values.seoDescription ?? values.summary ?? '' },
        }),
      });
      setOpen(false);
      form.resetFields();
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : '内容创建失败');
    } finally {
      setSaving(false);
    }
  }

  async function action(item: ContentItem, name: 'submit' | 'approve' | 'publish' | 'withdraw' | 'restore') {
    setError(null);
    try {
      await erpFetch(`/api/marketing-cms/contents/${item.id}/${name}`, {
        method: 'POST',
        headers: {
          'if-match': strongEtag(item.version),
          'idempotency-key': createIdempotencyKey(`marketing.${name}`),
        },
      });
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : '状态操作失败');
    }
  }

  async function aiTranslate(item: ContentItem) {
    setError(null);
    try {
      const result = await erpFetch<{ readonly id: string; readonly output: Readonly<Record<string, unknown>> }>(
        `/api/marketing-cms/contents/${item.id}/ai-drafts`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'translate', targetLocale: item.locale === 'zh-CN' ? 'en' : 'zh-CN',
            instruction: '保持品牌语气与事实，不增加未经证实的数据。',
          }),
        },
      );
      Modal.confirm({
        title: 'AI 草稿已生成，尚未发布',
        width: 720,
        content: <pre className="console-ai-preview">{JSON.stringify(result.data.output, null, 2)}</pre>,
        okText: '人工确认接受',
        cancelText: '拒绝草稿',
        onOk: () => erpFetch(`/api/marketing-cms/ai-drafts/${result.data.id}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'accepted' }),
        }),
        onCancel: () => void erpFetch(`/api/marketing-cms/ai-drafts/${result.data.id}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'rejected' }),
        }),
      });
    } catch (value) {
      setError(value instanceof Error ? value.message : 'AI 草稿生成失败');
    }
  }

  async function schedule(item: ContentItem) {
    const value = window.prompt('请输入 ISO 8601 发布时间，例如 2026-08-01T09:00:00+08:00');
    if (value === null) return;
    try {
      await erpFetch(`/api/marketing-cms/contents/${item.id}/schedule`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'if-match': strongEtag(item.version),
          'idempotency-key': createIdempotencyKey('marketing.schedule'),
        },
        body: JSON.stringify({ scheduledAt: value }),
      });
      await load();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : '排期失败');
    }
  }

  async function rollback(item: ContentItem) {
    const value = window.prompt(`请输入要恢复的 revision（当前 r${item.revision}）`);
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 1) return;
    try {
      await erpFetch(`/api/marketing-cms/contents/${item.id}/rollback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'if-match': strongEtag(item.version),
          'idempotency-key': createIdempotencyKey('marketing.rollback'),
        },
        body: JSON.stringify({ revision }),
      });
      await load();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : '回滚失败');
    }
  }

  async function updateLead(item: LeadItem, status: string) {
    try {
      await erpFetch(`/api/marketing-cms/leads/${item.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': strongEtag(item.version) },
        body: JSON.stringify({ status }),
      });
      await load();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : '线索状态更新失败');
    }
  }

  async function uploadMedia(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setSaving(true);
    try {
      const ticket = await erpFetch<{ readonly id: string; readonly uploadUrl: string; readonly version: number }>(
        '/api/marketing-cms/media/uploads',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            siteId: 'gaoq', fileName: file.name, mimeType: file.type,
            sizeBytes: file.size, altText: {}, copyrightSource: '',
          }),
        },
      );
      const uploaded = await fetch(ticket.data.uploadUrl, {
        method: 'PUT', headers: { 'content-type': file.type }, body: file,
      });
      if (!uploaded.ok) throw new Error('对象存储上传失败');
      await erpFetch(`/api/marketing-cms/media/${ticket.data.id}/verify`, {
        method: 'POST', headers: { 'if-match': strongEtag(ticket.data.version) },
      });
      await load();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : '媒体上传失败');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    { title: '内容', dataIndex: 'title', render: (_: string, item: ContentItem) => (
      <Space direction="vertical" size={0}><Text strong>{item.title}</Text><Text type="secondary">/{item.slug} · {item.type}</Text></Space>
    ) },
    { title: '语言', dataIndex: 'locale', width: 90, render: (value: Locale) => <Tag>{value}</Tag> },
    { title: '状态', dataIndex: 'status', width: 100, render: (value: ContentStatus) => <Tag color={STATUS[value].color}>{STATUS[value].text}</Tag> },
    { title: '版本', dataIndex: 'revision', width: 80, render: (value: number) => `r${value}` },
    { title: '操作', key: 'actions', width: 260, render: (_: unknown, item: ContentItem) => (
      <Space wrap>
        {item.status === 'draft' ? <Button size="small" onClick={() => void action(item, 'submit')}>送审</Button> : null}
        {item.status === 'in_review' ? <Button size="small" onClick={() => void action(item, 'approve')}>批准</Button> : null}
        {item.status === 'approved' ? <Button size="small" type="primary" onClick={() => void action(item, 'publish')}>发布</Button> : null}
        {item.status === 'approved' ? <Button size="small" onClick={() => void schedule(item)}>排期</Button> : null}
        {item.status === 'published' ? <Button size="small" danger onClick={() => void action(item, 'withdraw')}>撤回</Button> : null}
        {item.status === 'archived' ? <Button size="small" onClick={() => void action(item, 'restore')}>恢复草稿</Button> : null}
        <Button size="small" onClick={() => void aiTranslate(item)}>AI 草稿</Button>
        {item.revision > 1 ? <Button size="small" onClick={() => void rollback(item)}>回滚</Button> : null}
      </Space>
    ) },
  ];
  const leadColumns = [
    { title: '客户', dataIndex: 'name', render: (_: string, item: LeadItem) => (
      <Space direction="vertical" size={0}><Text strong>{item.name}</Text><Text type="secondary">{item.contact}</Text></Space>
    ) },
    { title: '类型', dataIndex: 'audience', render: (value: string) => <Tag>{value === 'creator' ? '创作者' : '品牌方'}</Tag> },
    { title: '需求', dataIndex: 'requestSummary', ellipsis: true },
    { title: '状态', dataIndex: 'status', render: (value: string) => <Tag color="blue">{value}</Tag> },
    { title: '操作', render: (_: unknown, item: LeadItem) => <Space>
      <Button size="small" onClick={() => void updateLead(item, 'contacted')}>已联系</Button>
      <Button size="small" onClick={() => void updateLead(item, 'qualified')}>有效</Button>
      <Button size="small" onClick={() => void updateLead(item, 'closed')}>关闭</Button>
    </Space> },
  ];

  return <main aria-labelledby="marketing-title">
    <div className="console-page-heading">
      <Space direction="vertical" size={4}>
        <Text type="secondary">GaoQ-OS / Marketing CMS</Text>
        <Title id="marketing-title" level={1}>官网内容运营</Title>
        <Paragraph>管理中英文官网内容、审核发布与版本。公开站点只读取已发布版本。</Paragraph>
      </Space>
    </div>
    {error !== null ? <Alert className="console-alert" type="error" showIcon message={error} closable onClose={() => setError(null)} /> : null}
    <Row gutter={[16, 16]} className="console-stat-row">
      <Col xs={12} xl={6}><Card><Statistic title="全部内容" value={counts.all} /></Card></Col>
      <Col xs={12} xl={6}><Card><Statistic title="待审核" value={counts.review} /></Card></Col>
      <Col xs={12} xl={6}><Card><Statistic title="已发布" value={counts.live} /></Card></Col>
      <Col xs={12} xl={6}><Card><Statistic title="待补英文" value={counts.untranslated} /></Card></Col>
    </Row>
    <Tabs items={[
      {
        key: 'contents', label: '内容库',
        children: <Card bordered={false} extra={<Button type="primary" onClick={() => setOpen(true)}>新建内容</Button>}>
          <Table rowKey="id" columns={columns} dataSource={[...items]} loading={loading} scroll={{ x: 1080 }} />
        </Card>,
      },
      {
        key: 'leads', label: `预约线索 (${leads.length})`,
        children: <Card bordered={false}><Table rowKey="id" columns={leadColumns} dataSource={[...leads]} scroll={{ x: 900 }} /></Card>,
      },
      {
        key: 'media', label: `媒体库 (${media.length})`,
        children: <Card bordered={false} extra={
          <Button loading={saving} onClick={() => document.getElementById('cms-media-input')?.click()}>
            上传并扫描
          </Button>
        }>
          <input id="cms-media-input" hidden type="file"
            accept="image/jpeg,image/png,image/webp,image/avif,application/pdf"
            onChange={(event) => void uploadMedia(event)} />
          <Table rowKey="id" dataSource={[...media]} columns={[
            { title: '文件', dataIndex: 'fileName' },
            { title: '类型', dataIndex: 'mimeType' },
            { title: '状态', dataIndex: 'status', render: (value: string) => <Tag color={value === 'ready' ? 'success' : 'processing'}>{value}</Tag> },
            { title: '衍生规格', dataIndex: 'variants', render: (value: Readonly<Record<string, string>>) => Object.keys(value).join('、') || '—' },
          ]} />
        </Card>,
      },
    ]} />
    <Modal title="新建受控内容" open={open} onCancel={() => setOpen(false)} footer={null} width={760} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={(values) => void create(values)}
        initialValues={{ siteId: 'gaoq', type: 'page', locale: 'zh-CN' }}>
        <Row gutter={16}>
          <Col span={8}><Form.Item name="siteId" label="站点" rules={[{ required: true }]}><Input /></Form.Item></Col>
          <Col span={8}><Form.Item name="type" label="类型" rules={[{ required: true }]}><Select options={[
            'page', 'service', 'case', 'article', 'team', 'testimonial', 'faq', 'navigation', 'footer', 'site_config',
          ].map((value) => ({ value, label: value }))} /></Form.Item></Col>
          <Col span={8}><Form.Item name="locale" label="语言" rules={[{ required: true }]}><Select options={[
            { value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' },
          ]} /></Form.Item></Col>
        </Row>
        <Form.Item name="slug" label="Slug" rules={[{ required: true, pattern: /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/u }]}><Input placeholder="creator-services" /></Form.Item>
        <Form.Item name="title" label="内容标题" rules={[{ required: true, max: 160 }]}><Input /></Form.Item>
        <Form.Item name="summary" label="摘要" rules={[{ max: 500 }]}><Input.TextArea rows={2} /></Form.Item>
        <Form.Item name="heroTitle" label="首屏标题" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="heroBody" label="首屏正文" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
        <Row gutter={16}>
          <Col span={12}><Form.Item name="seoTitle" label="SEO 标题"><Input /></Form.Item></Col>
          <Col span={12}><Form.Item name="seoDescription" label="SEO 描述"><Input /></Form.Item></Col>
        </Row>
        <Button type="primary" htmlType="submit" loading={saving}>保存草稿</Button>
      </Form>
    </Modal>
  </main>;
}
