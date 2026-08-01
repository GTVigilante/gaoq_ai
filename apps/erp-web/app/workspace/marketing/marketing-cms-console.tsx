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
import type { ColumnsType } from 'antd/es/table';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

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
  buildMarketingContentInput,
  canRetryMarketingWrite,
  hasMarketingPermission,
  marketingPermissions,
  parseMarketingAiDraft,
  parseMarketingAiReview,
  parseMarketingContentList,
  parseMarketingContentMutation,
  parseMarketingLeadList,
  parseMarketingLeadMutation,
  parseMarketingMediaList,
  parseMarketingMediaMutation,
  parseMarketingUploadTicket,
  type MarketingAiDraftView,
  type MarketingContentFormValue,
  type MarketingContentStatus,
  type MarketingContentSummary,
  type MarketingLeadStatus,
  type MarketingLeadView,
  type MarketingLocale,
  type MarketingMediaView,
  type MarketingUploadTicket,
} from '../../lib/marketing-cms-contract';

const { Title, Paragraph, Text } = Typography;

type RestWriteKind =
  | 'content-create'
  | 'content-transition'
  | 'content-schedule'
  | 'content-rollback'
  | 'lead-status'
  | 'ai-generate'
  | 'ai-review';

interface PendingRestWrite {
  readonly actorId: string;
  readonly requiredScope: string;
  readonly kind: RestWriteKind;
  readonly label: string;
  readonly path: string;
  readonly method: 'POST' | 'PATCH';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly targetId?: string;
  readonly expectedStatus?: string;
  readonly expectedVersion?: number;
}

interface PendingMediaWrite {
  readonly actorId: string;
  readonly requiredScope: string;
  readonly file: File;
  readonly metadata: Readonly<{
    siteId: 'gaoq';
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    altText: Readonly<Record<string, string>>;
    copyrightSource: string;
  }>;
  readonly createKey: string;
  readonly verifyKey: string;
  readonly stage: 'ticket' | 'upload' | 'verify';
  readonly ticket?: MarketingUploadTicket;
}

const STATUS: Readonly<Record<
  MarketingContentStatus,
  { readonly text: string; readonly color: string }
>> = {
  draft: { text: '草稿', color: 'default' },
  in_review: { text: '审核中', color: 'processing' },
  approved: { text: '已批准', color: 'cyan' },
  scheduled: { text: '已排期', color: 'purple' },
  published: { text: '已发布', color: 'success' },
  archived: { text: '已归档', color: 'warning' },
};

const TRANSITION: Readonly<Record<
  'submit' | 'approve' | 'publish' | 'withdraw' | 'restore',
  { readonly scope: string; readonly status: MarketingContentStatus; readonly label: string }
>> = {
  submit: {
    scope: marketingPermissions.contentSubmit,
    status: 'in_review',
    label: '内容送审',
  },
  approve: {
    scope: marketingPermissions.contentApprove,
    status: 'approved',
    label: '内容批准',
  },
  publish: {
    scope: marketingPermissions.contentPublish,
    status: 'published',
    label: '内容发布',
  },
  withdraw: {
    scope: marketingPermissions.contentPublish,
    status: 'archived',
    label: '内容撤回',
  },
  restore: {
    scope: marketingPermissions.contentUpdate,
    status: 'draft',
    label: '恢复草稿',
  },
};

/** 营销 CMS 管理台：可信授权、最小响应契约与同键重试共同约束全部写入。 */
export function MarketingCmsConsole() {
  const [items, setItems] = useState<readonly MarketingContentSummary[]>([]);
  const [leads, setLeads] = useState<readonly MarketingLeadView[]>([]);
  const [media, setMedia] = useState<readonly MarketingMediaView[]>([]);
  const [profile, setProfile] = useState<IdentityProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [aiDraft, setAiDraft] = useState<MarketingAiDraftView | null>(null);
  const [pendingRest, setPendingRest] = useState<PendingRestWrite | null>(null);
  const [pendingMedia, setPendingMedia] = useState<PendingMediaWrite | null>(null);
  const [form] = Form.useForm<MarketingContentFormValue>();
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setError(null);
    setItems([]);
    setLeads([]);
    setMedia([]);
    setProfile(null);
    try {
      const profileResult = await erpFetch<unknown>('/api/auth/profile');
      const nextProfile = parseIdentityProfile(profileResult.data);
      const reads = await Promise.all([
        nextProfile.scopes.includes(marketingPermissions.contentRead)
          ? erpFetch<unknown>('/api/marketing-cms/contents')
          : Promise.resolve(null),
        nextProfile.scopes.includes(marketingPermissions.leadRead)
          ? erpFetch<unknown>('/api/marketing-cms/leads')
          : Promise.resolve(null),
        nextProfile.scopes.includes(marketingPermissions.mediaRead)
          ? erpFetch<unknown>('/api/marketing-cms/media')
          : Promise.resolve(null),
      ]);
      if (generation !== loadGeneration.current) return;
      setProfile(nextProfile);
      setItems(reads[0] === null ? [] : parseMarketingContentList(reads[0].data));
      setLeads(reads[1] === null ? [] : parseMarketingLeadList(reads[1].data));
      setMedia(reads[2] === null ? [] : parseMarketingMediaList(reads[2].data));
    } catch (value) {
      if (generation !== loadGeneration.current) return;
      setError(errorMessage(value, '营销管理数据加载失败'));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load]);

  useEffect(() => {
    setPendingRest((current) =>
      current !== null &&
      !canRetryMarketingWrite(profile, current.actorId, current.requiredScope)
        ? null
        : current);
    setPendingMedia((current) =>
      current !== null &&
      !canRetryMarketingWrite(profile, current.actorId, current.requiredScope)
        ? null
        : current);
  }, [profile]);

  const counts = useMemo(() => ({
    all: items.length,
    review: items.filter((item) => item.status === 'in_review').length,
    live: items.filter((item) => item.status === 'published').length,
    untranslated: items.filter((item) =>
      item.locale === 'zh-CN' &&
      !items.some((candidate) =>
        candidate.locale === 'en' &&
        candidate.type === item.type &&
        candidate.slug === item.slug)).length,
  }), [items]);

  const hasPendingWrite = pendingRest !== null || pendingMedia !== null;

  async function executeRest(attempt: PendingRestWrite): Promise<void> {
    if (!canRetryMarketingWrite(profile, attempt.actorId, attempt.requiredScope)) {
      if (profile !== null) setPendingRest(null);
      setError(profile === null
        ? '请先刷新并确认当前身份，再重试原请求。'
        : '当前身份或授权已变化，原请求已清除。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await erpFetch<unknown>(attempt.path, {
        method: attempt.method,
        headers: attempt.headers,
        ...(attempt.body === undefined ? {} : { body: attempt.body }),
      });
      validateRestResult(attempt, result.data);
      setPendingRest(null);
      if (attempt.kind === 'content-create') {
        setCreateOpen(false);
        form.resetFields();
      }
      if (attempt.kind === 'ai-generate') {
        setAiDraft(parseMarketingAiDraft(result.data));
      } else if (attempt.kind === 'ai-review') {
        setAiDraft(null);
      } else {
        await load();
      }
    } catch (value) {
      const definitive = isDefinitiveWriteRejection(value);
      if (definitive) setPendingRest(null);
      setError(writeErrorMessage(value, `${attempt.label}失败`, !definitive));
    } finally {
      setSaving(false);
    }
  }

  async function createContent(values: MarketingContentFormValue): Promise<void> {
    if (
      profile === null ||
      !hasMarketingPermission(
        profile,
        marketingPermissions.contentCreate,
        marketingPermissions.contentRead,
      ) ||
      hasPendingWrite
    ) return;
    let input;
    try {
      input = buildMarketingContentInput(values);
    } catch {
      setError('内容字段不符合受控长度、格式或安全要求。');
      return;
    }
    const attempt = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.contentCreate,
      kind: 'content-create' as const,
      label: '内容创建',
      path: '/api/marketing-cms/contents',
      method: 'POST' as const,
      headers: Object.freeze({
        'content-type': 'application/json',
        'idempotency-key': createIdempotencyKey('marketing.create'),
      }),
      body: JSON.stringify(input),
      expectedStatus: 'draft',
      expectedVersion: 1,
    });
    setPendingRest(attempt);
    await executeRest(attempt);
  }

  async function transitionContent(
    item: MarketingContentSummary,
    name: keyof typeof TRANSITION,
  ): Promise<void> {
    const rule = TRANSITION[name];
    if (
      profile === null ||
      !hasMarketingPermission(profile, rule.scope, marketingPermissions.contentRead) ||
      hasPendingWrite
    ) return;
    const attempt = Object.freeze({
      actorId: profile.actorId,
      requiredScope: rule.scope,
      kind: 'content-transition' as const,
      label: rule.label,
      path: `/api/marketing-cms/contents/${item.id}/${name}`,
      method: 'POST' as const,
      headers: Object.freeze({
        'if-match': strongEtag(item.version),
        'idempotency-key': createIdempotencyKey(`marketing.${name}`),
      }),
      targetId: item.id,
      expectedStatus: rule.status,
      expectedVersion: item.version + 1,
    });
    setPendingRest(attempt);
    await executeRest(attempt);
  }

  async function scheduleContent(item: MarketingContentSummary): Promise<void> {
    if (
      profile === null ||
      !hasMarketingPermission(
        profile,
        marketingPermissions.contentPublish,
        marketingPermissions.contentRead,
      ) ||
      hasPendingWrite
    ) return;
    const value = window.prompt('请输入 ISO 8601 发布时间，例如 2026-08-01T09:00:00+08:00');
    if (value === null) return;
    const scheduledAt = canonicalFutureSchedule(value);
    if (scheduledAt === null) {
      setError('发布时间必须是未来 1 分钟至 366 天内的有效 ISO 8601 时间。');
      return;
    }
    const attempt = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.contentPublish,
      kind: 'content-schedule' as const,
      label: '内容排期',
      path: `/api/marketing-cms/contents/${item.id}/schedule`,
      method: 'POST' as const,
      headers: Object.freeze({
        'content-type': 'application/json',
        'if-match': strongEtag(item.version),
        'idempotency-key': createIdempotencyKey('marketing.schedule'),
      }),
      body: JSON.stringify({ scheduledAt }),
      targetId: item.id,
      expectedStatus: 'scheduled',
      expectedVersion: item.version + 1,
    });
    setPendingRest(attempt);
    await executeRest(attempt);
  }

  async function rollbackContent(item: MarketingContentSummary): Promise<void> {
    if (
      profile === null ||
      !hasMarketingPermission(
        profile,
        marketingPermissions.contentRollback,
        marketingPermissions.contentRead,
      ) ||
      hasPendingWrite
    ) return;
    const value = window.prompt(`请输入要恢复的 revision（当前 r${item.revision}）`);
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision >= item.revision) {
      setError('回滚版本必须是小于当前版本的正整数。');
      return;
    }
    const attempt = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.contentRollback,
      kind: 'content-rollback' as const,
      label: '内容回滚',
      path: `/api/marketing-cms/contents/${item.id}/rollback`,
      method: 'POST' as const,
      headers: Object.freeze({
        'content-type': 'application/json',
        'if-match': strongEtag(item.version),
        'idempotency-key': createIdempotencyKey('marketing.rollback'),
      }),
      body: JSON.stringify({ revision }),
      targetId: item.id,
      expectedStatus: 'draft',
      expectedVersion: item.version + 1,
    });
    setPendingRest(attempt);
    await executeRest(attempt);
  }

  async function updateLead(
    item: MarketingLeadView,
    status: MarketingLeadStatus,
  ): Promise<void> {
    if (
      profile === null ||
      !hasMarketingPermission(
        profile,
        marketingPermissions.leadUpdate,
        marketingPermissions.leadRead,
      ) ||
      hasPendingWrite
    ) return;
    const attempt = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.leadUpdate,
      kind: 'lead-status' as const,
      label: '线索状态更新',
      path: `/api/marketing-cms/leads/${item.id}/status`,
      method: 'PATCH' as const,
      headers: Object.freeze({
        'content-type': 'application/json',
        'if-match': strongEtag(item.version),
        'idempotency-key': createIdempotencyKey('marketing.lead.status'),
      }),
      body: JSON.stringify({ status }),
      targetId: item.id,
      expectedStatus: status,
      expectedVersion: item.version + 1,
    });
    setPendingRest(attempt);
    await executeRest(attempt);
  }

  async function generateAiDraft(item: MarketingContentSummary): Promise<void> {
    if (
      profile === null ||
      !hasMarketingPermission(
        profile,
        marketingPermissions.aiGenerate,
        marketingPermissions.contentRead,
      ) ||
      hasPendingWrite
    ) return;
    const attempt = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.aiGenerate,
      kind: 'ai-generate' as const,
      label: 'AI 草稿生成',
      path: `/api/marketing-cms/contents/${item.id}/ai-drafts`,
      method: 'POST' as const,
      headers: Object.freeze({
        'content-type': 'application/json',
        'idempotency-key': createIdempotencyKey('marketing.ai.generate'),
      }),
      body: JSON.stringify({
        action: 'translate',
        targetLocale: item.locale === 'zh-CN' ? 'en' : 'zh-CN',
        instruction: '保持品牌语气与事实，不增加未经证实的数据。',
      }),
      targetId: item.id,
      expectedStatus: 'pending_review',
    });
    setPendingRest(attempt);
    await executeRest(attempt);
  }

  async function reviewAiDraft(decision: 'accepted' | 'rejected'): Promise<void> {
    if (
      aiDraft === null ||
      profile === null ||
      !hasMarketingPermission(profile, marketingPermissions.aiReview) ||
      hasPendingWrite
    ) return;
    const attempt = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.aiReview,
      kind: 'ai-review' as const,
      label: 'AI 草稿人工复核',
      path: `/api/marketing-cms/ai-drafts/${aiDraft.id}/review`,
      method: 'POST' as const,
      headers: Object.freeze({
        'content-type': 'application/json',
        'idempotency-key': createIdempotencyKey('marketing.ai.review'),
      }),
      body: JSON.stringify({ decision }),
      targetId: aiDraft.id,
      expectedStatus: decision,
    });
    setPendingRest(attempt);
    await executeRest(attempt);
  }

  async function uploadMedia(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined || profile === null || hasPendingWrite) return;
    if (
      !hasMarketingPermission(
        profile,
        marketingPermissions.mediaCreate,
        marketingPermissions.mediaRead,
      )
    ) return;
    if (
      !['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf']
        .includes(file.type) ||
      file.size < 1 ||
      file.size > 20_971_520 ||
      file.name.length < 1 ||
      file.name.length > 180 ||
      /[/\\\0]/u.test(file.name)
    ) {
      setError('媒体文件类型、名称或大小不符合要求（上限 20 MiB）。');
      return;
    }
    const attempt: PendingMediaWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.mediaCreate,
      file,
      metadata: Object.freeze({
        siteId: 'gaoq',
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        altText: Object.freeze({}),
        copyrightSource: '',
      }),
      createKey: createIdempotencyKey('marketing.media.create'),
      verifyKey: createIdempotencyKey('marketing.media.verify'),
      stage: 'ticket',
    });
    setPendingMedia(attempt);
    await executeMedia(attempt);
  }

  async function executeMedia(attempt: PendingMediaWrite): Promise<void> {
    if (!canRetryMarketingWrite(profile, attempt.actorId, attempt.requiredScope)) {
      if (profile !== null) setPendingMedia(null);
      setError(profile === null
        ? '请先刷新并确认当前身份，再重试原媒体请求。'
        : '当前身份或授权已变化，原媒体请求已清除。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let current = attempt;
      if (current.stage === 'ticket') {
        const result = await erpFetch<unknown>('/api/marketing-cms/media/uploads', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': current.createKey,
          },
          body: JSON.stringify(current.metadata),
        });
        const ticket = parseMarketingUploadTicket(result.data);
        current = Object.freeze({ ...current, stage: 'upload' as const, ticket });
        setPendingMedia(current);
      }
      if (current.stage === 'upload') {
        if (current.ticket === undefined) throw new Error('MARKETING_UPLOAD_STATE_INVALID');
        const response = await fetch(current.ticket.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': current.file.type },
          body: current.file,
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            setPendingMedia(Object.freeze({
              actorId: current.actorId,
              requiredScope: current.requiredScope,
              file: current.file,
              metadata: current.metadata,
              createKey: current.createKey,
              verifyKey: current.verifyKey,
              stage: 'ticket',
            }));
          }
          throw new Error('对象存储上传未完成');
        }
        current = Object.freeze({ ...current, stage: 'verify' as const });
        setPendingMedia(current);
      }
      if (current.stage === 'verify') {
        if (current.ticket === undefined) throw new Error('MARKETING_UPLOAD_STATE_INVALID');
        const result = await erpFetch<unknown>(
          `/api/marketing-cms/media/${current.ticket.id}/verify`,
          {
            method: 'POST',
            headers: {
              'if-match': strongEtag(current.ticket.version),
              'idempotency-key': current.verifyKey,
            },
          },
        );
        const verified = parseMarketingMediaMutation(result.data);
        if (
          verified.id !== current.ticket.id ||
          verified.status !== 'ready' ||
          verified.version !== current.ticket.version + 1
        ) throw new Error('MARKETING_MEDIA_VERIFY_RESULT_MISMATCH');
        setPendingMedia(null);
        await load();
      }
    } catch (value) {
      const definitive = isDefinitiveWriteRejection(value);
      if (definitive) setPendingMedia(null);
      setError(writeErrorMessage(value, '媒体上传失败', !definitive));
    } finally {
      setSaving(false);
    }
  }

  const canCreateContent = hasMarketingPermission(
    profile,
    marketingPermissions.contentCreate,
    marketingPermissions.contentRead,
  );
  const canUpdateLead = hasMarketingPermission(
    profile,
    marketingPermissions.leadUpdate,
    marketingPermissions.leadRead,
  );
  const canUploadMedia = hasMarketingPermission(
    profile,
    marketingPermissions.mediaCreate,
    marketingPermissions.mediaRead,
  );
  const canReviewAi = hasMarketingPermission(profile, marketingPermissions.aiReview);

  const columns: ColumnsType<MarketingContentSummary> = [
    {
      title: '内容',
      dataIndex: 'title',
      render: (_, item) => (
        <Space direction="vertical" size={0}>
          <Text strong>{item.title}</Text>
          <Text type="secondary">/{item.slug} · {item.type}</Text>
        </Space>
      ),
    },
    {
      title: '语言',
      dataIndex: 'locale',
      width: 90,
      render: (value: MarketingLocale) => <Tag>{value}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: MarketingContentStatus) => (
        <Tag color={STATUS[value].color}>{STATUS[value].text}</Tag>
      ),
    },
    {
      title: '版本',
      dataIndex: 'revision',
      width: 80,
      render: (value: number) => `r${value}`,
    },
    {
      title: '操作',
      key: 'actions',
      width: 300,
      render: (_, item) => (
        <Space wrap>
          {item.status === 'draft' &&
          hasMarketingPermission(
            profile,
            marketingPermissions.contentSubmit,
            marketingPermissions.contentRead,
          )
            ? <Button size="small" disabled={hasPendingWrite}
                onClick={() => void transitionContent(item, 'submit')}>送审</Button>
            : null}
          {item.status === 'in_review' &&
          hasMarketingPermission(
            profile,
            marketingPermissions.contentApprove,
            marketingPermissions.contentRead,
          )
            ? <Button size="small" disabled={hasPendingWrite}
                onClick={() => void transitionContent(item, 'approve')}>批准</Button>
            : null}
          {item.status === 'approved' &&
          hasMarketingPermission(
            profile,
            marketingPermissions.contentPublish,
            marketingPermissions.contentRead,
          )
            ? <>
                <Button size="small" type="primary" disabled={hasPendingWrite}
                  onClick={() => void transitionContent(item, 'publish')}>发布</Button>
                <Button size="small" disabled={hasPendingWrite}
                  onClick={() => void scheduleContent(item)}>排期</Button>
              </>
            : null}
          {item.status === 'published' &&
          hasMarketingPermission(
            profile,
            marketingPermissions.contentPublish,
            marketingPermissions.contentRead,
          )
            ? <Button size="small" danger disabled={hasPendingWrite}
                onClick={() => void transitionContent(item, 'withdraw')}>撤回</Button>
            : null}
          {item.status === 'archived' &&
          hasMarketingPermission(
            profile,
            marketingPermissions.contentUpdate,
            marketingPermissions.contentRead,
          )
            ? <Button size="small" disabled={hasPendingWrite}
                onClick={() => void transitionContent(item, 'restore')}>恢复草稿</Button>
            : null}
          {hasMarketingPermission(
            profile,
            marketingPermissions.aiGenerate,
            marketingPermissions.contentRead,
          )
            ? <Button size="small" disabled={hasPendingWrite}
                onClick={() => void generateAiDraft(item)}>AI 草稿</Button>
            : null}
          {item.revision > 1 &&
          hasMarketingPermission(
            profile,
            marketingPermissions.contentRollback,
            marketingPermissions.contentRead,
          )
            ? <Button size="small" disabled={hasPendingWrite}
                onClick={() => void rollbackContent(item)}>回滚</Button>
            : null}
        </Space>
      ),
    },
  ];

  const leadColumns: ColumnsType<MarketingLeadView> = [
    {
      title: '客户',
      dataIndex: 'name',
      render: (_, item) => (
        <Space direction="vertical" size={0}>
          <Text strong>{item.name}</Text>
          <Text type="secondary">{item.contact}</Text>
        </Space>
      ),
    },
    {
      title: '类型',
      dataIndex: 'audience',
      render: (value: MarketingLeadView['audience']) => (
        <Tag>{value === 'creator' ? '创作者' : '品牌方'}</Tag>
      ),
    },
    { title: '需求', dataIndex: 'requestSummary', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: MarketingLeadStatus) => <Tag color="blue">{value}</Tag>,
    },
    ...(canUpdateLead
      ? [{
          title: '操作',
          render: (_: unknown, item: MarketingLeadView) => (
            <Space>
              <Button size="small" disabled={hasPendingWrite}
                onClick={() => void updateLead(item, 'contacted')}>已联系</Button>
              <Button size="small" disabled={hasPendingWrite}
                onClick={() => void updateLead(item, 'qualified')}>有效</Button>
              <Button size="small" disabled={hasPendingWrite}
                onClick={() => void updateLead(item, 'closed')}>关闭</Button>
            </Space>
          ),
        }]
      : []),
  ];

  return <main aria-labelledby="marketing-title">
    <div className="console-page-heading">
      <Space direction="vertical" size={4}>
        <Text type="secondary">GaoQ-OS / Marketing CMS</Text>
        <Title id="marketing-title" level={1}>官网内容运营</Title>
        <Paragraph>管理中英文官网内容、人工审核发布与受控版本；所有写入支持原请求同键重试。</Paragraph>
      </Space>
    </div>
    {error !== null
      ? <Alert
          className="console-alert"
          type="error"
          showIcon
          message={error}
          action={hasPendingWrite
            ? <Button size="small" loading={saving}
                onClick={() => {
                  if (pendingRest !== null) void executeRest(pendingRest);
                  else if (pendingMedia !== null) void executeMedia(pendingMedia);
                }}>
                重试原请求
              </Button>
            : undefined}
          closable={!hasPendingWrite}
          onClose={() => setError(null)}
        />
      : null}
    <Row gutter={[16, 16]} className="console-stat-row">
      <Col xs={12} xl={6}><Card><Statistic title="全部内容" value={counts.all} /></Card></Col>
      <Col xs={12} xl={6}><Card><Statistic title="待审核" value={counts.review} /></Card></Col>
      <Col xs={12} xl={6}><Card><Statistic title="已发布" value={counts.live} /></Card></Col>
      <Col xs={12} xl={6}><Card><Statistic title="待补英文" value={counts.untranslated} /></Card></Col>
    </Row>
    <Tabs items={[
      ...(profile?.scopes.includes(marketingPermissions.contentRead) === true
        ? [{
            key: 'contents',
            label: '内容库',
            children: <Card bordered={false} extra={canCreateContent
              ? <Button type="primary" disabled={hasPendingWrite}
                  onClick={() => setCreateOpen(true)}>新建内容</Button>
              : null}>
              <Table
                rowKey="id"
                columns={columns}
                dataSource={[...items]}
                loading={loading}
                scroll={{ x: 1_080 }}
              />
            </Card>,
          }]
        : []),
      ...(profile?.scopes.includes(marketingPermissions.leadRead) === true
        ? [{
            key: 'leads',
            label: `预约线索 (${leads.length})`,
            children: <Card bordered={false}>
              <Table rowKey="id" columns={leadColumns} dataSource={[...leads]} scroll={{ x: 900 }} />
            </Card>,
          }]
        : []),
      ...(profile?.scopes.includes(marketingPermissions.mediaRead) === true
        ? [{
            key: 'media',
            label: `媒体库 (${media.length})`,
            children: <Card bordered={false} extra={canUploadMedia
              ? <Button loading={saving && pendingMedia !== null} disabled={hasPendingWrite}
                  onClick={() => document.getElementById('cms-media-input')?.click()}>
                  上传并扫描
                </Button>
              : null}>
              {canUploadMedia
                ? <input
                    id="cms-media-input"
                    hidden
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/avif,application/pdf"
                    onChange={(event) => void uploadMedia(event)}
                  />
                : null}
              <Table
                rowKey="id"
                dataSource={[...media]}
                columns={[
                  { title: '文件', dataIndex: 'fileName' },
                  { title: '类型', dataIndex: 'mimeType' },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    render: (value: MarketingMediaView['status']) => (
                      <Tag color={value === 'ready' ? 'success' : 'processing'}>{value}</Tag>
                    ),
                  },
                  {
                    title: '衍生规格',
                    dataIndex: 'variants',
                    render: (value: Readonly<Record<string, string>>) =>
                      Object.keys(value).join('、') || '—',
                  },
                ]}
              />
            </Card>,
          }]
        : []),
    ]} />
    {profile !== null &&
    !profile.scopes.some((scope) => new Set<string>([
      marketingPermissions.contentRead,
      marketingPermissions.leadRead,
      marketingPermissions.mediaRead,
    ]).has(scope))
      ? <Alert type="info" showIcon message="当前身份没有营销管理读取权限。" />
      : null}
    <Modal
      title="新建受控内容"
      open={createOpen}
      onCancel={() => {
        if (!hasPendingWrite) setCreateOpen(false);
      }}
      closable={!hasPendingWrite}
      maskClosable={!hasPendingWrite}
      footer={null}
      width={760}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => void createContent(values)}
        initialValues={{ siteId: 'gaoq', type: 'page', locale: 'zh-CN' }}
      >
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="siteId" label="站点" rules={[{ required: true, max: 128 }]}>
              <Input disabled={hasPendingWrite} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="type" label="类型" rules={[{ required: true }]}>
              <Select disabled={hasPendingWrite} options={[
                'page', 'service', 'case', 'article', 'team', 'testimonial',
                'faq', 'navigation', 'footer', 'site_config',
              ].map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="locale" label="语言" rules={[{ required: true }]}>
              <Select disabled={hasPendingWrite} options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en', label: 'English' },
              ]} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="slug"
          label="Slug"
          rules={[{ required: true, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, max: 160 }]}
        >
          <Input disabled={hasPendingWrite} placeholder="creator-services" />
        </Form.Item>
        <Form.Item name="title" label="内容标题" rules={[{ required: true, max: 160 }]}>
          <Input disabled={hasPendingWrite} />
        </Form.Item>
        <Form.Item name="summary" label="摘要" rules={[{ max: 500 }]}>
          <Input.TextArea disabled={hasPendingWrite} rows={2} />
        </Form.Item>
        <Form.Item name="heroTitle" label="首屏标题" rules={[{ required: true, max: 200 }]}>
          <Input disabled={hasPendingWrite} />
        </Form.Item>
        <Form.Item name="heroBody" label="首屏正文" rules={[{ required: true, max: 5_000 }]}>
          <Input.TextArea disabled={hasPendingWrite} rows={4} />
        </Form.Item>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="seoTitle" label="SEO 标题" rules={[{ max: 160 }]}>
              <Input disabled={hasPendingWrite} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="seoDescription" label="SEO 描述" rules={[{ max: 500 }]}>
              <Input disabled={hasPendingWrite} />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" htmlType="submit" loading={saving} disabled={hasPendingWrite}>
          保存草稿
        </Button>
      </Form>
    </Modal>
    <Modal
      title="AI 草稿已生成，尚未发布"
      open={aiDraft !== null}
      width={720}
      closable={!hasPendingWrite}
      maskClosable={false}
      onCancel={() => {
        if (!hasPendingWrite) setAiDraft(null);
      }}
      footer={canReviewAi
        ? [
            <Button key="reject" danger disabled={hasPendingWrite}
              onClick={() => void reviewAiDraft('rejected')}>拒绝草稿</Button>,
            <Button key="accept" type="primary" loading={saving} disabled={hasPendingWrite}
              onClick={() => void reviewAiDraft('accepted')}>人工确认接受</Button>,
          ]
        : [
            <Button key="close" disabled={hasPendingWrite} onClick={() => setAiDraft(null)}>
              关闭预览
            </Button>,
          ]}
    >
      <pre className="console-ai-preview">
        {aiDraft === null ? '' : JSON.stringify(aiDraft.output, null, 2)}
      </pre>
    </Modal>
  </main>;
}

function validateRestResult(attempt: PendingRestWrite, value: unknown): void {
  if (
    attempt.kind === 'content-create' ||
    attempt.kind === 'content-transition' ||
    attempt.kind === 'content-schedule' ||
    attempt.kind === 'content-rollback'
  ) {
    const content = parseMarketingContentMutation(value);
    if (
      (attempt.targetId !== undefined && content.id !== attempt.targetId) ||
      content.status !== attempt.expectedStatus ||
      content.version !== attempt.expectedVersion
    ) throw new Error('MARKETING_CONTENT_MUTATION_RESULT_MISMATCH');
    return;
  }
  if (attempt.kind === 'lead-status') {
    const lead = parseMarketingLeadMutation(value);
    if (
      lead.id !== attempt.targetId ||
      lead.status !== attempt.expectedStatus ||
      lead.version !== attempt.expectedVersion
    ) throw new Error('MARKETING_LEAD_MUTATION_RESULT_MISMATCH');
    return;
  }
  if (attempt.kind === 'ai-generate') {
    const draft = parseMarketingAiDraft(value);
    if (draft.status !== attempt.expectedStatus) {
      throw new Error('MARKETING_AI_DRAFT_RESULT_MISMATCH');
    }
    return;
  }
  const review = parseMarketingAiReview(value);
  if (review.id !== attempt.targetId || review.status !== attempt.expectedStatus) {
    throw new Error('MARKETING_AI_REVIEW_RESULT_MISMATCH');
  }
}

function canonicalFutureSchedule(value: string): string | null {
  const parsed = new Date(value.trim());
  const timestamp = parsed.getTime();
  const now = Date.now();
  if (
    Number.isNaN(timestamp) ||
    timestamp < now + 60_000 ||
    timestamp > now + 366 * 86_400_000
  ) return null;
  return parsed.toISOString();
}

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof ErpApiError) {
    return `${value.message}（${value.code}${value.traceId === null ? '' : `，${value.traceId}`}）`;
  }
  return value instanceof Error && /^[\p{Script=Han}A-Za-z0-9（）()，、。；：:_ -]{1,200}$/u.test(value.message)
    ? value.message
    : fallback;
}

function writeErrorMessage(value: unknown, fallback: string, uncertain: boolean): string {
  const message = errorMessage(value, fallback);
  return uncertain
    ? `${message}。结果尚未确认，请使用“重试原请求”；系统会复用同一请求和幂等键。`
    : message;
}
