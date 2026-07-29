import type { Locale } from './content';
import {
  parsePublishedContentListResponse,
  parsePublishedContentResponse,
  type MarketingContentType,
  type PublishedContent,
  type PublishedContentSummary,
} from './marketing-public-contract';

export type {
  PublishedBlock,
  PublishedContent,
  PublishedContentSummary,
} from './marketing-public-contract';

const API_ORIGIN = process.env.ERP_API_INTERNAL_ORIGIN ??
  process.env.NEXT_PUBLIC_ERP_API_ORIGIN ?? 'http://localhost:3001';

/** 获取 CMS 已发布页面；API 不可用或内容未发布时返回空并使用版本化站点种子。 */
export async function getPublishedPage(
  locale: Locale,
  slug: string,
): Promise<PublishedContent | null> {
  const response = await fetch(
    `${API_ORIGIN}/api/marketing/public/${encodeURIComponent(locale)}/contents/page/${encodeURIComponent(slug)}`,
    {
      headers: { accept: 'application/json' },
      next: { revalidate: 300, tags: [`marketing:${locale}:page:${slug}`] },
    },
  ).catch(() => null);
  if (response?.ok !== true) return null;
  const value: unknown = await response.json().catch(() => null);
  try {
    return parsePublishedContentResponse(value, { locale, type: 'page', slug });
  } catch {
    return null;
  }
}

export async function getPublishedContent(
  locale: Locale,
  type: Extract<MarketingContentType, 'page' | 'service' | 'article' | 'case'>,
  slug: string,
): Promise<PublishedContent | null> {
  const response = await fetch(
    `${API_ORIGIN}/api/marketing/public/${encodeURIComponent(locale)}/contents/${type}/${encodeURIComponent(slug)}`,
    {
      headers: { accept: 'application/json' },
      next: { revalidate: 300, tags: [`marketing:${locale}:${type}:${slug}`] },
    },
  ).catch(() => null);
  if (response?.ok !== true) return null;
  const value: unknown = await response.json().catch(() => null);
  try {
    return parsePublishedContentResponse(value, { locale, type, slug });
  } catch {
    return null;
  }
}

/** 获取公开内容摘要列表；响应畸形时失败关闭为空列表。 */
export async function getPublishedContentList(
  locale: Locale,
  type: Extract<MarketingContentType, 'article' | 'case'>,
): Promise<readonly PublishedContentSummary[]> {
  const response = await fetch(
    `${API_ORIGIN}/api/marketing/public/${encodeURIComponent(locale)}/contents/${type}`,
    {
      headers: { accept: 'application/json' },
      next: { revalidate: 300, tags: [`marketing:${locale}:${type}:list`] },
    },
  ).catch(() => null);
  if (response?.ok !== true) return [];
  const value: unknown = await response.json().catch(() => null);
  try {
    return parsePublishedContentListResponse(value, { locale, type });
  } catch {
    return [];
  }
}
