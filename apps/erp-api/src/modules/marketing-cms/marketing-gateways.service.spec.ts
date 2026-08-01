import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MarketingAiGateway,
  MarketingMediaGateway,
  safeMarketingAiOutput,
} from './marketing-gateways.service.js';

afterEach(() => vi.unstubAllGlobals());

const config = (values: Readonly<Record<string, string | undefined>>) => ({
  get: (name: string) => values[name],
});

describe('营销隔离网关', () => {
  it('缺少媒体配置时失败关闭', async () => {
    const gateway = new MarketingMediaGateway(config({}) as never);
    await expect(
      gateway.createUpload({ fileName: 'cover.png' }, 'media-upload-key-001'),
    ).rejects.toMatchObject({
      response: { code: 'MARKETING_MEDIA_GATEWAY_UNAVAILABLE' },
    });
  });

  it('媒体上传与扫描回执必须满足契约并透传同一幂等键', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          objectRef: 'object-ref-001',
          uploadUrl: 'https://upload.example.invalid/signed',
          expiresAt: '2026-07-29T00:00:00.000Z',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          objectRef: 'object-ref-001',
          checksum: 'a'.repeat(43),
          scanEvidenceId: 'scan-001',
          malwareClean: true,
          variants: {
            thumbnail: 'https://cdn.example.invalid/thumb.webp',
          },
        }),
      });
    vi.stubGlobal('fetch', fetch);
    const gateway = new MarketingMediaGateway(config({
      MARKETING_MEDIA_GATEWAY_ENDPOINT: 'https://media-gateway.example.invalid',
      MARKETING_MEDIA_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);

    await expect(gateway.createUpload(
      { mediaId: 'media-001' },
      'media-upload-key-001',
    )).resolves.toMatchObject({ objectRef: 'object-ref-001' });
    await expect(gateway.verifyUpload(
      { mediaId: 'media-001', objectRef: 'object-ref-001' },
      'media-verify-key-001',
    )).resolves.toMatchObject({
      malwareClean: true,
      scanEvidenceId: 'scan-001',
    });

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://media-gateway.example.invalid/v1/uploads',
    );
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      'https://media-gateway.example.invalid/v1/uploads/verify',
    );
    const firstInit = fetch.mock.calls[0]?.[1] as unknown as {
      readonly method?: unknown;
      readonly headers?: Readonly<Record<string, unknown>>;
      readonly body?: unknown;
    };
    const secondInit = fetch.mock.calls[1]?.[1] as unknown as {
      readonly headers?: Readonly<Record<string, unknown>>;
    };
    expect(firstInit).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ mediaId: 'media-001' }),
    });
    expect(firstInit.headers).toEqual({
      authorization: `Bearer ${'x'.repeat(40)}`,
      'content-type': 'application/json',
      'idempotency-key': 'media-upload-key-001',
    });
    expect(secondInit.headers).toMatchObject({
      'idempotency-key': 'media-verify-key-001',
    });
  });

  it.each([
    { ok: false, json: () => Promise.resolve({}) },
    { ok: true, json: () => Promise.resolve({ objectRef: 'short' }) },
    { ok: true, json: () => Promise.reject(new Error('invalid json')) },
  ])('媒体网关对 HTTP、契约和 JSON 故障统一失败关闭 %#', async (upstream) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream));
    const gateway = new MarketingMediaGateway(config({
      MARKETING_MEDIA_GATEWAY_ENDPOINT: 'https://media-gateway.example.invalid',
      MARKETING_MEDIA_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);

    await expect(gateway.createUpload(
      { mediaId: 'media-001' },
      'media-upload-key-002',
    )).rejects.toMatchObject({
      response: { code: 'MARKETING_MEDIA_GATEWAY_UNAVAILABLE' },
    });
  });

  it.each([
    {
      objectRef: 'object-ref-001',
      uploadUrl: 'http://upload.example.invalid/signed',
      expiresAt: '2026-07-29T00:00:00.000Z',
    },
    {
      objectRef: 'object-ref-001',
      uploadUrl: 'https://user:secret@upload.example.invalid/signed',
      expiresAt: '2026-07-29T00:00:00.000Z',
    },
    {
      objectRef: 'object-ref-001',
      uploadUrl: 'https://upload.example.invalid/signed#secret',
      expiresAt: '2026-07-29T00:00:00.000Z',
    },
  ])('媒体网关拒绝不安全的签名能力 URL %#', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    }));
    const gateway = new MarketingMediaGateway(config({
      MARKETING_MEDIA_GATEWAY_ENDPOINT: 'https://media-gateway.example.invalid',
      MARKETING_MEDIA_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);

    await expect(gateway.createUpload(
      { mediaId: 'media-001' },
      'media-upload-key-unsafe',
    )).rejects.toMatchObject({
      response: { code: 'MARKETING_MEDIA_GATEWAY_UNAVAILABLE' },
    });
  });

  it.each([
    { thumbnail: 'http://cdn.example.invalid/thumb.webp' },
    Object.fromEntries(Array.from(
      { length: 13 },
      (_, index) => [`variant_${String(index)}`, 'https://cdn.example.invalid/a.webp'],
    )),
    { constructor: 'https://cdn.example.invalid/a.webp' },
    { 'BAD KEY': 'https://cdn.example.invalid/a.webp' },
  ])('媒体网关拒绝不安全或无界衍生规格 %#', async (variants) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        objectRef: 'object-ref-001',
        checksum: 'a'.repeat(43),
        scanEvidenceId: 'scan-001',
        malwareClean: true,
        variants,
      }),
    }));
    const gateway = new MarketingMediaGateway(config({
      MARKETING_MEDIA_GATEWAY_ENDPOINT: 'https://media-gateway.example.invalid',
      MARKETING_MEDIA_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);

    await expect(gateway.verifyUpload(
      { mediaId: 'media-001' },
      'media-verify-key-unsafe',
    )).rejects.toMatchObject({
      response: { code: 'MARKETING_MEDIA_GATEWAY_UNAVAILABLE' },
    });
  });

  it('媒体网关对网络故障和非法端点统一失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network secret')));
    const networkGateway = new MarketingMediaGateway(config({
      MARKETING_MEDIA_GATEWAY_ENDPOINT: 'https://media-gateway.example.invalid',
      MARKETING_MEDIA_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);
    const invalidEndpointGateway = new MarketingMediaGateway(config({
      MARKETING_MEDIA_GATEWAY_ENDPOINT: 'not-a-url',
      MARKETING_MEDIA_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);

    await expect(networkGateway.verifyUpload(
      { mediaId: 'media-001' },
      'media-verify-key-002',
    )).rejects.toMatchObject({
      response: { code: 'MARKETING_MEDIA_GATEWAY_UNAVAILABLE' },
    });
    await expect(invalidEndpointGateway.createUpload(
      { mediaId: 'media-001' },
      'media-upload-key-003',
    )).rejects.toMatchObject({
      response: { code: 'MARKETING_MEDIA_GATEWAY_UNAVAILABLE' },
    });
  });

  it('AI 输出必须符合结构化人工审核契约', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        modelId: 'model-001',
        promptVersion: 'marketing-v1',
        output: { title: 'Draft' },
      }),
    });
    vi.stubGlobal('fetch', fetch);
    const gateway = new MarketingAiGateway(config({
      MARKETING_AI_GATEWAY_ENDPOINT: 'https://ai-gateway.example.invalid',
      MARKETING_AI_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);
    await expect(
      gateway.generate({ action: 'translate' }, 'marketing-ai-key-001'),
    ).resolves.toEqual({
      modelId: 'model-001', promptVersion: 'marketing-v1', output: { title: 'Draft' },
    });
    const result = await gateway.generate(
      { action: 'translate' },
      'marketing-ai-key-001-retry',
    );
    expect(Object.isFrozen(result.output)).toBe(true);
    const init = fetch.mock.calls[0]?.[1] as unknown as {
      readonly headers?: Readonly<Record<string, string>>;
    };
    const headers = init.headers ?? {};
    expect(headers['idempotency-key']).toBe('marketing-ai-key-001');
  });

  it('拒绝无模型证据的 AI 响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ output: { title: 'Draft' } }),
    }));
    const gateway = new MarketingAiGateway(config({
      MARKETING_AI_GATEWAY_ENDPOINT: 'https://ai-gateway.example.invalid',
      MARKETING_AI_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);
    await expect(
      gateway.generate({ action: 'translate' }, 'marketing-ai-key-002'),
    ).rejects.toMatchObject({
      response: { code: 'MARKETING_AI_GATEWAY_UNAVAILABLE' },
    });
  });

  it.each([
    { output: { html: '<script>alert(1)</script>' } },
    { output: { html: '<img src=x onerror=alert(1)>' } },
    { output: { title: 'x'.repeat(250_001) } },
    { output: Array.from({ length: 1_001 }, () => 'x') },
  ])('拒绝可执行或无界 AI 输出 %#', async ({ output }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        modelId: 'model-001',
        promptVersion: 'marketing-v1',
        output,
      }),
    }));
    const gateway = new MarketingAiGateway(config({
      MARKETING_AI_GATEWAY_ENDPOINT: 'https://ai-gateway.example.invalid',
      MARKETING_AI_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);

    await expect(
      gateway.generate({ action: 'translate' }, 'marketing-ai-key-unsafe'),
    ).rejects.toMatchObject({
      response: { code: 'MARKETING_AI_GATEWAY_UNAVAILABLE' },
    });
  });

  it('AI JSON 克隆器覆盖全部类型、预算与对象完整性边界', () => {
    const valid = safeMarketingAiOutput({
      nil: null,
      active: true,
      score: 1.5,
      title: '安全内容',
      values: [false, 2, '文本'],
    });
    expect(valid).toEqual({
      nil: null,
      active: true,
      score: 1.5,
      title: '安全内容',
      values: [false, 2, '文本'],
    });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(Object.isFrozen(valid.values)).toBe(true);

    for (const primitive of [null, true, 1, 'text', [1]]) {
      expect(() => safeMarketingAiOutput(primitive)).toThrow('MARKETING_AI_OUTPUT_INVALID');
    }
    for (const invalid of [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: undefined },
      { value: Symbol('unsafe') },
      { value: () => 'unsafe' },
      { title: 'javascript:alert(1)' },
      { title: 'data:text/html,<p>unsafe</p>' },
    ]) expect(() => safeMarketingAiOutput(invalid)).toThrow('MARKETING_AI_OUTPUT_INVALID');

    expect(() => safeMarketingAiOutput({
      values: Array.from({ length: 1_001 }, () => true),
    })).toThrow('MARKETING_AI_OUTPUT_INVALID');
    expect(() => safeMarketingAiOutput({
      title: 'x'.repeat(250_001),
    })).toThrow('MARKETING_AI_OUTPUT_INVALID');

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 13; index += 1) deep = { next: deep };
    expect(() => safeMarketingAiOutput(deep)).toThrow('MARKETING_AI_OUTPUT_INVALID');
    expect(() => safeMarketingAiOutput({
      a: Array.from({ length: 1_000 }, () => true),
      b: Array.from({ length: 1_000 }, () => true),
      c: Array.from({ length: 1_000 }, () => true),
      d: Array.from({ length: 1_000 }, () => true),
      e: Array.from({ length: 1_000 }, () => true),
    })).toThrow('MARKETING_AI_OUTPUT_INVALID');

    const customPrototype: Record<string, unknown> = { title: 'x' };
    Reflect.setPrototypeOf(customPrototype, { inherited: true });
    expect(() => safeMarketingAiOutput(customPrototype))
      .toThrow('MARKETING_AI_OUTPUT_INVALID');
    const nullPrototype: Record<string, unknown> = { title: '安全内容' };
    Reflect.setPrototypeOf(nullPrototype, null);
    expect(safeMarketingAiOutput(nullPrototype)).toEqual({ title: '安全内容' });

    const symbolKey: Record<string, unknown> = { title: 'x' };
    Object.defineProperty(symbolKey, Symbol('unsafe'), { value: true, enumerable: true });
    expect(() => safeMarketingAiOutput(symbolKey)).toThrow('MARKETING_AI_OUTPUT_INVALID');
    expect(() => safeMarketingAiOutput(Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`key_${String(index)}`, true]),
    ))).toThrow('MARKETING_AI_OUTPUT_INVALID');

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'title', {
      enumerable: true,
      get: () => 'unsafe',
    });
    expect(() => safeMarketingAiOutput(accessor)).toThrow('MARKETING_AI_OUTPUT_INVALID');
    const polluted: Record<string, unknown> = {};
    Object.defineProperty(polluted, '__proto__', { value: 'unsafe', enumerable: true });
    expect(() => safeMarketingAiOutput(polluted)).toThrow('MARKETING_AI_OUTPUT_INVALID');
  });

  it('缺少 AI 配置、上游 HTTP 或网络异常时统一失败关闭', async () => {
    const missing = new MarketingAiGateway(config({}) as never);
    await expect(
      missing.generate({ action: 'translate' }, 'marketing-ai-key-003'),
    ).rejects.toMatchObject({
      response: { code: 'MARKETING_AI_GATEWAY_UNAVAILABLE' },
    });

    for (const upstream of [
      () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
      () => Promise.resolve({
        ok: true,
        json: () => Promise.reject(new Error('invalid json')),
      }),
      () => Promise.reject(new Error('network secret')),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(upstream));
      const gateway = new MarketingAiGateway(config({
        MARKETING_AI_GATEWAY_ENDPOINT: 'https://ai-gateway.example.invalid',
        MARKETING_AI_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
      }) as never);
      await expect(
        gateway.generate({ action: 'translate' }, 'marketing-ai-key-004'),
      ).rejects.toMatchObject({
        response: { code: 'MARKETING_AI_GATEWAY_UNAVAILABLE' },
      });
    }
  });
});
