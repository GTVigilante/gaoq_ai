import type { IdentityProfileView } from './approval-contract';

export type MarketingLocale = 'zh-CN' | 'en';
export type MarketingContentStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'archived';
export type MarketingLeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'unqualified'
  | 'converted'
  | 'closed';

export interface MarketingContentSummary {
  readonly id: string;
  readonly siteId: string;
  readonly type: string;
  readonly locale: MarketingLocale;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly status: MarketingContentStatus;
  readonly revision: number;
  readonly version: number;
}

export interface MarketingLeadView {
  readonly id: string;
  readonly audience: 'creator' | 'brand';
  readonly name: string;
  readonly contact: string;
  readonly requestSummary: string;
  readonly status: MarketingLeadStatus;
  readonly version: number;
  readonly createdAt: string;
}

export interface MarketingLeadMutation {
  readonly id: string;
  readonly status: MarketingLeadStatus;
  readonly version: number;
}

export interface MarketingMediaView {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly status: 'uploading' | 'scanning' | 'ready' | 'rejected';
  readonly version: number;
  readonly variants: Readonly<Record<string, string>>;
}

export interface MarketingUploadTicket {
  readonly id: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly version: number;
}

export interface MarketingAiDraftView {
  readonly id: string;
  readonly status: 'pending_review';
  readonly output: Readonly<Record<string, unknown>>;
}

export interface MarketingAiReviewView {
  readonly id: string;
  readonly contentId: string;
  readonly action: 'translate' | 'rewrite' | 'outline' | 'seo' | 'alt_text';
  readonly status: 'accepted' | 'rejected';
}

export interface MarketingContentInput {
  readonly siteId: string;
  readonly type: string;
  readonly locale: MarketingLocale;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly blocks: readonly [{
    readonly type: 'hero';
    readonly data: Readonly<{ readonly title: string; readonly body: string }>;
  }];
  readonly seo: Readonly<{ readonly title: string; readonly description: string }>;
}

export interface MarketingContentFormValue {
  readonly siteId: string;
  readonly type: string;
  readonly locale: MarketingLocale;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string;
  readonly heroTitle: string;
  readonly heroBody: string;
  readonly seoTitle?: string;
  readonly seoDescription?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/u;
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTENT_TYPE = /^(?:page|service|case|article|team|testimonial|faq|navigation|footer|site_config)$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'application/pdf',
]);
const CONTENT_STATUSES = new Set<MarketingContentStatus>([
  'draft', 'in_review', 'approved', 'scheduled', 'published', 'archived',
]);
const LEAD_STATUSES = new Set<MarketingLeadStatus>([
  'new', 'contacted', 'qualified', 'unqualified', 'converted', 'closed',
]);
const MEDIA_STATUSES = new Set<MarketingMediaView['status']>([
  'uploading', 'scanning', 'ready', 'rejected',
]);
const AI_ACTIONS = new Set<MarketingAiReviewView['action']>([
  'translate', 'rewrite', 'outline', 'seo', 'alt_text',
]);
const EXECUTABLE_MARKUP = /<\s*script|javascript:|data:\s*text\/html|on[a-z]+\s*=/iu;
const CONTENT_KEYS = [
  'id', 'siteId', 'type', 'locale', 'slug', 'title', 'summary',
  'status', 'revision', 'version',
] as const;
const LEAD_KEYS = [
  'id', 'audience', 'name', 'contact', 'requestSummary', 'status', 'version', 'createdAt',
] as const;
const MEDIA_KEYS = ['id', 'fileName', 'mimeType', 'status', 'version', 'variants'] as const;

/** 构造 CMS 创建请求；所有自由文本在进入请求快照前规范化并受限。 */
export function buildMarketingContentInput(value: MarketingContentFormValue): MarketingContentInput {
  const siteId = normalized(value.siteId, 1, 128, 'MARKETING_CONTENT_INPUT_INVALID');
  const type = normalized(value.type, 1, 64, 'MARKETING_CONTENT_INPUT_INVALID');
  const slug = normalized(value.slug, 1, 160, 'MARKETING_CONTENT_INPUT_INVALID');
  const title = normalized(value.title, 1, 160, 'MARKETING_CONTENT_INPUT_INVALID');
  const summary = optionalNormalized(value.summary, 500, 'MARKETING_CONTENT_INPUT_INVALID');
  const heroTitle = normalized(value.heroTitle, 1, 200, 'MARKETING_CONTENT_INPUT_INVALID');
  const heroBody = normalized(value.heroBody, 1, 5_000, 'MARKETING_CONTENT_INPUT_INVALID');
  const seoTitle = optionalNormalized(value.seoTitle, 160, 'MARKETING_CONTENT_INPUT_INVALID') || title;
  const seoDescription =
    optionalNormalized(value.seoDescription, 500, 'MARKETING_CONTENT_INPUT_INVALID') || summary;
  if (
    !SITE_ID.test(siteId) ||
    !CONTENT_TYPE.test(type) ||
    (value.locale !== 'zh-CN' && value.locale !== 'en') ||
    !SLUG.test(slug) ||
    [title, summary, heroTitle, heroBody, seoTitle, seoDescription].some(hasExecutableMarkup)
  ) throw new Error('MARKETING_CONTENT_INPUT_INVALID');
  return deepFreeze({
    siteId,
    type,
    locale: value.locale,
    slug,
    title,
    summary,
    blocks: [{ type: 'hero', data: { title: heroTitle, body: heroBody } }],
    seo: { title: seoTitle, description: seoDescription },
  });
}

/** 校验内容列表的最小公开契约。 */
export function parseMarketingContentList(value: unknown): readonly MarketingContentSummary[] {
  const record = objectRecord(value, 'MARKETING_CONTENT_LIST_INVALID');
  if (!exactKeys(record, ['items']) || !Array.isArray(record.items) || record.items.length > 500) {
    throw new Error('MARKETING_CONTENT_LIST_INVALID');
  }
  return Object.freeze(record.items.map(parseContentSummary));
}

/** 校验所有内容写接口的统一最小结果。 */
export function parseMarketingContentMutation(value: unknown): MarketingContentSummary {
  const record = objectRecord(value, 'MARKETING_CONTENT_MUTATION_INVALID');
  if (!exactKeys(record, ['content'])) throw new Error('MARKETING_CONTENT_MUTATION_INVALID');
  return parseContentSummary(record.content);
}

/** 校验含联系信息的 R1 线索列表，拒绝归因、备注和内部负责人字段。 */
export function parseMarketingLeadList(value: unknown): readonly MarketingLeadView[] {
  const record = objectRecord(value, 'MARKETING_LEAD_LIST_INVALID');
  if (!exactKeys(record, ['items']) || !Array.isArray(record.items) || record.items.length > 500) {
    throw new Error('MARKETING_LEAD_LIST_INVALID');
  }
  return Object.freeze(record.items.map(parseLead));
}

/** 校验线索状态写入结果。 */
export function parseMarketingLeadMutation(value: unknown): MarketingLeadMutation {
  const record = objectRecord(value, 'MARKETING_LEAD_MUTATION_INVALID');
  if (
    !exactKeys(record, ['id', 'status', 'version']) ||
    typeof record.id !== 'string' || !ID.test(record.id) ||
    typeof record.status !== 'string' ||
    !LEAD_STATUSES.has(record.status as MarketingLeadStatus) ||
    !positiveInteger(record.version)
  ) throw new Error('MARKETING_LEAD_MUTATION_INVALID');
  return Object.freeze({
    id: record.id,
    status: record.status as MarketingLeadStatus,
    version: record.version,
  });
}

/** 校验媒体列表；对象存储引用、校验和和扫描证据不得进入浏览器。 */
export function parseMarketingMediaList(value: unknown): readonly MarketingMediaView[] {
  const record = objectRecord(value, 'MARKETING_MEDIA_LIST_INVALID');
  if (!exactKeys(record, ['items']) || !Array.isArray(record.items) || record.items.length > 500) {
    throw new Error('MARKETING_MEDIA_LIST_INVALID');
  }
  return Object.freeze(record.items.map(parseMedia));
}

/** 校验媒体验证后的最小结果。 */
export function parseMarketingMediaMutation(value: unknown): MarketingMediaView {
  return parseMedia(value);
}

/** 校验短期签名上传票据；只接受无凭据、无片段的 HTTPS URL。 */
export function parseMarketingUploadTicket(value: unknown, now = Date.now()): MarketingUploadTicket {
  const record = objectRecord(value, 'MARKETING_UPLOAD_TICKET_INVALID');
  if (
    !exactKeys(record, ['id', 'uploadUrl', 'expiresAt', 'version']) ||
    typeof record.id !== 'string' || !ID.test(record.id) ||
    typeof record.uploadUrl !== 'string' || record.uploadUrl.length > 4_096 ||
    typeof record.expiresAt !== 'string' || !canonicalIso(record.expiresAt) ||
    !positiveInteger(record.version)
  ) throw new Error('MARKETING_UPLOAD_TICKET_INVALID');
  let url: URL;
  try {
    url = new URL(record.uploadUrl);
  } catch {
    throw new Error('MARKETING_UPLOAD_TICKET_INVALID');
  }
  const expiresAt = Date.parse(record.expiresAt);
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '' ||
    expiresAt <= now || expiresAt > now + 86_400_000
  ) throw new Error('MARKETING_UPLOAD_TICKET_INVALID');
  return Object.freeze({
    id: record.id,
    uploadUrl: url.toString(),
    expiresAt: record.expiresAt,
    version: record.version,
  });
}

/** 校验 AI 草稿；拒绝可执行标记、原型污染键和无界 JSON。 */
export function parseMarketingAiDraft(value: unknown): MarketingAiDraftView {
  const record = objectRecord(value, 'MARKETING_AI_DRAFT_INVALID');
  if (
    !exactKeys(record, ['id', 'status', 'output']) ||
    typeof record.id !== 'string' || !ID.test(record.id) ||
    record.status !== 'pending_review'
  ) throw new Error('MARKETING_AI_DRAFT_INVALID');
  const output = safeJsonObject(record.output, 'MARKETING_AI_DRAFT_INVALID');
  return Object.freeze({ id: record.id, status: record.status, output });
}

/** 校验 AI 人工复核结果，禁止模型和提示词内部元数据泄漏。 */
export function parseMarketingAiReview(value: unknown): MarketingAiReviewView {
  const record = objectRecord(value, 'MARKETING_AI_REVIEW_INVALID');
  if (
    !exactKeys(record, ['id', 'contentId', 'action', 'status']) ||
    typeof record.id !== 'string' || !ID.test(record.id) ||
    typeof record.contentId !== 'string' || !ID.test(record.contentId) ||
    typeof record.action !== 'string' ||
    !AI_ACTIONS.has(record.action as MarketingAiReviewView['action']) ||
    (record.status !== 'accepted' && record.status !== 'rejected')
  ) throw new Error('MARKETING_AI_REVIEW_INVALID');
  return Object.freeze({
    id: record.id,
    contentId: record.contentId,
    action: record.action as MarketingAiReviewView['action'],
    status: record.status,
  });
}

export const marketingPermissions = Object.freeze({
  contentRead: 'erp:marketing:content:read',
  contentCreate: 'erp:marketing:content:create',
  contentSubmit: 'erp:marketing:content:submit',
  contentApprove: 'erp:marketing:content:approve',
  contentPublish: 'erp:marketing:content:publish',
  contentUpdate: 'erp:marketing:content:update',
  contentRollback: 'erp:marketing:content:rollback',
  leadRead: 'erp:marketing:lead:read',
  leadUpdate: 'erp:marketing:lead:update',
  mediaRead: 'erp:marketing:media:read',
  mediaCreate: 'erp:marketing:media:create',
  aiGenerate: 'erp:marketing:ai:generate',
  aiReview: 'erp:marketing:ai:review',
});

/** 读取入口和动作权限都必须来自同一可信身份快照。 */
export function hasMarketingPermission(
  profile: IdentityProfileView | null,
  requiredScope: string,
  readScope?: string,
): boolean {
  if (profile === null) return false;
  return profile.scopes.includes(requiredScope) &&
    (readScope === undefined || profile.scopes.includes(readScope));
}

/** 原请求只能由同一主体且在授权仍有效时重试。 */
export function canRetryMarketingWrite(
  profile: IdentityProfileView | null,
  actorId: string,
  requiredScope: string,
): boolean {
  return profile?.actorId === actorId && profile.scopes.includes(requiredScope);
}

function parseContentSummary(value: unknown): MarketingContentSummary {
  const record = objectRecord(value, 'MARKETING_CONTENT_INVALID');
  if (
    !exactKeys(record, CONTENT_KEYS) ||
    typeof record.id !== 'string' || !ID.test(record.id) ||
    typeof record.siteId !== 'string' || !SITE_ID.test(record.siteId) ||
    typeof record.type !== 'string' || !CONTENT_TYPE.test(record.type) ||
    (record.locale !== 'zh-CN' && record.locale !== 'en') ||
    typeof record.slug !== 'string' || !SLUG.test(record.slug) ||
    !boundedText(record.title, 1, 160) ||
    !boundedText(record.summary, 0, 500) ||
    typeof record.status !== 'string' ||
    !CONTENT_STATUSES.has(record.status as MarketingContentStatus) ||
    !positiveInteger(record.revision) ||
    !positiveInteger(record.version)
  ) throw new Error('MARKETING_CONTENT_INVALID');
  return Object.freeze({
    id: record.id,
    siteId: record.siteId,
    type: record.type,
    locale: record.locale,
    slug: record.slug,
    title: record.title,
    summary: record.summary,
    status: record.status as MarketingContentStatus,
    revision: record.revision,
    version: record.version,
  });
}

function parseLead(value: unknown): MarketingLeadView {
  const record = objectRecord(value, 'MARKETING_LEAD_INVALID');
  if (
    !exactKeys(record, LEAD_KEYS) ||
    typeof record.id !== 'string' || !ID.test(record.id) ||
    (record.audience !== 'creator' && record.audience !== 'brand') ||
    !boundedText(record.name, 1, 100) ||
    !boundedText(record.contact, 5, 254) ||
    !boundedText(record.requestSummary, 10, 2_000) ||
    typeof record.status !== 'string' ||
    !LEAD_STATUSES.has(record.status as MarketingLeadStatus) ||
    !positiveInteger(record.version) ||
    typeof record.createdAt !== 'string' || !canonicalIso(record.createdAt) ||
    [record.name, record.contact, record.requestSummary].some(hasExecutableMarkup)
  ) throw new Error('MARKETING_LEAD_INVALID');
  return Object.freeze({
    id: record.id,
    audience: record.audience,
    name: record.name,
    contact: record.contact,
    requestSummary: record.requestSummary,
    status: record.status as MarketingLeadStatus,
    version: record.version,
    createdAt: record.createdAt,
  });
}

function parseMedia(value: unknown): MarketingMediaView {
  const record = objectRecord(value, 'MARKETING_MEDIA_INVALID');
  if (
    !exactKeys(record, MEDIA_KEYS) ||
    typeof record.id !== 'string' || !ID.test(record.id) ||
    !boundedText(record.fileName, 1, 180) ||
    /[/\\\0]/u.test(record.fileName) ||
    typeof record.mimeType !== 'string' || !MIME_TYPES.has(record.mimeType) ||
    typeof record.status !== 'string' ||
    !MEDIA_STATUSES.has(record.status as MarketingMediaView['status']) ||
    !positiveInteger(record.version)
  ) throw new Error('MARKETING_MEDIA_INVALID');
  const variants = parseVariants(record.variants);
  return Object.freeze({
    id: record.id,
    fileName: record.fileName,
    mimeType: record.mimeType,
    status: record.status as MarketingMediaView['status'],
    version: record.version,
    variants,
  });
}

function parseVariants(value: unknown): Readonly<Record<string, string>> {
  const record = objectRecord(value, 'MARKETING_MEDIA_INVALID');
  const entries = Object.entries(record);
  if (entries.length > 12) throw new Error('MARKETING_MEDIA_INVALID');
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, rawUrl] of entries) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      !/^[a-z][a-z0-9_-]{0,31}$/u.test(key) ||
      typeof rawUrl !== 'string' ||
      rawUrl.length > 2_048
    ) {
      throw new Error('MARKETING_MEDIA_INVALID');
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('MARKETING_MEDIA_INVALID');
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
      throw new Error('MARKETING_MEDIA_INVALID');
    }
    result[key] = url.toString();
  }
  return Object.freeze(result);
}

function safeJsonObject(value: unknown, code: string): Readonly<Record<string, unknown>> {
  const state = { nodes: 0, bytes: 0 };
  const result = cloneSafeJson(value, 0, state, code);
  if (
    typeof result !== 'object' || result === null || Array.isArray(result) ||
    state.bytes > 250_000
  ) throw new Error(code);
  return result as Readonly<Record<string, unknown>>;
}

function cloneSafeJson(
  value: unknown,
  depth: number,
  state: { nodes: number; bytes: number },
  code: string,
): unknown {
  state.nodes += 1;
  if (depth > 12 || state.nodes > 5_000) throw new Error(code);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(code);
    return value;
  }
  if (typeof value === 'string') {
    state.bytes += new TextEncoder().encode(value).byteLength;
    if (hasExecutableMarkup(value)) throw new Error(code);
    return value;
  }
  if (typeof value !== 'object') throw new Error(code);
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error(code);
    return Object.freeze(value.map((item) => cloneSafeJson(item, depth + 1, state, code)));
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string') || keys.length > 256) throw new Error(code);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error(code);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined
    ) throw new Error(code);
    state.bytes += new TextEncoder().encode(key).byteLength;
    result[key] = cloneSafeJson(descriptor.value, depth + 1, state, code);
  }
  return Object.freeze(result);
}

function normalized(value: unknown, minimum: number, maximum: number, code: string): string {
  if (typeof value !== 'string') throw new Error(code);
  const result = value.normalize('NFKC').trim();
  if (result.length < minimum || result.length > maximum) throw new Error(code);
  return result;
}

function optionalNormalized(value: unknown, maximum: number, code: string): string {
  if (value === undefined || value === '') return '';
  return normalized(value, 0, maximum, code);
}

function objectRecord(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function boundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function canonicalIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function hasExecutableMarkup(value: unknown): boolean {
  return typeof value === 'string' && EXECUTABLE_MARKUP.test(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
