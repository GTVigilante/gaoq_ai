import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketingAiGateway, MarketingMediaGateway } from './marketing-gateways.service.js';

afterEach(() => vi.unstubAllGlobals());

const config = (values: Readonly<Record<string, string | undefined>>) => ({
  get: (name: string) => values[name],
});

describe('营销隔离网关', () => {
  it('缺少媒体配置时失败关闭', async () => {
    const gateway = new MarketingMediaGateway(config({}) as never);
    await expect(gateway.createUpload({ fileName: 'cover.png' })).rejects.toMatchObject({
      response: { code: 'MARKETING_MEDIA_GATEWAY_UNAVAILABLE' },
    });
  });

  it('AI 输出必须符合结构化人工审核契约', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        modelId: 'model-001',
        promptVersion: 'marketing-v1',
        output: { title: 'Draft' },
      }),
    }));
    const gateway = new MarketingAiGateway(config({
      MARKETING_AI_GATEWAY_ENDPOINT: 'https://ai-gateway.example.invalid',
      MARKETING_AI_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);
    await expect(gateway.generate({ action: 'translate' })).resolves.toEqual({
      modelId: 'model-001', promptVersion: 'marketing-v1', output: { title: 'Draft' },
    });
  });

  it('拒绝无模型证据的 AI 响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ output: { title: 'Draft' } }),
    }));
    const gateway = new MarketingAiGateway(config({
      MARKETING_AI_GATEWAY_ENDPOINT: 'https://ai-gateway.example.invalid',
      MARKETING_AI_GATEWAY_BEARER_TOKEN: 'x'.repeat(40),
    }) as never);
    await expect(gateway.generate({ action: 'translate' })).rejects.toMatchObject({
      response: { code: 'MARKETING_AI_GATEWAY_UNAVAILABLE' },
    });
  });
});
