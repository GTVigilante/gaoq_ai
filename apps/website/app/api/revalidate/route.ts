import { revalidateTag } from 'next/cache';
import { timingSafeEqual } from 'node:crypto';

/** 接收受信发布事件并失效对应 ISR 标签；不得由浏览器直接调用。 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.MARKETING_REVALIDATE_SECRET;
  const authorization = request.headers.get('authorization');
  if (
    secret === undefined ||
    authorization === null ||
    !safeEqual(authorization, `Bearer ${secret}`)
  ) return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isPublishedEvent(body)) return Response.json({ code: 'EVENT_INVALID' }, { status: 400 });
  revalidateTag(
    `marketing:${body.data.locale}:${body.data.contentType}:${body.data.slug}`,
    'max',
  );
  return Response.json({ revalidated: true });
}

function isPublishedEvent(value: unknown): value is {
  readonly type: 'cn.gaoq.erp.marketing.content.published.v1';
  readonly data: {
    readonly locale: 'zh-CN' | 'en';
    readonly contentType: string;
    readonly slug: string;
  };
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.type !== 'cn.gaoq.erp.marketing.content.published.v1' ||
    typeof record.data !== 'object' ||
    record.data === null ||
    Array.isArray(record.data)
  ) return false;
  const data = record.data as Record<string, unknown>;
  return (data.locale === 'zh-CN' || data.locale === 'en') &&
    typeof data.contentType === 'string' &&
    ['page', 'service', 'case', 'article', 'team', 'testimonial', 'faq',
      'navigation', 'footer', 'site_config'].includes(data.contentType) &&
    typeof data.slug === 'string' &&
    /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(data.slug);
}

function safeEqual(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}
