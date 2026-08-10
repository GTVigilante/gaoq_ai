'use client';

import {
  AppstoreOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudUploadOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  GlobalOutlined,
  HistoryOutlined,
  MoreOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  SendOutlined,
  TeamOutlined,
  TranslationOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
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
  erpDownload,
  erpFetch,
  isDefinitiveWriteRejection,
  strongEtag,
} from '../../lib/api-client';
import { parseIdentityProfile, type IdentityProfileView } from '../../lib/approval-contract';
import {
  buildMarketingStructuredContentInput,
  canRetryMarketingWrite,
  hasMarketingPermission,
  marketingPermissions,
  parseMarketingAiDraft,
  parseMarketingAiReview,
  parseMarketingContentDetail,
  parseMarketingContentList,
  parseMarketingContentMutation,
  parseMarketingLeadAssigneeMutation,
  parseMarketingLeadList,
  parseMarketingLeadMutation,
  parseMarketingLeadNoteMutation,
  parseMarketingMediaList,
  parseMarketingMediaMutation,
  parseMarketingRevisionList,
  parseMarketingUploadTicket,
  type MarketingAiDraftView,
  type MarketingBlockType,
  type MarketingBlockView,
  type MarketingContentDetail,
  type MarketingContentFormValue,
  type MarketingContentStatus,
  type MarketingContentSummary,
  type MarketingLeadStatus,
  type MarketingLeadView,
  type MarketingLocale,
  type MarketingMediaView,
  type MarketingRevisionView,
  type MarketingUploadTicket,
} from '../../lib/marketing-cms-contract';

const { Title, Paragraph, Text } = Typography;

type RestWriteKind =
  | 'content-create'
  | 'content-update'
  | 'content-transition'
  | 'content-schedule'
  | 'content-rollback'
  | 'lead-status'
  | 'lead-assignee'
  | 'lead-note'
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

interface EditorState {
  readonly mode: 'create' | 'edit';
  readonly source: MarketingContentDetail | null;
}

interface LeadActionState {
  readonly kind: 'assignee' | 'note';
  readonly lead: MarketingLeadView;
}

const STATUS: Readonly<Record<MarketingContentStatus, {
  readonly text: string;
  readonly color: string;
}>> = {
  draft: { text: '草稿', color: 'default' },
  in_review: { text: '待审核', color: 'processing' },
  approved: { text: '已批准', color: 'cyan' },
  scheduled: { text: '已排期', color: 'purple' },
  published: { text: '已发布', color: 'success' },
  archived: { text: '已归档', color: 'warning' },
};

const LEAD_STATUS: Readonly<Record<MarketingLeadStatus, string>> = {
  new: '新线索', contacted: '已联系', qualified: '有效', unqualified: '无效',
  converted: '已转化', closed: '已关闭',
};

const BLOCK_LABEL: Readonly<Record<MarketingBlockType, string>> = {
  hero: '首屏 Hero', service_grid: '服务矩阵', case_list: '案例列表', metrics: '数据指标',
  process: '服务流程', rich_text: '富文本', faq: '常见问题', logo_wall: '品牌墙', cta: '行动号召',
};

const CONTENT_TYPES = [
  'page', 'service', 'case', 'article', 'team', 'testimonial',
  'faq', 'navigation', 'footer', 'site_config',
] as const;

const TRANSITION = Object.freeze({
  submit: { scope: marketingPermissions.contentSubmit, status: 'in_review', label: '内容送审' },
  approve: { scope: marketingPermissions.contentApprove, status: 'approved', label: '内容批准' },
  publish: { scope: marketingPermissions.contentPublish, status: 'published', label: '内容发布' },
  withdraw: { scope: marketingPermissions.contentPublish, status: 'archived', label: '内容撤回' },
  restore: { scope: marketingPermissions.contentUpdate, status: 'draft', label: '恢复草稿' },
} satisfies Readonly<Record<string, {
  readonly scope: string;
  readonly status: MarketingContentStatus;
  readonly label: string;
}>>);

/** 营销 CMS 运营工作台：内容工作流、双语校对、素材与线索在同一可信身份下协作。 */
export function MarketingCmsConsole() {
  const [items, setItems] = useState<readonly MarketingContentSummary[]>([]);
  const [leads, setLeads] = useState<readonly MarketingLeadView[]>([]);
  const [media, setMedia] = useState<readonly MarketingMediaView[]>([]);
  const [profile, setProfile] = useState<IdentityProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [contentQuery, setContentQuery] = useState('');
  const [contentStatus, setContentStatus] = useState<MarketingContentStatus | 'all'>('all');
  const [contentLocale, setContentLocale] = useState<MarketingLocale | 'all'>('all');
  const [contentType, setContentType] = useState<string>('all');
  const [leadQuery, setLeadQuery] = useState('');
  const [leadStatus, setLeadStatus] = useState<MarketingLeadStatus | 'all'>('all');
  const [mediaQuery, setMediaQuery] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorBlocks, setEditorBlocks] = useState<readonly MarketingBlockView[]>([]);
  const [preview, setPreview] = useState<MarketingContentDetail | null>(null);
  const [historyContent, setHistoryContent] = useState<MarketingContentDetail | null>(null);
  const [revisions, setRevisions] = useState<readonly MarketingRevisionView[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [scheduleItem, setScheduleItem] = useState<MarketingContentSummary | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [rollbackItem, setRollbackItem] = useState<MarketingContentSummary | null>(null);
  const [rollbackRevision, setRollbackRevision] = useState<number | null>(null);
  const [aiItem, setAiItem] = useState<MarketingContentSummary | null>(null);
  const [aiDraft, setAiDraft] = useState<MarketingAiDraftView | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [leadAction, setLeadAction] = useState<LeadActionState | null>(null);
  const [pendingRest, setPendingRest] = useState<PendingRestWrite | null>(null);
  const [pendingMedia, setPendingMedia] = useState<PendingMediaWrite | null>(null);
  const [editorForm] = Form.useForm<MarketingContentFormValue>();
  const [aiForm] = Form.useForm<{ action: string; targetLocale: MarketingLocale; instruction: string }>();
  const [uploadForm] = Form.useForm<{ altZh?: string; altEn?: string; copyrightSource: string }>();
  const [leadActionForm] = Form.useForm<{ assigneeId?: string; body?: string }>();
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setError(null);
    try {
      const profileResult = await erpFetch<unknown>('/api/auth/profile');
      const nextProfile = parseIdentityProfile(profileResult.data);
      const reads = await Promise.all([
        nextProfile.scopes.includes(marketingPermissions.contentRead)
          ? erpFetch<unknown>('/api/marketing-cms/contents') : Promise.resolve(null),
        nextProfile.scopes.includes(marketingPermissions.leadRead)
          ? erpFetch<unknown>('/api/marketing-cms/leads') : Promise.resolve(null),
        nextProfile.scopes.includes(marketingPermissions.mediaRead)
          ? erpFetch<unknown>('/api/marketing-cms/media') : Promise.resolve(null),
      ]);
      if (generation !== loadGeneration.current) return;
      setProfile(nextProfile);
      setItems(reads[0] === null ? [] : parseMarketingContentList(reads[0].data));
      setLeads(reads[1] === null ? [] : parseMarketingLeadList(reads[1].data));
      setMedia(reads[2] === null ? [] : parseMarketingMediaList(reads[2].data));
    } catch (value) {
      if (generation === loadGeneration.current) setError(errorMessage(value, '营销管理数据加载失败'));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  useEffect(() => {
    setPendingRest((current) => current !== null &&
      !canRetryMarketingWrite(profile, current.actorId, current.requiredScope) ? null : current);
    setPendingMedia((current) => current !== null &&
      !canRetryMarketingWrite(profile, current.actorId, current.requiredScope) ? null : current);
  }, [profile]);

  const hasPendingWrite = pendingRest !== null || pendingMedia !== null;
  const counts = useMemo(() => ({
    all: items.length,
    review: items.filter((item) => item.status === 'in_review').length,
    scheduled: items.filter((item) => item.status === 'scheduled').length,
    live: items.filter((item) => item.status === 'published').length,
    untranslated: items.filter((item) => item.locale === 'zh-CN' && !hasLocalePair(item, items)).length,
    newLeads: leads.filter((lead) => lead.status === 'new').length,
  }), [items, leads]);

  const filteredContents = useMemo(() => {
    const query = contentQuery.trim().toLocaleLowerCase();
    return items.filter((item) =>
      (query === '' || `${item.title} ${item.slug} ${item.summary}`.toLocaleLowerCase().includes(query)) &&
      (contentStatus === 'all' || item.status === contentStatus) &&
      (contentLocale === 'all' || item.locale === contentLocale) &&
      (contentType === 'all' || item.type === contentType));
  }, [contentLocale, contentQuery, contentStatus, contentType, items]);

  const filteredLeads = useMemo(() => {
    const query = leadQuery.trim().toLocaleLowerCase();
    return leads.filter((lead) =>
      (query === '' || `${lead.name} ${lead.contact} ${lead.requestSummary}`
        .toLocaleLowerCase().includes(query)) &&
      (leadStatus === 'all' || lead.status === leadStatus));
  }, [leadQuery, leadStatus, leads]);

  const filteredMedia = useMemo(() => {
    const query = mediaQuery.trim().toLocaleLowerCase();
    return media.filter((asset) => query === '' ||
      `${asset.fileName} ${asset.mimeType} ${asset.copyrightSource}`.toLocaleLowerCase().includes(query));
  }, [media, mediaQuery]);

  async function executeRest(attempt: PendingRestWrite): Promise<void> {
    if (!canRetryMarketingWrite(profile, attempt.actorId, attempt.requiredScope)) {
      if (profile !== null) setPendingRest(null);
      setError(profile === null ? '请先刷新并确认当前身份，再重试原请求。' : '当前身份或授权已变化，原请求已清除。');
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
      if (attempt.kind === 'content-create' || attempt.kind === 'content-update') {
        setEditor(null);
        editorForm.resetFields();
      }
      if (attempt.kind === 'ai-generate') setAiDraft(parseMarketingAiDraft(result.data));
      else if (attempt.kind === 'ai-review') setAiDraft(null);
      else await load();
    } catch (value) {
      const definitive = isDefinitiveWriteRejection(value);
      if (definitive) setPendingRest(null);
      setError(writeErrorMessage(value, `${attempt.label}失败`, !definitive));
    } finally {
      setSaving(false);
    }
  }

  async function openEditor(item?: MarketingContentSummary): Promise<void> {
    if (item === undefined) {
      editorForm.setFieldsValue({
        siteId: 'gaoq', type: 'page', locale: 'zh-CN', slug: '', title: '', summary: '',
        heroTitle: '', heroBody: '', seoTitle: '', seoDescription: '', canonicalPath: '',
        robots: 'index, follow',
      });
      setEditorBlocks([Object.freeze({ type: 'hero', data: Object.freeze({ title: '', body: '' }) })]);
      setEditor({ mode: 'create', source: null });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await erpFetch<unknown>(`/api/marketing-cms/contents/${item.id}`);
      const detail = parseMarketingContentDetail(result.data);
      const hero = detail.blocks.find((block) => block.type === 'hero');
      editorForm.setFieldsValue({
        siteId: detail.siteId,
        type: detail.type,
        locale: detail.locale,
        slug: detail.slug,
        title: detail.title,
        summary: detail.summary,
        heroTitle: textField(hero?.data.title),
        heroBody: textField(hero?.data.body),
        seoTitle: detail.seo.title ?? '',
        seoDescription: detail.seo.description ?? '',
        canonicalPath: detail.seo.canonicalPath ?? '',
        robots: detail.seo.robots ?? 'index, follow',
      });
      setEditorBlocks(detail.blocks);
      setEditor({ mode: 'edit', source: detail });
    } catch (value) {
      setError(errorMessage(value, '内容详情加载失败'));
    } finally {
      setSaving(false);
    }
  }

  async function saveContent(values: MarketingContentFormValue): Promise<void> {
    if (profile === null || editor === null || hasPendingWrite) return;
    const requiredScope = editor.mode === 'create'
      ? marketingPermissions.contentCreate : marketingPermissions.contentUpdate;
    if (!hasMarketingPermission(profile, requiredScope, marketingPermissions.contentRead)) return;
    let input;
    try {
      input = buildMarketingStructuredContentInput(values, editorBlocks);
    } catch {
      setError('内容、区块或 SEO 字段不符合受控长度、格式或安全要求。');
      return;
    }
    const source = editor.source;
    const attempt: PendingRestWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope,
      kind: editor.mode === 'create' ? 'content-create' : 'content-update',
      label: editor.mode === 'create' ? '内容创建' : '内容保存',
      path: editor.mode === 'create' ? '/api/marketing-cms/contents' :
        `/api/marketing-cms/contents/${String(source?.id)}`,
      method: editor.mode === 'create' ? 'POST' : 'PATCH',
      headers: Object.freeze({
        'content-type': 'application/json',
        'idempotency-key': createIdempotencyKey(
          editor.mode === 'create' ? 'marketing.create' : 'marketing.update',
        ),
        ...(source === null ? {} : { 'if-match': strongEtag(source.version) }),
      }),
      body: JSON.stringify(input),
      ...(source === null ? {} : { targetId: source.id }),
      expectedStatus: 'draft',
      expectedVersion: source === null ? 1 : source.version + 1,
    });
    setPendingRest(attempt);
    await executeRest(attempt);
  }

  function updateBlock(index: number, field: 'type' | 'title' | 'body', value: string): void {
    setEditorBlocks((current) => Object.freeze(current.map((block, itemIndex) => {
      if (itemIndex !== index) return block;
      if (field === 'type') return Object.freeze({ ...block, type: value as MarketingBlockType });
      return Object.freeze({
        ...block,
        data: Object.freeze({ ...block.data, [field]: value }),
      });
    })));
  }

  function addBlock(): void {
    setEditorBlocks((current) => Object.freeze([
      ...current,
      Object.freeze({ type: 'rich_text' as const, data: Object.freeze({ title: '', body: '' }) }),
    ]));
  }

  function removeBlock(index: number): void {
    setEditorBlocks((current) => current.length <= 1 ? current :
      Object.freeze(current.filter((_, itemIndex) => itemIndex !== index)));
  }

  async function openPreview(item: MarketingContentSummary): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const result = await erpFetch<unknown>(`/api/marketing-cms/contents/${item.id}`);
      setPreview(parseMarketingContentDetail(result.data));
    } catch (value) {
      setError(errorMessage(value, '安全预览加载失败'));
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(item: MarketingContentSummary): Promise<void> {
    setHistoryLoading(true);
    setError(null);
    try {
      const [detailResult, revisionResult] = await Promise.all([
        erpFetch<unknown>(`/api/marketing-cms/contents/${item.id}`),
        erpFetch<unknown>(`/api/marketing-cms/contents/${item.id}/revisions`),
      ]);
      setHistoryContent(parseMarketingContentDetail(detailResult.data));
      setRevisions(parseMarketingRevisionList(revisionResult.data));
    } catch (value) {
      setError(errorMessage(value, '版本历史加载失败'));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function transitionContent(
    item: MarketingContentSummary,
    name: keyof typeof TRANSITION,
  ): Promise<void> {
    const rule = TRANSITION[name];
    if (profile === null || !hasMarketingPermission(
      profile, rule.scope, marketingPermissions.contentRead,
    ) || hasPendingWrite) return;
    const attempt: PendingRestWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope: rule.scope,
      kind: 'content-transition',
      label: rule.label,
      path: `/api/marketing-cms/contents/${item.id}/${name}`,
      method: 'POST',
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

  async function scheduleContent(): Promise<void> {
    const item = scheduleItem;
    if (item === null || profile === null || hasPendingWrite) return;
    const scheduledAt = canonicalFutureSchedule(scheduleAt);
    if (scheduledAt === null) {
      setError('发布时间必须是未来 1 分钟至 366 天内的有效时间。');
      return;
    }
    const attempt: PendingRestWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.contentPublish,
      kind: 'content-schedule',
      label: '内容排期',
      path: `/api/marketing-cms/contents/${item.id}/schedule`,
      method: 'POST',
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
    setScheduleItem(null);
    setScheduleAt('');
  }

  async function rollbackContent(): Promise<void> {
    const item = rollbackItem;
    const revision = rollbackRevision;
    if (item === null || revision === null || profile === null || hasPendingWrite ||
      !Number.isSafeInteger(revision) || revision < 1 || revision >= item.revision) {
      setError('回滚版本必须是小于当前版本的正整数。');
      return;
    }
    const attempt: PendingRestWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.contentRollback,
      kind: 'content-rollback',
      label: '内容回滚',
      path: `/api/marketing-cms/contents/${item.id}/rollback`,
      method: 'POST',
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
    setRollbackItem(null);
    setRollbackRevision(null);
  }

  async function generateAiDraft(values: {
    action: string;
    targetLocale: MarketingLocale;
    instruction: string;
  }): Promise<void> {
    const item = aiItem;
    if (item === null || profile === null || hasPendingWrite) return;
    const attempt: PendingRestWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.aiGenerate,
      kind: 'ai-generate',
      label: 'AI 草稿生成',
      path: `/api/marketing-cms/contents/${item.id}/ai-drafts`,
      method: 'POST',
      headers: Object.freeze({
        'content-type': 'application/json',
        'idempotency-key': createIdempotencyKey('marketing.ai.generate'),
      }),
      body: JSON.stringify(values),
      targetId: item.id,
      expectedStatus: 'pending_review',
    });
    setPendingRest(attempt);
    await executeRest(attempt);
    setAiItem(null);
    aiForm.resetFields();
  }

  async function reviewAiDraft(decision: 'accepted' | 'rejected'): Promise<void> {
    if (aiDraft === null || profile === null || hasPendingWrite) return;
    const attempt: PendingRestWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.aiReview,
      kind: 'ai-review',
      label: 'AI 草稿人工复核',
      path: `/api/marketing-cms/ai-drafts/${aiDraft.id}/review`,
      method: 'POST',
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

  async function updateLead(item: MarketingLeadView, status: MarketingLeadStatus): Promise<void> {
    if (profile === null || hasPendingWrite) return;
    const attempt: PendingRestWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.leadUpdate,
      kind: 'lead-status',
      label: '线索状态更新',
      path: `/api/marketing-cms/leads/${item.id}/status`,
      method: 'PATCH',
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

  async function submitLeadAction(values: { assigneeId?: string; body?: string }): Promise<void> {
    if (leadAction === null || profile === null || hasPendingWrite) return;
    const isAssignee = leadAction.kind === 'assignee';
    const payload = isAssignee ? { assigneeId: values.assigneeId } : { body: values.body };
    const attempt: PendingRestWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.leadUpdate,
      kind: isAssignee ? 'lead-assignee' : 'lead-note',
      label: isAssignee ? '线索负责人更新' : '线索跟进记录',
      path: `/api/marketing-cms/leads/${leadAction.lead.id}/${isAssignee ? 'assignee' : 'notes'}`,
      method: isAssignee ? 'PATCH' : 'POST',
      headers: Object.freeze({
        'content-type': 'application/json',
        'if-match': strongEtag(leadAction.lead.version),
        'idempotency-key': createIdempotencyKey(
          isAssignee ? 'marketing.lead.assignee' : 'marketing.lead.note',
        ),
      }),
      body: JSON.stringify(payload),
      targetId: leadAction.lead.id,
      expectedVersion: leadAction.lead.version + 1,
    });
    setPendingRest(attempt);
    await executeRest(attempt);
    setLeadAction(null);
    leadActionForm.resetFields();
  }

  async function exportLeads(): Promise<void> {
    if (!hasMarketingPermission(profile, marketingPermissions.leadExport, marketingPermissions.leadRead)) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await erpDownload('/api/marketing-cms/leads-export.csv', 'text/csv');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `marketing-leads-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (value) {
      setError(errorMessage(value, '线索导出失败'));
    } finally {
      setSaving(false);
    }
  }

  function selectMediaFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (file !== null && !validMediaFile(file)) {
      setError('媒体文件类型、名称或大小不符合要求（上限 20 MiB）。');
      return;
    }
    setUploadFile(file);
  }

  async function startMediaUpload(values: {
    altZh?: string;
    altEn?: string;
    copyrightSource: string;
  }): Promise<void> {
    const file = uploadFile;
    if (file === null || profile === null || hasPendingWrite || !validMediaFile(file)) return;
    const altText = Object.freeze({
      ...(values.altZh?.trim() === '' || values.altZh === undefined ? {} : { 'zh-CN': values.altZh.trim() }),
      ...(values.altEn?.trim() === '' || values.altEn === undefined ? {} : { en: values.altEn.trim() }),
    });
    const attempt: PendingMediaWrite = Object.freeze({
      actorId: profile.actorId,
      requiredScope: marketingPermissions.mediaCreate,
      file,
      metadata: Object.freeze({
        siteId: 'gaoq', fileName: file.name, mimeType: file.type, sizeBytes: file.size,
        altText, copyrightSource: values.copyrightSource.trim(),
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
      setError(profile === null ? '请先刷新并确认当前身份，再重试原媒体请求。' : '当前身份或授权已变化，原媒体请求已清除。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let current = attempt;
      if (current.stage === 'ticket') {
        const result = await erpFetch<unknown>('/api/marketing-cms/media/uploads', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': current.createKey },
          body: JSON.stringify(current.metadata),
        });
        current = Object.freeze({ ...current, stage: 'upload' as const,
          ticket: parseMarketingUploadTicket(result.data) });
        setPendingMedia(current);
      }
      if (current.stage === 'upload') {
        if (current.ticket === undefined) throw new Error('MARKETING_UPLOAD_STATE_INVALID');
        const response = await fetch(current.ticket.uploadUrl, {
          method: 'PUT', headers: { 'content-type': current.file.type }, body: current.file,
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
        const result = await erpFetch<unknown>(`/api/marketing-cms/media/${current.ticket.id}/verify`, {
          method: 'POST',
          headers: {
            'if-match': strongEtag(current.ticket.version),
            'idempotency-key': current.verifyKey,
          },
        });
        const verified = parseMarketingMediaMutation(result.data);
        if (verified.id !== current.ticket.id || verified.status !== 'ready' ||
          verified.version !== current.ticket.version + 1) {
          throw new Error('MARKETING_MEDIA_VERIFY_RESULT_MISMATCH');
        }
        setPendingMedia(null);
        setUploadOpen(false);
        setUploadFile(null);
        uploadForm.resetFields();
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
    profile, marketingPermissions.contentCreate, marketingPermissions.contentRead,
  );
  const canUpdateLead = hasMarketingPermission(
    profile, marketingPermissions.leadUpdate, marketingPermissions.leadRead,
  );
  const canUploadMedia = hasMarketingPermission(
    profile, marketingPermissions.mediaCreate, marketingPermissions.mediaRead,
  );
  const canReviewAi = hasMarketingPermission(profile, marketingPermissions.aiReview);

  const contentColumns: ColumnsType<MarketingContentSummary> = [
    {
      title: '内容', dataIndex: 'title', width: 340,
      render: (_, item) => <button className="cms-content-link" onClick={() => void openEditor(item)}>
        <span>{item.title}</span>
        <small>/{item.slug} · {item.type}</small>
      </button>,
    },
    {
      title: '双语', width: 118,
      render: (_, item) => <Space size={4}>
        <Tag className={item.locale === 'zh-CN' ? 'is-current' : ''}>中</Tag>
        <Tag className={item.locale === 'en' ? 'is-current' : ''}>EN</Tag>
        {hasLocalePair(item, items)
          ? <Tooltip title="双语内容已配对"><CheckCircleOutlined className="cms-success" /></Tooltip>
          : <Tooltip title="另一语言尚未创建"><WarningOutlined className="cms-warning" /></Tooltip>}
      </Space>,
    },
    {
      title: '工作流', dataIndex: 'status', width: 110,
      render: (value: MarketingContentStatus) => <Tag color={STATUS[value].color}>{STATUS[value].text}</Tag>,
    },
    {
      title: '完整度', width: 150,
      render: (_, item) => <Progress
        percent={contentCompleteness(item, items)}
        size="small"
        strokeColor={contentCompleteness(item, items) >= 80 ? '#198754' : '#c17b12'}
      />,
    },
    {
      title: '发布计划', width: 180,
      render: (_, item) => item.scheduledAt !== null
        ? <Space size={6}><CalendarOutlined />{formatDateTime(item.scheduledAt)}</Space>
        : item.publishedAt !== null
          ? <Text type="secondary">发布于 {formatDate(item.publishedAt)}</Text>
          : <Text type="secondary">尚未排期</Text>,
    },
    {
      title: '版本', dataIndex: 'revision', width: 72,
      render: (value: number) => <Text className="cms-tabular">r{value}</Text>,
    },
    {
      title: '', key: 'actions', width: 92, fixed: 'right',
      render: (_, item) => <Space size={4}>
        <Tooltip title="安全预览"><Button type="text" icon={<EyeOutlined />}
          onClick={() => void openPreview(item)} /></Tooltip>
        <Dropdown trigger={['click']} menu={{
          items: contentActions(item, profile),
          onClick: ({ key }) => void runContentAction(key, item),
        }}><Button type="text" icon={<MoreOutlined />} aria-label="更多内容操作" /></Dropdown>
      </Space>,
    },
  ];

  function runContentAction(key: string, item: MarketingContentSummary): void {
    if (key === 'edit') void openEditor(item);
    else if (key === 'history') void openHistory(item);
    else if (key === 'schedule') { setScheduleItem(item); setScheduleAt(''); }
    else if (key === 'rollback') { setRollbackItem(item); setRollbackRevision(item.revision - 1); }
    else if (key === 'ai') {
      setAiItem(item);
      aiForm.setFieldsValue({
        action: 'translate', targetLocale: item.locale === 'zh-CN' ? 'en' : 'zh-CN',
        instruction: '保持品牌语气与事实，不增加未经证实的数据。',
      });
    } else if (Object.hasOwn(TRANSITION, key)) {
      void transitionContent(item, key as keyof typeof TRANSITION);
    }
  }

  const leadColumns: ColumnsType<MarketingLeadView> = [
    {
      title: '联系人', dataIndex: 'name', width: 220,
      render: (_, lead) => <span className="cms-lead-person"><strong>{lead.name}</strong><small>{lead.contact}</small></span>,
    },
    { title: '类型', dataIndex: 'audience', width: 90,
      render: (value: MarketingLeadView['audience']) => <Tag>{value === 'creator' ? '创作者' : '品牌方'}</Tag> },
    { title: '需求摘要', dataIndex: 'requestSummary', ellipsis: true },
    { title: '负责人', dataIndex: 'assigneeId', width: 150,
      render: (value: string | null) => value ?? <Text type="secondary">待分配</Text> },
    { title: '跟进', width: 100,
      render: (_, lead) => <Text type="secondary">{lead.noteCount} 条</Text> },
    { title: '状态', dataIndex: 'status', width: 110,
      render: (value: MarketingLeadStatus) => <Tag color={value === 'converted' ? 'success' : 'blue'}>{LEAD_STATUS[value]}</Tag> },
    ...(canUpdateLead ? [{
      title: '', width: 90,
      render: (_: unknown, lead: MarketingLeadView) => <Dropdown trigger={['click']} menu={{
        items: [
          { key: 'contacted', label: '标记已联系' }, { key: 'qualified', label: '标记有效' },
          { key: 'converted', label: '标记已转化' }, { type: 'divider' },
          { key: 'assignee', label: '分配负责人' }, { key: 'note', label: '添加跟进记录' },
          { type: 'divider' }, { key: 'closed', label: '关闭线索', danger: true },
        ],
        onClick: ({ key }) => {
          if (key === 'assignee' || key === 'note') {
            setLeadAction({ kind: key, lead });
            leadActionForm.resetFields();
          } else void updateLead(lead, key as MarketingLeadStatus);
        },
      }}><Button type="text" icon={<MoreOutlined />} /></Dropdown>,
    }] : []),
  ];

  return <main className="cms-studio" aria-labelledby="marketing-title">
    <header className="cms-studio-header">
      <div>
        <Text className="cms-eyebrow">GAOQ / CONTENT OPERATIONS</Text>
        <Title id="marketing-title" level={1}>内容运营中心</Title>
        <Paragraph>从创意、双语校对到发布与转化，统一管理官网内容资产。</Paragraph>
      </div>
      <Space wrap>
        <Button icon={<GlobalOutlined />} href="https://www.gaoq.com" target="_blank">访问官网</Button>
        {canCreateContent ? <Button type="primary" icon={<PlusOutlined />} disabled={hasPendingWrite}
          onClick={() => void openEditor()}>新建内容</Button> : null}
      </Space>
    </header>

    {error !== null ? <Alert className="cms-alert" type="error" showIcon title={error}
      action={hasPendingWrite ? <Button size="small" loading={saving} onClick={() => {
        if (pendingRest !== null) void executeRest(pendingRest);
        else if (pendingMedia !== null) void executeMedia(pendingMedia);
      }}>重试原请求</Button> : undefined}
      closable={!hasPendingWrite} onClose={() => setError(null)} /> : null}

    <Tabs activeKey={activeTab} onChange={setActiveTab} className="cms-primary-tabs" items={[
      { key: 'overview', label: <span><AppstoreOutlined />运营总览</span>, children: <Overview
        counts={counts} items={items} leads={leads} onOpenQueue={(filter) => {
          setContentStatus(filter); setActiveTab('contents');
        }} onOpenLeads={() => setActiveTab('leads')} /> },
      ...(profile?.scopes.includes(marketingPermissions.contentRead) === true ? [{
        key: 'contents', label: <span><FileTextOutlined />内容工作台</span>,
        children: <section className="cms-panel">
          <div className="cms-toolbar">
            <Input allowClear prefix={<SearchOutlined />} placeholder="搜索标题、Slug 或摘要"
              value={contentQuery} onChange={(event) => setContentQuery(event.target.value)} />
            <Select value={contentStatus} onChange={setContentStatus} options={[
              { value: 'all', label: '全部状态' },
              ...Object.entries(STATUS).map(([value, meta]) => ({ value, label: meta.text })),
            ]} />
            <Segmented value={contentLocale} onChange={(value) => setContentLocale(value as MarketingLocale | 'all')}
              options={[{ value: 'all', label: '全部语言' }, { value: 'zh-CN', label: '中文' }, { value: 'en', label: 'EN' }]} />
            <Select value={contentType} onChange={setContentType} options={[
              { value: 'all', label: '全部类型' }, ...CONTENT_TYPES.map((value) => ({ value, label: value })),
            ]} />
            <Text type="secondary">{filteredContents.length} 条内容</Text>
          </div>
          <Table rowKey="id" columns={contentColumns} dataSource={[...filteredContents]}
            loading={loading} scroll={{ x: 1_180 }} pagination={{ pageSize: 20, showSizeChanger: true }} />
        </section>,
      }] : []),
      ...(profile?.scopes.includes(marketingPermissions.mediaRead) === true ? [{
        key: 'media', label: <span><CloudUploadOutlined />媒体库</span>,
        children: <section className="cms-panel">
          <div className="cms-toolbar cms-toolbar-media">
            <Input allowClear prefix={<SearchOutlined />} placeholder="搜索文件、类型或版权来源"
              value={mediaQuery} onChange={(event) => setMediaQuery(event.target.value)} />
            <Text type="secondary">{filteredMedia.length} 项素材</Text>
            {canUploadMedia ? <Button type="primary" icon={<CloudUploadOutlined />}
              disabled={hasPendingWrite} onClick={() => setUploadOpen(true)}>上传素材</Button> : null}
          </div>
          <MediaLibrary items={filteredMedia} loading={loading} />
        </section>,
      }] : []),
      ...(profile?.scopes.includes(marketingPermissions.leadRead) === true ? [{
        key: 'leads', label: <span><TeamOutlined />转化线索 <Tag>{leads.length}</Tag></span>,
        children: <section className="cms-panel">
          <LeadPipeline leads={leads} active={leadStatus} onChange={setLeadStatus} />
          <div className="cms-toolbar">
            <Input allowClear prefix={<SearchOutlined />} placeholder="搜索联系人、联系方式或需求"
              value={leadQuery} onChange={(event) => setLeadQuery(event.target.value)} />
            <Text type="secondary">{filteredLeads.length} 条线索</Text>
            {hasMarketingPermission(profile, marketingPermissions.leadExport, marketingPermissions.leadRead)
              ? <Button loading={saving} onClick={() => void exportLeads()}>导出 CSV</Button> : null}
          </div>
          <Table rowKey="id" columns={leadColumns} dataSource={[...filteredLeads]}
            loading={loading} scroll={{ x: 1_080 }} pagination={{ pageSize: 20 }} />
        </section>,
      }] : []),
    ]} />

    {profile !== null && !profile.scopes.some((scope) => new Set<string>([
      marketingPermissions.contentRead, marketingPermissions.leadRead, marketingPermissions.mediaRead,
    ]).has(scope)) ? <Alert type="info" showIcon title="当前身份没有营销管理读取权限。" /> : null}

    <Drawer title={editor?.mode === 'create' ? '创建内容' : '编辑内容'} open={editor !== null}
      onClose={() => { if (!hasPendingWrite) setEditor(null); }} size={920} destroyOnHidden
      extra={<Space><Tag>{editor?.source?.locale ?? '新内容'}</Tag>
        {editor?.source === null || editor?.source === undefined ? null : <Tag color={STATUS[editor.source.status].color}>{STATUS[editor.source.status].text}</Tag>}
      </Space>}>
      <Form form={editorForm} layout="vertical" onFinish={(values) => void saveContent(values)}>
        <ContentEditor blocks={editorBlocks} disabled={hasPendingWrite}
          onAdd={addBlock} onRemove={removeBlock} onChange={updateBlock} />
        <div className="cms-editor-actions">
          <Text type="secondary">保存后生成新修订，并回到草稿状态。</Text>
          <Button type="primary" htmlType="submit" loading={saving} disabled={hasPendingWrite}>保存草稿</Button>
        </div>
      </Form>
    </Drawer>

    <Drawer title="安全预览" open={preview !== null} onClose={() => setPreview(null)} size={760}
      extra={preview === null ? null : <Tag color={STATUS[preview.status].color}>{STATUS[preview.status].text}</Tag>}>
      {preview === null ? null : <ContentPreview content={preview} />}
    </Drawer>

    <Drawer title="修订历史" open={historyContent !== null || historyLoading}
      onClose={() => { setHistoryContent(null); setRevisions([]); }} size={760} loading={historyLoading}>
      {historyContent === null ? null : <RevisionHistory content={historyContent} revisions={revisions}
        onPreview={setPreview} onRollback={(revision) => {
          const item = items.find((candidate) => candidate.id === historyContent.id);
          if (item !== undefined) { setRollbackItem(item); setRollbackRevision(revision); }
        }} />}
    </Drawer>

    <Modal title="安排发布时间" open={scheduleItem !== null} confirmLoading={saving}
      onOk={() => void scheduleContent()} onCancel={() => setScheduleItem(null)}
      okText="确认排期" okButtonProps={{ disabled: scheduleAt === '' || hasPendingWrite }}>
      <Paragraph>内容将由 Worker 在目标时间发布；编辑或撤回会取消原排期。</Paragraph>
      <Input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} />
    </Modal>

    <Modal title="从历史版本创建草稿" open={rollbackItem !== null} confirmLoading={saving}
      onOk={() => void rollbackContent()} onCancel={() => setRollbackItem(null)} okText="创建回滚草稿">
      <Alert type="info" showIcon title="不会覆盖历史或直接发布；系统会创建一个新的草稿修订。" />
      <Input className="cms-modal-input" type="number" min={1}
        max={Math.max(1, (rollbackItem?.revision ?? 2) - 1)} value={rollbackRevision ?? ''}
        onChange={(event) => setRollbackRevision(Number(event.target.value))} />
    </Modal>

    <Modal title="AI 内容助手" open={aiItem !== null} footer={null}
      onCancel={() => setAiItem(null)} destroyOnHidden>
      <Alert className="cms-modal-alert" type="info" showIcon
        title="AI 只生成待复核草稿，不具备审核或发布权限。" />
      <Form form={aiForm} layout="vertical" onFinish={(values) => void generateAiDraft(values)}>
        <Form.Item name="action" label="任务" rules={[{ required: true }]}>
          <Select options={[
            { value: 'translate', label: '双语翻译' }, { value: 'rewrite', label: '品牌语气改写' },
            { value: 'outline', label: '生成内容提纲' }, { value: 'seo', label: 'SEO 优化建议' },
            { value: 'alt_text', label: '生成图片替代文本' },
          ]} />
        </Form.Item>
        <Form.Item name="targetLocale" label="目标语言" rules={[{ required: true }]}>
          <Segmented options={[{ value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }]} />
        </Form.Item>
        <Form.Item name="instruction" label="编辑要求" rules={[{ required: true, min: 1, max: 2_000 }]}>
          <Input.TextArea rows={4} showCount maxLength={2_000} />
        </Form.Item>
        <Button type="primary" icon={<RobotOutlined />} htmlType="submit" loading={saving}>生成待审草稿</Button>
      </Form>
    </Modal>

    <Modal title="AI 草稿复核" open={aiDraft !== null} width={760} mask={{ closable: false }}
      onCancel={() => { if (!hasPendingWrite) setAiDraft(null); }}
      footer={canReviewAi ? [
        <Button key="reject" danger disabled={hasPendingWrite} onClick={() => void reviewAiDraft('rejected')}>拒绝</Button>,
        <Button key="accept" type="primary" loading={saving} disabled={hasPendingWrite}
          onClick={() => void reviewAiDraft('accepted')}>人工确认接受</Button>,
      ] : [<Button key="close" onClick={() => setAiDraft(null)}>关闭</Button>]}>
      <pre className="cms-ai-preview">{aiDraft === null ? '' : JSON.stringify(aiDraft.output, null, 2)}</pre>
    </Modal>

    <Modal title="上传媒体素材" open={uploadOpen} footer={null} destroyOnHidden
      onCancel={() => { if (!hasPendingWrite) { setUploadOpen(false); setUploadFile(null); } }}>
      <Form form={uploadForm} layout="vertical" initialValues={{ copyrightSource: '' }}
        onFinish={(values) => void startMediaUpload(values)}>
        <label className="cms-upload-dropzone">
          <CloudUploadOutlined />
          <strong>{uploadFile?.name ?? '选择图片或 PDF'}</strong>
          <span>JPEG、PNG、WebP、AVIF、PDF，最大 20 MiB；上传后自动扫描。</span>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/avif,application/pdf"
            onChange={selectMediaFile} />
        </label>
        <Row gutter={12}>
          <Col span={12}><Form.Item name="altZh" label="中文替代文本" rules={[{ max: 500 }]}>
            <Input disabled={hasPendingWrite} />
          </Form.Item></Col>
          <Col span={12}><Form.Item name="altEn" label="English alt text" rules={[{ max: 500 }]}>
            <Input disabled={hasPendingWrite} />
          </Form.Item></Col>
        </Row>
        <Form.Item name="copyrightSource" label="版权来源" rules={[{ required: true, max: 500 }]}>
          <Input disabled={hasPendingWrite} placeholder="自有版权 / 授权方及授权编号" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={saving} disabled={uploadFile === null || hasPendingWrite}>上传并扫描</Button>
      </Form>
    </Modal>

    <Modal title={leadAction?.kind === 'assignee' ? '分配线索负责人' : '添加跟进记录'}
      open={leadAction !== null} footer={null} destroyOnHidden onCancel={() => setLeadAction(null)}>
      <Form form={leadActionForm} layout="vertical" onFinish={(values) => void submitLeadAction(values)}>
        {leadAction?.kind === 'assignee' ? <Form.Item name="assigneeId" label="负责人标识"
          rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u }]}>
          <Input placeholder="employee:001" />
        </Form.Item> : <Form.Item name="body" label="跟进记录"
          rules={[{ required: true, min: 1, max: 2_000 }]}>
          <Input.TextArea rows={5} showCount maxLength={2_000} />
        </Form.Item>}
        <Button type="primary" htmlType="submit" loading={saving}>确认保存</Button>
      </Form>
    </Modal>
  </main>;
}

function Overview({
  counts, items, leads, onOpenQueue, onOpenLeads,
}: {
  readonly counts: { readonly all: number; readonly review: number; readonly scheduled: number;
    readonly live: number; readonly untranslated: number; readonly newLeads: number };
  readonly items: readonly MarketingContentSummary[];
  readonly leads: readonly MarketingLeadView[];
  readonly onOpenQueue: (status: MarketingContentStatus | 'all') => void;
  readonly onOpenLeads: () => void;
}) {
  const upcoming = items.filter((item) => item.scheduledAt !== null)
    .sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt))).slice(0, 5);
  const queue = items.filter((item) => ['draft', 'in_review', 'approved'].includes(item.status)).slice(0, 6);
  const conversion = leads.length === 0 ? 0 : Math.round(
    leads.filter((lead) => lead.status === 'converted').length / leads.length * 100,
  );
  return <div className="cms-overview">
    <section className="cms-metric-strip">
      <button onClick={() => onOpenQueue('all')}><span>内容资产</span><strong>{counts.all}</strong><small>{counts.live} 已上线</small></button>
      <button onClick={() => onOpenQueue('in_review')}><span>待审核</span><strong>{counts.review}</strong><small>需要编辑负责人处理</small></button>
      <button onClick={() => onOpenQueue('scheduled')}><span>已排期</span><strong>{counts.scheduled}</strong><small>未来发布任务</small></button>
      <button onClick={onOpenLeads}><span>新线索</span><strong>{counts.newLeads}</strong><small>转化率 {conversion}%</small></button>
    </section>
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={15}><Card className="cms-work-queue" title="下一步要处理" extra={<Button type="link" onClick={() => onOpenQueue('all')}>查看全部</Button>}>
        {queue.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有待处理内容" /> :
          queue.map((item) => <button key={item.id} onClick={() => onOpenQueue(item.status)}>
            <span className={`cms-status-dot is-${item.status}`} />
            <span><strong>{item.title}</strong><small>{item.locale} · /{item.slug}</small></span>
            <Tag color={STATUS[item.status].color}>{STATUS[item.status].text}</Tag>
            <Progress type="circle" percent={contentCompleteness(item, items)} size={38} />
          </button>)}
      </Card></Col>
      <Col xs={24} xl={9}><Card className="cms-release-card" title="发布日历" extra={<CalendarOutlined />}>
        {upcoming.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无排期内容" /> :
          <Timeline items={upcoming.map((item) => ({
            color: 'blue', children: <span><strong>{item.title}</strong><small>{formatDateTime(String(item.scheduledAt))}</small></span>,
          }))} />}
        <div className="cms-language-health"><span><TranslationOutlined /> 双语覆盖</span>
          <Progress percent={counts.all === 0 ? 0 : Math.round((counts.all - counts.untranslated) / counts.all * 100)} />
        </div>
      </Card></Col>
    </Row>
  </div>;
}

function ContentEditor({
  blocks, disabled, onAdd, onRemove, onChange,
}: {
  readonly blocks: readonly MarketingBlockView[];
  readonly disabled: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
  readonly onChange: (index: number, field: 'type' | 'title' | 'body', value: string) => void;
}) {
  return <div className="cms-editor-layout">
    <section className="cms-editor-form">
      <Card size="small" title="基础信息">
        <Row gutter={12}>
          <Col span={8}><Form.Item name="siteId" label="站点" rules={[{ required: true, max: 128 }]}><Input disabled /></Form.Item></Col>
          <Col span={8}><Form.Item name="type" label="内容类型" rules={[{ required: true }]}><Select disabled={disabled}
            options={CONTENT_TYPES.map((value) => ({ value, label: value }))} /></Form.Item></Col>
          <Col span={8}><Form.Item name="locale" label="语言" rules={[{ required: true }]}><Select disabled={disabled}
            options={[{ value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }]} /></Form.Item></Col>
        </Row>
        <Form.Item name="slug" label="Slug" rules={[{ required: true, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, max: 160 }]}>
          <Input disabled={disabled} addonBefore="/" placeholder="creator-services" />
        </Form.Item>
        <Form.Item name="title" label="内容标题" rules={[{ required: true, max: 160 }]}><Input disabled={disabled} showCount maxLength={160} /></Form.Item>
        <Form.Item name="summary" label="内容摘要" rules={[{ max: 500 }]}><Input.TextArea disabled={disabled} rows={3} showCount maxLength={500} /></Form.Item>
      </Card>
      <Card size="small" title="页面区块" extra={<Button size="small" icon={<PlusOutlined />} onClick={onAdd} disabled={disabled}>添加区块</Button>}>
        <div className="cms-block-list">{blocks.map((block, index) => <article key={`${block.type}-${index}`}>
          <header><span className="cms-block-index">{String(index + 1).padStart(2, '0')}</span>
            <Select value={block.type} disabled={disabled} onChange={(value) => onChange(index, 'type', value)}
              options={Object.entries(BLOCK_LABEL).map(([value, label]) => ({ value, label }))} />
            <Button danger type="text" disabled={disabled || blocks.length <= 1} onClick={() => onRemove(index)}>移除</Button></header>
          <Input value={textField(block.data.title)} disabled={disabled} placeholder="区块标题"
            onChange={(event) => onChange(index, 'title', event.target.value)} />
          <Input.TextArea value={textField(block.data.body)} disabled={disabled} rows={4} placeholder="区块正文"
            onChange={(event) => onChange(index, 'body', event.target.value)} />
          {Object.keys(block.data).some((key) => key !== 'title' && key !== 'body')
            ? <Text type="secondary">已保留 {Object.keys(block.data).filter((key) => key !== 'title' && key !== 'body').length} 个高级字段</Text> : null}
        </article>)}</div>
      </Card>
      <Card size="small" title="搜索与分享">
        <Row gutter={12}>
          <Col span={12}><Form.Item name="seoTitle" label="SEO 标题" rules={[{ max: 160 }]}><Input disabled={disabled} showCount maxLength={160} /></Form.Item></Col>
          <Col span={12}><Form.Item name="robots" label="搜索引擎策略"><Select disabled={disabled} options={[
            { value: 'index, follow', label: '允许索引与跟踪' }, { value: 'noindex, follow', label: '不索引，允许跟踪' },
            { value: 'noindex, nofollow', label: '不索引、不跟踪' },
          ]} /></Form.Item></Col>
        </Row>
        <Form.Item name="seoDescription" label="SEO 描述" rules={[{ max: 500 }]}><Input.TextArea disabled={disabled} rows={3} showCount maxLength={500} /></Form.Item>
        <Form.Item name="canonicalPath" label="Canonical Path" rules={[{ pattern: /^\/[A-Za-z0-9/_-]*$/u, max: 500 }]}><Input disabled={disabled} placeholder="/zh-CN/services/creator-services" /></Form.Item>
      </Card>
    </section>
    <aside className="cms-editor-inspector">
      <strong>页面结构</strong>
      {blocks.map((block, index) => <span key={`${block.type}-${index}`}><i>{index + 1}</i>{BLOCK_LABEL[block.type]}</span>)}
      <Text type="secondary">拖拽排序将在下一阶段加入；当前按编号顺序发布。</Text>
    </aside>
  </div>;
}

function ContentPreview({ content }: { readonly content: MarketingContentDetail }) {
  return <div className="cms-preview-shell">
    <header><span>GAOQ PREVIEW</span><Tag>{content.locale}</Tag></header>
    <div className="cms-preview-meta"><Text>{content.type}</Text><Text>/ {content.slug}</Text><Text>r{content.revision}</Text></div>
    {content.blocks.map((block, index) => <section key={`${block.type}-${index}`} className={`is-${block.type}`}>
      <small>{BLOCK_LABEL[block.type]}</small>
      {textField(block.data.title) === '' ? null : <h2>{textField(block.data.title)}</h2>}
      {textField(block.data.body) === '' ? null : <p>{textField(block.data.body)}</p>}
    </section>)}
    <footer><strong>SEO</strong><span>{content.seo.title ?? content.title}</span><small>{content.seo.description ?? content.summary}</small></footer>
  </div>;
}

function RevisionHistory({ content, revisions, onPreview, onRollback }: {
  readonly content: MarketingContentDetail;
  readonly revisions: readonly MarketingRevisionView[];
  readonly onPreview: (content: MarketingContentDetail) => void;
  readonly onRollback: (revision: number) => void;
}) {
  return <div className="cms-history">
    <Descriptions size="small" column={2} items={[
      { key: 'status', label: '当前状态', children: STATUS[content.status].text },
      { key: 'revision', label: '当前修订', children: `r${content.revision}` },
      { key: 'locale', label: '语言', children: content.locale },
      { key: 'slug', label: '路径', children: `/${content.slug}` },
    ]} />
    <Timeline items={[...revisions].reverse().map((revision) => ({
      color: revision.revision === content.revision ? 'green' : 'gray',
      children: <article><div><strong>修订 r{revision.revision}</strong><time>{revision.createdAt === null ? '未知时间' : formatDateTime(revision.createdAt)}</time></div>
        <p>{revision.snapshot.title} · {revision.snapshot.blocks.length} 个区块</p>
        <Space><Button size="small" icon={<EyeOutlined />} onClick={() => onPreview(revision.snapshot)}>查看快照</Button>
          {revision.revision < content.revision ? <Button size="small" onClick={() => onRollback(revision.revision)}>从此版本创建草稿</Button> : null}</Space>
      </article>,
    }))} />
  </div>;
}

function MediaLibrary({ items, loading }: { readonly items: readonly MarketingMediaView[]; readonly loading: boolean }) {
  if (loading) return <div className="cms-media-loading">正在读取素材库…</div>;
  if (items.length === 0) return <Empty description="还没有符合条件的媒体素材" />;
  return <div className="cms-media-grid">{items.map((asset) => {
    const previewUrl = asset.variants.thumb ?? asset.variants.small ?? asset.variants.original;
    return <article key={asset.id}>
      <div className="cms-media-cover" style={previewUrl === undefined ? undefined : { backgroundImage: `url("${previewUrl}")` }}>
        {previewUrl === undefined ? <FileTextOutlined /> : null}
        <Tag color={asset.status === 'ready' ? 'success' : asset.status === 'rejected' ? 'error' : 'processing'}>{asset.status}</Tag>
      </div>
      <div className="cms-media-body"><strong title={asset.fileName}>{asset.fileName}</strong>
        <span>{asset.mimeType} · {formatBytes(asset.sizeBytes)}</span>
        <p>{asset.altText['zh-CN'] ?? asset.altText.en ?? '缺少替代文本'}</p>
        <footer><span>{asset.copyrightSource || '未登记版权来源'}</span><time>{formatDate(asset.createdAt)}</time></footer>
      </div>
    </article>;
  })}</div>;
}

function LeadPipeline({ leads, active, onChange }: {
  readonly leads: readonly MarketingLeadView[];
  readonly active: MarketingLeadStatus | 'all';
  readonly onChange: (status: MarketingLeadStatus | 'all') => void;
}) {
  const stages: readonly (MarketingLeadStatus | 'all')[] = ['all', 'new', 'contacted', 'qualified', 'converted'];
  return <div className="cms-lead-pipeline">{stages.map((status) => <button key={status}
    className={active === status ? 'is-active' : ''} onClick={() => onChange(status)}>
    <span>{status === 'all' ? '全部线索' : LEAD_STATUS[status]}</span>
    <strong>{status === 'all' ? leads.length : leads.filter((lead) => lead.status === status).length}</strong>
  </button>)}</div>;
}

function contentActions(item: MarketingContentSummary, profile: IdentityProfileView | null) {
  const actions: Array<{ key: string; label: string; icon?: React.ReactNode; danger?: boolean } | { type: 'divider' }> = [
    { key: 'edit', label: '编辑内容', icon: <EditOutlined /> },
    { key: 'history', label: '修订历史', icon: <HistoryOutlined /> },
  ];
  if (hasMarketingPermission(profile, marketingPermissions.aiGenerate, marketingPermissions.contentRead)) {
    actions.push({ key: 'ai', label: 'AI 内容助手', icon: <RobotOutlined /> });
  }
  actions.push({ type: 'divider' });
  if (item.status === 'draft' && hasMarketingPermission(profile, marketingPermissions.contentSubmit, marketingPermissions.contentRead)) {
    actions.push({ key: 'submit', label: '提交审核', icon: <SendOutlined /> });
  }
  if (item.status === 'in_review' && hasMarketingPermission(profile, marketingPermissions.contentApprove, marketingPermissions.contentRead)) {
    actions.push({ key: 'approve', label: '批准内容', icon: <CheckCircleOutlined /> });
  }
  if (item.status === 'approved' && hasMarketingPermission(profile, marketingPermissions.contentPublish, marketingPermissions.contentRead)) {
    actions.push({ key: 'publish', label: '立即发布', icon: <GlobalOutlined /> },
      { key: 'schedule', label: '安排发布', icon: <ClockCircleOutlined /> });
  }
  if (item.status === 'published' && hasMarketingPermission(profile, marketingPermissions.contentPublish, marketingPermissions.contentRead)) {
    actions.push({ key: 'withdraw', label: '撤回内容', danger: true });
  }
  if (item.status === 'archived' && hasMarketingPermission(profile, marketingPermissions.contentUpdate, marketingPermissions.contentRead)) {
    actions.push({ key: 'restore', label: '恢复草稿' });
  }
  if (item.revision > 1 && hasMarketingPermission(profile, marketingPermissions.contentRollback, marketingPermissions.contentRead)) {
    actions.push({ key: 'rollback', label: '版本回滚', icon: <HistoryOutlined /> });
  }
  return actions;
}

function validateRestResult(attempt: PendingRestWrite, value: unknown): void {
  if (['content-create', 'content-update', 'content-transition', 'content-schedule', 'content-rollback'].includes(attempt.kind)) {
    const content = parseMarketingContentMutation(value);
    if ((attempt.targetId !== undefined && content.id !== attempt.targetId) ||
      content.status !== attempt.expectedStatus || content.version !== attempt.expectedVersion) {
      throw new Error('MARKETING_CONTENT_MUTATION_RESULT_MISMATCH');
    }
    return;
  }
  if (attempt.kind === 'lead-status') {
    const lead = parseMarketingLeadMutation(value);
    if (lead.id !== attempt.targetId || lead.status !== attempt.expectedStatus ||
      lead.version !== attempt.expectedVersion) throw new Error('MARKETING_LEAD_MUTATION_RESULT_MISMATCH');
    return;
  }
  if (attempt.kind === 'lead-assignee') {
    const lead = parseMarketingLeadAssigneeMutation(value);
    if (lead.id !== attempt.targetId || lead.version !== attempt.expectedVersion) {
      throw new Error('MARKETING_LEAD_ASSIGNEE_RESULT_MISMATCH');
    }
    return;
  }
  if (attempt.kind === 'lead-note') {
    const lead = parseMarketingLeadNoteMutation(value);
    if (lead.id !== attempt.targetId || lead.version !== attempt.expectedVersion) {
      throw new Error('MARKETING_LEAD_NOTE_RESULT_MISMATCH');
    }
    return;
  }
  if (attempt.kind === 'ai-generate') {
    if (parseMarketingAiDraft(value).status !== attempt.expectedStatus) {
      throw new Error('MARKETING_AI_DRAFT_RESULT_MISMATCH');
    }
    return;
  }
  const review = parseMarketingAiReview(value);
  if (review.id !== attempt.targetId || review.status !== attempt.expectedStatus) {
    throw new Error('MARKETING_AI_REVIEW_RESULT_MISMATCH');
  }
}

function hasLocalePair(item: MarketingContentSummary, items: readonly MarketingContentSummary[]): boolean {
  return items.some((candidate) => candidate.id !== item.id && candidate.type === item.type &&
    candidate.slug === item.slug && candidate.locale !== item.locale);
}

function contentCompleteness(item: MarketingContentSummary, items: readonly MarketingContentSummary[]): number {
  let score = 25;
  if (item.summary.trim().length >= 20) score += 20;
  if (hasLocalePair(item, items)) score += 25;
  if (item.revision > 1) score += 10;
  if (['approved', 'scheduled', 'published'].includes(item.status)) score += 20;
  return Math.min(100, score);
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function canonicalFutureSchedule(value: string): string | null {
  const parsed = new Date(value.trim());
  const timestamp = parsed.getTime();
  const now = Date.now();
  if (Number.isNaN(timestamp) || timestamp < now + 60_000 || timestamp > now + 366 * 86_400_000) return null;
  return parsed.toISOString();
}

function validMediaFile(file: File): boolean {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf'].includes(file.type) &&
    file.size >= 1 && file.size <= 20_971_520 && file.name.length >= 1 && file.name.length <= 180 &&
    !/[/\\\0]/u.test(file.name);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof ErpApiError) {
    return `${value.message}（${value.code}${value.traceId === null ? '' : `，${value.traceId}`}）`;
  }
  return value instanceof Error && /^[\p{Script=Han}A-Za-z0-9（）()，、。；：:_ -]{1,200}$/u.test(value.message)
    ? value.message : fallback;
}

function writeErrorMessage(value: unknown, fallback: string, uncertain: boolean): string {
  const message = errorMessage(value, fallback);
  return uncertain ? `${message}。结果尚未确认，请使用“重试原请求”；系统会复用同一请求和幂等键。` : message;
}
