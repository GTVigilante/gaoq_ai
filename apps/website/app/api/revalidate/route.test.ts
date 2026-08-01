import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
}));

import { revalidateTag } from 'next/cache';
import { POST } from './route';

const SECRET = 'website-revalidate-secret-at-least-32-characters';

afterEach(() => {
  delete process.env.MARKETING_REVALIDATE_SECRET;
  vi.clearAllMocks();
});

describe('Website CMS 重验证入口', () => {
  it('认证发布事件后同时失效详情和列表标签', async () => {
    process.env.MARKETING_REVALIDATE_SECRET = SECRET;
    const request = new Request('https://www.example.invalid/api/revalidate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'cn.gaoq.erp.marketing.content.published.v1',
        data: {
          siteId: 'gaoq',
          contentId: 'content-001',
          contentType: 'article',
          locale: 'zh-CN',
          slug: 'safe-article',
          revision: 3,
        },
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revalidated: true });
    expect(revalidateTag).toHaveBeenNthCalledWith(
      1,
      'marketing:zh-CN:article:safe-article',
      'max',
    );
    expect(revalidateTag).toHaveBeenNthCalledWith(
      2,
      'marketing:zh-CN:article:list',
      'max',
    );
  });

  it('缺失密钥、错误凭据与畸形事件全部失败关闭', async () => {
    const body = JSON.stringify({
      type: 'cn.gaoq.erp.marketing.content.published.v1',
      data: {
        contentType: 'article',
        locale: 'zh-CN',
        slug: 'safe-article',
      },
    });

    const missingSecret = await POST(new Request(
      'https://www.example.invalid/api/revalidate',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      },
    ));
    expect(missingSecret.status).toBe(503);

    process.env.MARKETING_REVALIDATE_SECRET = 'short';
    const malformedSecret = await POST(new Request(
      'https://www.example.invalid/api/revalidate',
      {
        method: 'POST',
        headers: { authorization: 'Bearer short' },
        body,
      },
    ));
    expect(malformedSecret.status).toBe(503);

    process.env.MARKETING_REVALIDATE_SECRET = SECRET;
    const wrongSecret = await POST(new Request(
      'https://www.example.invalid/api/revalidate',
      {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-secret' },
        body,
      },
    ));
    expect(wrongSecret.status).toBe(401);

    const invalidEvent = await POST(new Request(
      'https://www.example.invalid/api/revalidate',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          type: 'cn.gaoq.erp.marketing.content.published.v1',
          data: {
            contentType: 'article',
            locale: 'zh-CN',
            slug: '../secret',
          },
        }),
      },
    ));
    expect(invalidEvent.status).toBe(400);

    const invalidJson = await POST(new Request(
      'https://www.example.invalid/api/revalidate',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
        body: 'not-json',
      },
    ));
    expect(invalidJson.status).toBe(400);

    for (const invalidBody of [
      null,
      [],
      { type: 'wrong', data: {} },
      {
        type: 'cn.gaoq.erp.marketing.content.published.v1',
        data: null,
      },
      {
        type: 'cn.gaoq.erp.marketing.content.published.v1',
        data: [],
      },
      {
        type: 'cn.gaoq.erp.marketing.content.published.v1',
        data: { locale: 'fr', contentType: 'article', slug: 'safe-article' },
      },
      {
        type: 'cn.gaoq.erp.marketing.content.published.v1',
        data: { locale: 'en', contentType: 'unknown', slug: 'safe-article' },
      },
    ]) {
      const response = await POST(new Request(
        'https://www.example.invalid/api/revalidate',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}` },
          body: JSON.stringify(invalidBody),
        },
      ));
      expect(response.status).toBe(400);
    }
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('拒绝非 JSON、超限或非 UTF-8 正文以及不精确事件', async () => {
    process.env.MARKETING_REVALIDATE_SECRET = SECRET;
    const baseEvent = {
      type: 'cn.gaoq.erp.marketing.content.published.v1',
      data: {
        siteId: 'gaoq',
        contentId: 'content-001',
        contentType: 'article',
        locale: 'zh-CN',
        slug: 'safe-article',
        revision: 3,
      },
    };
    const requests = [
      new Request('https://www.example.invalid/api/revalidate', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SECRET}`,
          'content-type': 'text/plain',
        },
        body: JSON.stringify(baseEvent),
      }),
      new Request('https://www.example.invalid/api/revalidate', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SECRET}`,
          'content-type': 'application/json',
          'content-length': String(16 * 1024 + 1),
        },
        body: JSON.stringify(baseEvent),
      }),
      new Request('https://www.example.invalid/api/revalidate', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ padding: 'x'.repeat(16 * 1024) }),
      }),
      new Request('https://www.example.invalid/api/revalidate', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SECRET}`,
          'content-type': 'application/json',
        },
        body: new Uint8Array([0xc3, 0x28]),
      }),
      ...[
        { ...baseEvent, extra: true },
        { ...baseEvent, data: { ...baseEvent.data, extra: true } },
        { ...baseEvent, data: { ...baseEvent.data, siteId: '../tenant' } },
        { ...baseEvent, data: { ...baseEvent.data, contentId: '' } },
        { ...baseEvent, data: { ...baseEvent.data, revision: 0 } },
      ].map((body) => new Request('https://www.example.invalid/api/revalidate', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SECRET}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      })),
    ];

    for (const request of requests) {
      const response = await POST(request);
      expect(response.status).toBe(400);
    }
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
