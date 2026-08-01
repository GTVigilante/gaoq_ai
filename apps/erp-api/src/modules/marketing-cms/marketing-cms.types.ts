import { BadRequestException } from '@nestjs/common';

import { marketingContentRequestSchema } from '../../contracts/rest-request-contracts.js';

export const MARKETING_CONTENT_TYPES = [
  'page', 'service', 'case', 'article', 'team', 'testimonial', 'faq',
  'navigation', 'footer', 'site_config',
] as const;
export const MARKETING_LOCALES = ['zh-CN', 'en'] as const;
export const MARKETING_BLOCK_TYPES = [
  'hero', 'service_grid', 'case_list', 'metrics', 'process', 'rich_text',
  'faq', 'logo_wall', 'cta',
] as const;
export const MARKETING_STATUSES = [
  'draft', 'in_review', 'approved', 'scheduled', 'published', 'archived',
] as const;
export const MARKETING_PUBLISHED_EVENT_TYPE =
  'cn.gaoq.erp.marketing.content.published.v1' as const;

export type MarketingContentType = typeof MARKETING_CONTENT_TYPES[number];
export type MarketingLocale = typeof MARKETING_LOCALES[number];
export type MarketingStatus = typeof MARKETING_STATUSES[number];
export interface MarketingBlock {
  readonly type: typeof MARKETING_BLOCK_TYPES[number];
  readonly data: Readonly<Record<string, unknown>>;
}
export interface MarketingContentInput {
  readonly siteId: string;
  readonly type: MarketingContentType;
  readonly locale: MarketingLocale;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string;
  readonly blocks: readonly MarketingBlock[];
  readonly seo?: Readonly<Record<string, string>>;
}

const DANGEROUS =
  /<\s*(?:script|iframe|object|embed|style)|javascript:|vbscript:|data:text\/html|on[a-z]+\s*=|expression\s*\(/iu;

/** 校验 CMS 受控内容，拒绝任意区块和可执行富文本。 */
export function parseContentInput(value: unknown): MarketingContentInput {
  if (!isRecord(value)) throw invalid('CMS_CONTENT_INVALID', '内容必须为对象');
  const allowed = new Set(['siteId', 'type', 'locale', 'slug', 'title', 'summary', 'blocks', 'seo']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalid('CMS_CONTENT_UNKNOWN_FIELD', '内容包含未允许字段');
  }
  if (Array.isArray(value.blocks)) {
    for (const block of value.blocks) {
      parseBlock(block);
    }
  }
  const parsed = marketingContentRequestSchema.safeParse(value);
  if (!parsed.success) throw invalid('CMS_CONTENT_INVALID', '内容字段不符合约束');
  const blocks = parsed.data.blocks.map((block) => parseBlock(block));
  const seo = parsed.data.seo === undefined ? undefined : parseSeo(parsed.data.seo);
  assertSafeText(parsed.data);
  return Object.freeze({
    siteId: parsed.data.siteId,
    type: parsed.data.type,
    locale: parsed.data.locale,
    slug: parsed.data.slug,
    title: parsed.data.title,
    ...(parsed.data.summary === undefined ? {} : { summary: parsed.data.summary }),
    blocks: Object.freeze(blocks),
    ...(seo === undefined ? {} : { seo }),
  });
}

function parseBlock(value: unknown): MarketingBlock {
  if (
    !isRecord(value) || Object.keys(value).some((key) => key !== 'type' && key !== 'data') ||
    !MARKETING_BLOCK_TYPES.includes(value.type as MarketingBlock['type']) || !isRecord(value.data)
  ) throw invalid('CMS_BLOCK_INVALID', '页面区块不在白名单内');
  return Object.freeze({
    type: value.type as MarketingBlock['type'],
    data: structuredClone(value.data),
  });
}

function parseSeo(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw invalid('CMS_SEO_INVALID', 'SEO 必须为对象');
  const allowed = new Set(['title', 'description', 'canonicalPath', 'imageRef', 'robots']);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    Object.values(value).some((item) => typeof item !== 'string' || item.length > 500)
  ) throw invalid('CMS_SEO_INVALID', 'SEO 字段不符合白名单');
  return Object.freeze({ ...(value as Record<string, string>) });
}

function assertSafeText(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized.length > 250_000 || DANGEROUS.test(serialized)) {
    throw invalid('CMS_CONTENT_UNSAFE', '内容包含不安全标记或超过大小限制');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
