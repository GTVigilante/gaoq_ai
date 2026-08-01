import type { MetadataRoute } from 'next';
import { getPublishedContentList } from './lib/cms';
import { locales, serviceSlugs, type Locale } from './lib/content';

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
    (['article', 'case'] as const)
      .map((type) => publishedEntries(origin, locale, type))));
  return [...staticEntries, ...dynamicEntries.flat()];
}

async function publishedEntries(
  origin: string,
  locale: Locale,
  type: 'article' | 'case',
): Promise<MetadataRoute.Sitemap> {
  const items = await getPublishedContentList(locale, type);
  return items.map((item) => {
    const section = type === 'article' ? 'insights' : 'cases';
    return {
      url: `${origin}/${locale}/${section}/${item.slug}`,
      lastModified: new Date(item.publishedAt),
      changeFrequency: 'monthly',
      priority: 0.7,
    };
  });
}
