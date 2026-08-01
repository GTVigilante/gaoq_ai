import { revalidateTag } from 'next/cache';
import { timingSafeEqual } from 'node:crypto';

const REVALIDATION_SECRET = /^[\x21-\x7e]{32,512}$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PUBLIC_SLUG = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const MAX_EVENT_BYTES = 16 * 1024;

/** 接收受信发布事件并失效对应 ISR 标签；不得由浏览器直接调用。 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.MARKETING_REVALIDATE_SECRET;
  if (secret === undefined || !REVALIDATION_SECRET.test(secret)) {
    return Response.json({ code: 'REVALIDATION_UNAVAILABLE' }, { status: 503 });
  }
  const authorization = request.headers.get('authorization');
  if (
    authorization === null ||
    !safeEqual(authorization, `Bearer ${secret}`)
  ) return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
  const body = await readBoundedJson(request);
  if (!isPublishedEvent(body)) return Response.json({ code: 'EVENT_INVALID' }, { status: 400 });
  revalidateTag(
    `marketing:${body.data.locale}:${body.data.contentType}:${body.data.slug}`,
    'max',
  );
  revalidateTag(
    `marketing:${body.data.locale}:${body.data.contentType}:list`,
    'max',
  );
  return Response.json({ revalidated: true });
}

function isPublishedEvent(value: unknown): value is {
  readonly type: 'cn.gaoq.erp.marketing.content.published.v1';
  readonly data: {
    readonly siteId: string;
    readonly contentId: string;
    readonly locale: 'zh-CN' | 'en';
    readonly contentType: string;
    readonly slug: string;
    readonly revision: number;
  };
} {
  if (!isPlainRecord(value) || !exactKeys(value, ['type', 'data'])) return false;
  const record = value as Record<string, unknown>;
  if (
    record.type !== 'cn.gaoq.erp.marketing.content.published.v1' ||
    !isPlainRecord(record.data) ||
    !exactKeys(record.data, [
      'siteId', 'contentId', 'contentType', 'locale', 'slug', 'revision',
    ])
  ) return false;
  const data = record.data as Record<string, unknown>;
  return typeof data.siteId === 'string' &&
    PUBLIC_ID.test(data.siteId) &&
    typeof data.contentId === 'string' &&
    PUBLIC_ID.test(data.contentId) &&
    (data.locale === 'zh-CN' || data.locale === 'en') &&
    typeof data.contentType === 'string' &&
    ['page', 'service', 'case', 'article', 'team', 'testimonial', 'faq',
      'navigation', 'footer', 'site_config'].includes(data.contentType) &&
    typeof data.slug === 'string' &&
    PUBLIC_SLUG.test(data.slug) &&
    typeof data.revision === 'number' &&
    Number.isSafeInteger(data.revision) &&
    data.revision > 0;
}

function safeEqual(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const declaredLength = request.headers.get('content-length');
  if (
    contentType !== 'application/json' ||
    (declaredLength !== null && (
      !/^(?:0|[1-9][0-9]{0,5})$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_EVENT_BYTES
    )) ||
    request.body === null
  ) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_EVENT_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // 正文已判定超限；取消流失败不能改变失败关闭结果。
        }
        return null;
      }
      chunks.push(result.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}
