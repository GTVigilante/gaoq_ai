export type MarketingLocale = 'zh-CN' | 'en';
export type MarketingContentType =
  | 'page'
  | 'service'
  | 'case'
  | 'article'
  | 'team'
  | 'testimonial'
  | 'faq'
  | 'navigation'
  | 'footer'
  | 'site_config';

export interface PublishedBlock {
  readonly type:
    | 'hero'
    | 'service_grid'
    | 'case_list'
    | 'metrics'
    | 'process'
    | 'rich_text'
    | 'faq'
    | 'logo_wall'
    | 'cta';
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PublishedContentSummary {
  readonly id: string;
  readonly siteId: string;
  readonly type: MarketingContentType;
  readonly locale: MarketingLocale;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly revision: number;
  readonly publishedAt: string;
}

export interface PublishedContent extends PublishedContentSummary {
  readonly blocks: readonly PublishedBlock[];
  readonly seo: Readonly<Record<string, string>>;
}

export interface PublicLeadResult {
  readonly leadId: string;
  readonly duplicate: boolean;
}

export interface PublishedContentExpectation {
  readonly locale: MarketingLocale;
  readonly type: MarketingContentType;
  readonly slug?: string;
}

const CONTENT_TYPES = new Set<MarketingContentType>([
  'page', 'service', 'case', 'article', 'team', 'testimonial', 'faq',
  'navigation', 'footer', 'site_config',
]);
const BLOCK_TYPES = new Set<PublishedBlock['type']>([
  'hero', 'service_grid', 'case_list', 'metrics', 'process', 'rich_text',
  'faq', 'logo_wall', 'cta',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SLUG = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const TRACE_ID = /^[A-Za-z0-9._-]{1,64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u;
const CAPTCHA_TOKEN = /^[\x21-\x7e]{16,4096}$/u;
const EXECUTABLE_MARKUP =
  /<\s*(?:script|iframe|object|embed|style)|javascript:|vbscript:|data:\s*text\/html|on[a-z]+\s*=|expression\s*\(/iu;
const ENVELOPE_KEYS = ['code', 'message', 'data', 'traceId', 'timestamp'] as const;
const CONTENT_SUMMARY_KEYS = [
  'id', 'siteId', 'type', 'locale', 'slug', 'title', 'summary', 'revision', 'publishedAt',
] as const;
const CONTENT_DETAIL_KEYS = [...CONTENT_SUMMARY_KEYS, 'blocks', 'seo'] as const;

/** 解析公开 CMS 详情响应，并把请求维度作为响应契约的一部分校验。 */
export function parsePublishedContentResponse(
  value: unknown,
  expected: PublishedContentExpectation,
): PublishedContent {
  return parseContent(successData(value, 'MARKETING_PUBLIC_CONTENT_RESPONSE_INVALID'), expected);
}

/** 解析公开 CMS 列表响应；列表只允许最小摘要，不接受正文和 SEO。 */
export function parsePublishedContentListResponse(
  value: unknown,
  expected: Omit<PublishedContentExpectation, 'slug'>,
): readonly PublishedContentSummary[] {
  const data = plainRecord(
    successData(value, 'MARKETING_PUBLIC_CONTENT_LIST_RESPONSE_INVALID'),
    'MARKETING_PUBLIC_CONTENT_LIST_RESPONSE_INVALID',
  );
  if (
    !exactKeys(data, ['items']) ||
    !Array.isArray(data.items) ||
    data.items.length > 500
  ) {
    throw new Error('MARKETING_PUBLIC_CONTENT_LIST_RESPONSE_INVALID');
  }
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  let previousPublishedAt = Number.POSITIVE_INFINITY;
  const items = data.items.map((item) => {
    const parsed = parseContentSummary(item, expected);
    const publishedAt = Date.parse(parsed.publishedAt);
    if (
      seenIds.has(parsed.id) ||
      seenSlugs.has(parsed.slug) ||
      publishedAt > previousPublishedAt
    ) {
      throw new Error('MARKETING_PUBLIC_CONTENT_LIST_RESPONSE_INVALID');
    }
    seenIds.add(parsed.id);
    seenSlugs.add(parsed.slug);
    previousPublishedAt = publishedAt;
    return parsed;
  });
  return Object.freeze(items);
}

/** 公开线索提交仅接受最小确认结果，拒绝联系人或内部路由信息回流浏览器。 */
export function parsePublicLeadResponse(value: unknown): PublicLeadResult {
  const data = plainRecord(
    successData(value, 'MARKETING_PUBLIC_LEAD_RESPONSE_INVALID'),
    'MARKETING_PUBLIC_LEAD_RESPONSE_INVALID',
  );
  if (
    !exactKeys(data, ['leadId', 'duplicate']) ||
    typeof data.leadId !== 'string' ||
    !ID.test(data.leadId) ||
    typeof data.duplicate !== 'boolean'
  ) {
    throw new Error('MARKETING_PUBLIC_LEAD_RESPONSE_INVALID');
  }
  return Object.freeze({ leadId: data.leadId, duplicate: data.duplicate });
}

/**
 * 验证验证码 iframe 消息。
 * Origin 与 Window 来源必须同时匹配，避免同源其他窗口伪造验证结果。
 */
export function parseCaptchaTokenMessage(
  expectedOrigin: string,
  expectedSource: MessageEventSource,
  event: Pick<MessageEvent<unknown>, 'origin' | 'source' | 'data'>,
): string | null {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return null;
  let data: Readonly<Record<string, unknown>>;
  try {
    data = plainRecord(event.data, 'MARKETING_CAPTCHA_MESSAGE_INVALID');
  } catch {
    return null;
  }
  if (
    !exactKeys(data, ['captchaToken']) ||
    typeof data.captchaToken !== 'string' ||
    !CAPTCHA_TOKEN.test(data.captchaToken)
  ) {
    return null;
  }
  return data.captchaToken;
}

/**
 * 判断失败是否仍可能已经提交。
 * 结果未知、限流、服务端故障与幂等处理中必须保留原键；明确拒绝才允许换键。
 */
export function shouldRetainPublicLeadRequest(
  status: number | null,
  responseBody: unknown,
): boolean {
  if (
    status === null ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  ) {
    return true;
  }
  if (status !== 409) return false;
  return readErrorCode(responseBody) !== 'IDEMPOTENCY_KEY_REUSED';
}

function parseContent(
  value: unknown,
  expected: PublishedContentExpectation,
): PublishedContent {
  const record = plainRecord(value, 'MARKETING_PUBLIC_CONTENT_INVALID');
  if (!exactKeys(record, CONTENT_DETAIL_KEYS)) {
    throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
  }
  const summary = parseContentSummary(record, expected, CONTENT_DETAIL_KEYS);
  if (!Array.isArray(record.blocks) || record.blocks.length > 40) {
    throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
  }
  const state = { nodes: 0, bytes: 0 };
  const blocks = record.blocks.map((block): PublishedBlock => {
    const item = plainRecord(block, 'MARKETING_PUBLIC_CONTENT_INVALID');
    if (
      !exactKeys(item, ['type', 'data']) ||
      typeof item.type !== 'string' ||
      !BLOCK_TYPES.has(item.type as PublishedBlock['type'])
    ) {
      throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
    }
    const data = cloneSafeJson(item.data, 0, state);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
    }
    return Object.freeze({
      type: item.type as PublishedBlock['type'],
      data: data as Readonly<Record<string, unknown>>,
    });
  });
  const seo = parseSeo(record.seo, state);
  if (state.bytes > 250_000) throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
  return Object.freeze({ ...summary, blocks: Object.freeze(blocks), seo });
}

function parseContentSummary(
  value: unknown,
  expected: Omit<PublishedContentExpectation, 'slug'> & { readonly slug?: string },
  expectedKeys: readonly string[] = CONTENT_SUMMARY_KEYS,
): PublishedContentSummary {
  const record = plainRecord(value, 'MARKETING_PUBLIC_CONTENT_INVALID');
  if (
    !exactKeys(record, expectedKeys) ||
    typeof record.id !== 'string' ||
    !ID.test(record.id) ||
    typeof record.siteId !== 'string' ||
    !ID.test(record.siteId) ||
    typeof record.type !== 'string' ||
    !CONTENT_TYPES.has(record.type as MarketingContentType) ||
    record.type !== expected.type ||
    (record.locale !== 'zh-CN' && record.locale !== 'en') ||
    record.locale !== expected.locale ||
    typeof record.slug !== 'string' ||
    !SLUG.test(record.slug) ||
    (expected.slug !== undefined && record.slug !== expected.slug) ||
    !boundedSafeText(record.title, 1, 160) ||
    !boundedSafeText(record.summary, 0, 500) ||
    !positiveInteger(record.revision) ||
    typeof record.publishedAt !== 'string' ||
    !canonicalIso(record.publishedAt)
  ) {
    throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
  }
  return Object.freeze({
    id: record.id,
    siteId: record.siteId,
    type: record.type,
    locale: record.locale,
    slug: record.slug,
    title: record.title,
    summary: record.summary,
    revision: record.revision,
    publishedAt: record.publishedAt,
  });
}

function parseSeo(
  value: unknown,
  state: { nodes: number; bytes: number },
): Readonly<Record<string, string>> {
  const record = plainRecord(value, 'MARKETING_PUBLIC_CONTENT_INVALID');
  const allowed = new Set(['title', 'description', 'canonicalPath', 'imageRef', 'robots']);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(record)) {
    if (
      !allowed.has(key) ||
      typeof item !== 'string' ||
      item.length > 500 ||
      EXECUTABLE_MARKUP.test(item)
    ) {
      throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
    }
    state.bytes += byteLength(key) + byteLength(item);
    result[key] = item;
  }
  return Object.freeze(result);
}

function successData(value: unknown, code: string): unknown {
  const envelope = plainRecord(value, code);
  if (
    !exactKeys(envelope, ENVELOPE_KEYS) ||
    envelope.code !== 'SUCCESS' ||
    !boundedSafeText(envelope.message, 1, 256) ||
    typeof envelope.traceId !== 'string' ||
    !TRACE_ID.test(envelope.traceId) ||
    typeof envelope.timestamp !== 'string' ||
    !canonicalIso(envelope.timestamp)
  ) {
    throw new Error(code);
  }
  return envelope.data;
}

function readErrorCode(value: unknown): string | null {
  try {
    const record = plainRecord(value, 'MARKETING_PUBLIC_ERROR_RESPONSE_INVALID');
    return typeof record.code === 'string' && ERROR_CODE.test(record.code)
      ? record.code
      : null;
  } catch {
    return null;
  }
}

function cloneSafeJson(
  value: unknown,
  depth: number,
  state: { nodes: number; bytes: number },
): unknown {
  state.nodes += 1;
  if (depth > 12 || state.nodes > 5_000) {
    throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
    return value;
  }
  if (typeof value === 'string') {
    state.bytes += byteLength(value);
    if (EXECUTABLE_MARKUP.test(value)) {
      throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
    }
    return value;
  }
  if (typeof value !== 'object') throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
    return Object.freeze(value.map((item) => cloneSafeJson(item, depth + 1, state)));
  }
  const record = plainRecord(value, 'MARKETING_PUBLIC_CONTENT_INVALID');
  const keys = Object.keys(record);
  if (keys.length > 256) throw new Error('MARKETING_PUBLIC_CONTENT_INVALID');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    state.bytes += byteLength(key);
    result[key] = cloneSafeJson(record[key], depth + 1, state);
  }
  return Object.freeze(result);
}

function plainRecord(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) throw new Error(code);
  for (const key of keys as string[]) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(code);
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new Error(code);
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(record, key));
}

function boundedSafeText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' &&
    value.length >= minimum &&
    value.length <= maximum &&
    !EXECUTABLE_MARKUP.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function canonicalIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
