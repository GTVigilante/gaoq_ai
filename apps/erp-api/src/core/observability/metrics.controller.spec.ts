import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { MetricsController } from './metrics.controller.js';
import type { MetricsService } from './metrics.service.js';

describe('MetricsController', () => {
  it('输出受保护的 Prometheus 文本并禁止缓存和嗅探', async () => {
    const render = vi.fn().mockResolvedValue('# metrics');
    const controller = new MetricsController({
      contentType: 'text/plain; version=0.0.4',
      render,
    } as unknown as MetricsService);
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Response;

    await expect(controller.scrape(response)).resolves.toBe('# metrics');
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4',
    );
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(render).toHaveBeenCalledOnce();
  });

  it('保留渲染异常交由全局异常过滤器处理', async () => {
    const failure = new Error('render failed');
    const controller = new MetricsController({
      contentType: 'text/plain',
      render: vi.fn().mockRejectedValue(failure),
    } as unknown as MetricsService);

    await expect(controller.scrape({ setHeader: vi.fn() } as unknown as Response))
      .rejects.toBe(failure);
  });
});
