import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { HealthController } from './health.controller.js';
import type { HealthService } from './health.service.js';

describe('HealthController', () => {
  it('存活探针直接返回进程状态', () => {
    const live = vi.fn().mockReturnValue({ status: 'ok' });
    const controller = new HealthController({ live } as unknown as HealthService);

    expect(controller.live()).toEqual({ status: 'ok' });
    expect(live).toHaveBeenCalledOnce();
  });

  it('就绪依赖健康时返回检查结果', async () => {
    const result = {
      status: 'ok' as const,
      checks: { mongodb: 'up' as const, redis: 'up' as const },
    };
    const controller = new HealthController({
      ready: vi.fn().mockResolvedValue(result),
    } as unknown as HealthService);

    await expect(controller.ready()).resolves.toBe(result);
  });

  it('依赖故障时只返回稳定 503，不泄漏内部检查细节', async () => {
    const controller = new HealthController({
      ready: vi.fn().mockResolvedValue({
        status: 'error',
        checks: { mongodb: 'down', redis: 'up' },
      }),
    } as unknown as HealthService);

    await expect(controller.ready()).rejects.toMatchObject({
      constructor: ServiceUnavailableException,
      response: {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: '依赖服务未就绪',
      },
    });
  });
});
