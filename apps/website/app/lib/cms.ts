import type { Locale } from './content';

export interface PublishedBlock {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}
export interface PublishedContent {
  readonly id: string;
  readonly siteId: string;
  readonly type: string;
  readonly locale: Locale;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly blocks: readonly PublishedBlock[];
  readonly seo: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly publishedAt: string;
}

const API_ORIGIN = process.env.ERP_API_INTERNAL_ORIGIN ??
  process.env.NEXT_PUBLIC_ERP_API_ORIGIN ?? 'http://localhost:3001';

/** 获取 CMS 已发布页面；API 不可用或内容未发布时返回空并使用版本化站点种子。 */
export async function getPublishedPage(
  locale: Locale,
  slug: string,
): Promise<PublishedContent | null> {
  const response = await fetch(
    `${API_ORIGIN}/api/marketing/public/${encodeURIComponent(locale)}/contents/page/${encodeURIComponent(slug)}`,
    { next: { revalidate: 300, tags: [`marketing:${locale}:page:${slug}`] } },
  ).catch(() => null);
  if (response?.ok !== true) return null;
  const value: unknown = await response.json().catch(() => null);
  if (!isRecord(value) || !isRecord(value.data) || !isContent(value.data)) return null;
  return value.data;
}

export async function getPublishedContent(
  locale: Locale,
  type: 'page' | 'service' | 'article' | 'case',
  slug: string,
): Promise<PublishedContent | null> {
  const response = await fetch(
    `${API_ORIGIN}/api/marketing/public/${encodeURIComponent(locale)}/contents/${type}/${encodeURIComponent(slug)}`,
    { next: { revalidate: 300, tags: [`marketing:${locale}:${type}:${slug}`] } },
  ).catch(() => null);
  if (response?.ok !== true) return null;
  const value: unknown = await response.json().catch(() => null);
  if (!isRecord(value) || !isRecord(value.data) || !isContent(value.data)) return null;
  return value.data;
}

function isContent(value: Record<string, unknown>): value is Record<string, unknown> & PublishedContent {
  return typeof value.id === 'string' && typeof value.title === 'string' &&
    typeof value.slug === 'string' && Array.isArray(value.blocks) &&
    value.blocks.every((block) => isRecord(block) && typeof block.type === 'string' && isRecord(block.data));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
