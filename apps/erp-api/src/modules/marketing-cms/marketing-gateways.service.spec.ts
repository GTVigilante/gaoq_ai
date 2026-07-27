import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketingAiGateway, MarketingMediaGateway } from './marketing-gateways.service.js';

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
