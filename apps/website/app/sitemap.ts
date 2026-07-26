import type { MetadataRoute } from 'next';
import { locales, serviceSlugs } from './lib/content';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = process.env.NEXT_PUBLIC_WEBSITE_ORIGIN ?? 'http://localhost:3002';
  const paths = ['', '/creators', '/brands', '/cases', '/insights', '/about', '/contact',
    '/privacy', '/cookies', '/terms', ...serviceSlugs.map((slug) => `/services/${slug}`)];
  const staticEntries = locales.flatMap((locale) => paths.map((path) => ({
    url: `${origin}/${locale}${path}`,
    lastModified: new Date(),
    changeFrequency: path === '' ? 'weekly' as const : 'monthly' as const,
    priority: path === '' ? 1 : path === '/contact' ? 0.9 : 0.7,
    alternates: {
      languages: Object.fromEntries(locales.map((candidate) => [
        candidate, `${origin}/${candidate}${path}`,
      ])),
    },
  })));
  const dynamicEntries = await Promise.all(locales.flatMap((locale) =>
    ['article', 'case'].map((type) => publishedEntries(origin, locale, type))));
  return [...staticEntries, ...dynamicEntries.flat()];
}

async function publishedEntries(
  origin: string,
  locale: string,
  type: string,
): Promise<MetadataRoute.Sitemap> {
  const api = process.env.ERP_API_INTERNAL_ORIGIN ??
    process.env.NEXT_PUBLIC_ERP_API_ORIGIN ?? 'http://localhost:3001';
  const response = await fetch(`${api}/api/marketing/public/${locale}/contents/${type}`, {
    next: { revalidate: 300 },
  }).catch(() => null);
  if (response?.ok !== true) return [];
  const value: unknown = await response.json().catch(() => null);
  if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.items)) return [];
  return value.data.items.flatMap((item): MetadataRoute.Sitemap => {
    if (!isRecord(item) || typeof item.slug !== 'string') return [];
    const section = type === 'article' ? 'insights' : 'cases';
    return [{
      url: `${origin}/${locale}/${section}/${item.slug}`,
      lastModified: typeof item.publishedAt === 'string' ? new Date(item.publishedAt) : new Date(),
      changeFrequency: 'monthly',
      priority: 0.7,
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
