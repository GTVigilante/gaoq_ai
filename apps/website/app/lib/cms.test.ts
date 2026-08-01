import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPublishedContent,
  getPublishedContentList,
  getPublishedPage,
} from './cms';

const envelope = (data: unknown) => ({
  code: 'SUCCESS',
  message: '成功',
  data,
  traceId: 'trace-public-001',
  timestamp: '2026-07-29T16:00:00.000Z',
});

const detail = {
  id: 'content-001',
  siteId: 'gaoq',
  type: 'article',
  locale: 'zh-CN',
  slug: 'safe-article',
  title: '可信文章',
  summary: '公开摘要',
  revision: 3,
  publishedAt: '2026-07-29T15:00:00.000Z',
  blocks: [{ type: 'rich_text', data: { title: '正文', body: '安全内容' } }],
  seo: { title: 'SEO 标题' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Website CMS 客户端', () => {
  it('按请求维度解析公开详情并绑定 ISR 标签', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(envelope(detail)),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPublishedContent('zh-CN', 'article', 'safe-article'))
      .resolves.toMatchObject({ id: 'content-001', revision: 3 });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/marketing/public/zh-CN/contents/article/safe-article',
      {
        headers: { accept: 'application/json' },
        next: {
          revalidate: 300,
          tags: ['marketing:zh-CN:article:safe-article'],
        },
      },
    );
  });

  it('上游路由错配、未知字段、非 JSON 与网络失败均失败关闭', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope({
        ...detail,
        locale: 'en',
      })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope({
        ...detail,
        tenantId: 'tenant-secret',
      })), { status: 200 }))
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }))
      .mockRejectedValueOnce(new Error('network secret'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPublishedContent('zh-CN', 'article', 'safe-article'))
      .resolves.toBeNull();
    await expect(getPublishedContent('zh-CN', 'article', 'safe-article'))
      .resolves.toBeNull();
    await expect(getPublishedContent('zh-CN', 'article', 'safe-article'))
      .resolves.toBeNull();
    await expect(getPublishedContent('zh-CN', 'article', 'safe-article'))
      .resolves.toBeNull();
  });

  it('首页详情固定 page 类型，列表只返回严格摘要', async () => {
    const page = {
      ...detail,
      type: 'page',
      slug: 'home',
      blocks: [],
    };
    const item = publicSummary(detail);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope(page)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope({
        items: [item],
      })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPublishedPage('zh-CN', 'home'))
      .resolves.toMatchObject({ type: 'page', slug: 'home' });
    await expect(getPublishedContentList('zh-CN', 'article'))
      .resolves.toEqual([expect.objectContaining({ slug: 'safe-article' })]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://localhost:3001/api/marketing/public/zh-CN/contents/article',
      {
        headers: { accept: 'application/json' },
        next: {
          revalidate: 300,
          tags: ['marketing:zh-CN:article:list'],
        },
      },
    );
  });

  it('首页与列表的网络、HTTP、JSON 和契约异常均走各自失败关闭分支', async () => {
    const page = {
      ...detail,
      type: 'page',
      slug: 'home',
      blocks: [],
    };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('page network secret'))
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope({
        ...page,
        slug: 'other',
      })), { status: 200 }))
      .mockRejectedValueOnce(new Error('list network secret'))
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPublishedPage('zh-CN', 'home')).resolves.toBeNull();
    await expect(getPublishedPage('zh-CN', 'home')).resolves.toBeNull();
    await expect(getPublishedPage('zh-CN', 'home')).resolves.toBeNull();
    await expect(getPublishedContentList('zh-CN', 'article')).resolves.toEqual([]);
    await expect(getPublishedContentList('zh-CN', 'article')).resolves.toEqual([]);
    await expect(getPublishedContentList('zh-CN', 'article')).resolves.toEqual([]);
  });

  it('列表响应含正文、重复 slug 或乱序时返回空数组', async () => {
    const item = publicSummary(detail);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope({
        items: [detail],
      })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope({
        items: [item, { ...item, id: 'content-002' }],
      })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope({
        items: [
          item,
          {
            ...item,
            id: 'content-002',
            slug: 'newer',
            publishedAt: '2026-07-29T15:30:00.000Z',
          },
        ],
      })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPublishedContentList('zh-CN', 'article')).resolves.toEqual([]);
    await expect(getPublishedContentList('zh-CN', 'article')).resolves.toEqual([]);
    await expect(getPublishedContentList('zh-CN', 'article')).resolves.toEqual([]);
  });
});

function publicSummary(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'blocks' && key !== 'seo'),
  );
}
