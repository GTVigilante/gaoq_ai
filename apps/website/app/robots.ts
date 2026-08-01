import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const origin = process.env.NEXT_PUBLIC_WEBSITE_ORIGIN ?? 'http://localhost:3002';
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/'] },
    sitemap: `${origin}/sitemap.xml`,
  };
}
