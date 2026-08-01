import { describe, expect, it } from 'vitest';
import {
  parseCaptchaTokenMessage,
  parsePublishedContentListResponse,
  parsePublishedContentResponse,
  parsePublicLeadResponse,
  shouldRetainPublicLeadRequest,
} from './marketing-public-contract';

const NOW = '2026-07-29T16:00:00.000Z';
const TRACE_ID = 'trace-public-001';

const content = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: 'content-001',
  siteId: 'gaoq',
  type: 'article',
  locale: 'zh-CN',
  slug: 'safe-article',
  title: '可信文章',
  summary: '公开摘要',
  revision: 3,
  publishedAt: '2026-07-29T15:00:00.000Z',
  blocks: [{
    type: 'rich_text',
    data: { title: '正文', body: '安全内容', nested: [{ enabled: true }] },
  }],
  seo: { title: 'SEO 标题', description: 'SEO 描述' },
  ...overrides,
});

const summary = (overrides: Readonly<Record<string, unknown>> = {}) => {
  return Object.fromEntries(
    Object.entries(content(overrides))
      .filter(([key]) => key !== 'blocks' && key !== 'seo'),
  );
};

const envelope = (data: unknown, overrides: Readonly<Record<string, unknown>> = {}) => ({
  code: 'SUCCESS',
  message: '成功',
  data,
  traceId: TRACE_ID,
  timestamp: NOW,
  ...overrides,
});

describe('Website 营销公开契约', () => {
  it('严格解析与冻结请求维度匹配的公开详情', () => {
    const result = parsePublishedContentResponse(
      envelope(content()),
      { locale: 'zh-CN', type: 'article', slug: 'safe-article' },
    );

    expect(result).toMatchObject({
      id: 'content-001',
      locale: 'zh-CN',
      type: 'article',
      revision: 3,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.blocks)).toBe(true);
    expect(Object.isFrozen(result.blocks[0]?.data)).toBe(true);
    expect(Object.isFrozen(result.seo)).toBe(true);
  });

  it.each([
    envelope(content(), { internal: 'secret' }),
    envelope({ ...content(), tenantId: 'tenant-secret' }),
    envelope(content({ locale: 'en' })),
    envelope(content({ type: 'case' })),
    envelope(content({ slug: 'other-article' })),
    envelope(content({ publishedAt: 'not-a-date' })),
    envelope(content({
      blocks: [{ type: 'rich_text', data: { body: '<script>alert(1)</script>' } }],
    })),
    envelope(content({
      blocks: [{ type: 'unknown', data: {} }],
    })),
    envelope(content({ seo: { title: 'javascript:alert(1)' } })),
    envelope(content({ blocks: [{ type: 'rich_text', data: new Date() }] })),
  ])('拒绝畸形、错路由或可执行公开详情 %#', (value) => {
    expect(() => parsePublishedContentResponse(
      value,
      { locale: 'zh-CN', type: 'article', slug: 'safe-article' },
    )).toThrow();
  });

  it('拒绝访问器与原型对象且不执行访问器', () => {
    let calls = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'title', {
      enumerable: true,
      get() {
        calls += 1;
        return '恶意标题';
      },
    });

    expect(() => parsePublishedContentResponse(
      envelope(hostile),
      { locale: 'zh-CN', type: 'article', slug: 'safe-article' },
    )).toThrow();
    expect(calls).toBe(0);
  });

  it('拒绝无界、非 JSON、污染键和符号键的区块数据', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 14; index += 1) deep = { next: deep };
    const poison = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(poison, '__proto__', {
      enumerable: true,
      configurable: true,
      value: 'polluted',
    });
    const symbolKey = { safe: true } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = true;
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`key${String(index)}`, index]),
    );

    for (const data of [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: undefined },
      { value: () => 'not-json' },
      { values: Array.from({ length: 1_001 }, () => true) },
      tooManyKeys,
      deep,
      poison,
      symbolKey,
      { body: 'x'.repeat(250_001) },
    ]) {
      expect(() => parsePublishedContentResponse(
        envelope(content({
          blocks: [{ type: 'rich_text', data }],
          seo: {},
        })),
        { locale: 'zh-CN', type: 'article', slug: 'safe-article' },
      )).toThrow();
    }
  });

  it('响应信封、列表上限和验证码对象自身也执行严格边界', () => {
    for (const invalidEnvelope of [
      envelope(content(), { code: 'OK' }),
      envelope(content(), { message: '' }),
      envelope(content(), { traceId: 'trace with spaces' }),
      envelope(content(), { timestamp: '2026-07-29' }),
      Object.assign(Object.create({ inherited: true }), envelope(content())),
    ]) {
      expect(() => parsePublishedContentResponse(
        invalidEnvelope,
        { locale: 'zh-CN', type: 'article', slug: 'safe-article' },
      )).toThrow();
    }
    expect(() => parsePublishedContentListResponse(
      envelope({ items: Array.from({ length: 501 }, () => summary()) }),
      { locale: 'zh-CN', type: 'article' },
    )).toThrow('MARKETING_PUBLIC_CONTENT_LIST_RESPONSE_INVALID');

    const expectedSource = {} as WindowProxy;
    expect(parseCaptchaTokenMessage(
      'https://captcha.example.invalid',
      expectedSource,
      {
        origin: 'https://captcha.example.invalid',
        source: expectedSource,
        data: 'not-an-object',
      },
    )).toBeNull();
  });

  it('列表只接受按发布时间倒序且标识和 slug 唯一的最小摘要', () => {
    const result = parsePublishedContentListResponse(
      envelope({
        items: [
          summary(),
          summary({
            id: 'content-002',
            slug: 'older-article',
            publishedAt: '2026-07-29T14:00:00.000Z',
          }),
        ],
      }),
      { locale: 'zh-CN', type: 'article' },
    );

    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty('blocks');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    { items: [summary(), summary()] },
    { items: [summary(), summary({ id: 'content-002' })] },
    {
      items: [
        summary(),
        summary({
        id: 'content-002',
        slug: 'newer-article',
        publishedAt: '2026-07-29T15:30:00.000Z',
      }),
      ],
    },
    { items: [content()] },
  ])('列表拒绝重复、乱序和正文穿透 %#', ({ items }) => {
    expect(() => parsePublishedContentListResponse(
      envelope({ items }),
      { locale: 'zh-CN', type: 'article' },
    )).toThrow();
  });

  it('线索成功响应只接受最小确认字段', () => {
    expect(parsePublicLeadResponse(envelope({
      leadId: 'lead-0123456789abcdef',
      duplicate: false,
    }))).toEqual({
      leadId: 'lead-0123456789abcdef',
      duplicate: false,
    });
    expect(() => parsePublicLeadResponse(envelope({
      leadId: 'lead-0123456789abcdef',
      duplicate: false,
      contact: 'secret@example.com',
    }))).toThrow('MARKETING_PUBLIC_LEAD_RESPONSE_INVALID');
  });

  it('验证码消息必须同时来自配置 Origin 与实际 iframe Window', () => {
    const expectedSource = {} as WindowProxy;
    const otherSource = {} as WindowProxy;
    const event = {
      origin: 'https://captcha.example.invalid',
      source: expectedSource,
      data: { captchaToken: 'captcha-token-00000001' },
    };

    expect(parseCaptchaTokenMessage(
      'https://captcha.example.invalid',
      expectedSource,
      event,
    )).toBe('captcha-token-00000001');
    expect(parseCaptchaTokenMessage(
      'https://other.example.invalid',
      expectedSource,
      event,
    )).toBeNull();
    expect(parseCaptchaTokenMessage(
      'https://captcha.example.invalid',
      otherSource,
      event,
    )).toBeNull();
    expect(parseCaptchaTokenMessage(
      'https://captcha.example.invalid',
      expectedSource,
      { ...event, data: { ...event.data, extra: true } },
    )).toBeNull();
    expect(parseCaptchaTokenMessage(
      'https://captcha.example.invalid',
      expectedSource,
      { ...event, data: { captchaToken: 'token with spaces 0001' } },
    )).toBeNull();
  });

  it('弱网和可能已提交结果保留原幂等键，明确拒绝允许换键', () => {
    expect(shouldRetainPublicLeadRequest(null, null)).toBe(true);
    expect(shouldRetainPublicLeadRequest(408, null)).toBe(true);
    expect(shouldRetainPublicLeadRequest(425, null)).toBe(true);
    expect(shouldRetainPublicLeadRequest(429, null)).toBe(true);
    expect(shouldRetainPublicLeadRequest(503, null)).toBe(true);
    expect(shouldRetainPublicLeadRequest(409, {
      code: 'IDEMPOTENCY_IN_PROGRESS',
    })).toBe(true);
    expect(shouldRetainPublicLeadRequest(409, 'malformed')).toBe(true);
    expect(shouldRetainPublicLeadRequest(409, {
      code: 'IDEMPOTENCY_KEY_REUSED',
    })).toBe(false);
    expect(shouldRetainPublicLeadRequest(400, {
      code: 'MARKETING_CAPTCHA_INVALID',
    })).toBe(false);
  });
});
