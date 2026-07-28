import { BadRequestException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { HttpMetricsInterceptor } from './http-metrics.interceptor.js';
import type { MetricsService } from './metrics.service.js';

function context(type: 'http' | 'rpc', statusCode = 200): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => class HealthController {},
    getHandler: () => function ready() {},
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET' }),
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

function interceptor() {
  const recordHttpRequest = vi.fn();
  return {
    recordHttpRequest,
    interceptor: new HttpMetricsInterceptor({
      recordHttpRequest,
    } as unknown as MetricsService),
  };
}

describe('HttpMetricsInterceptor', () => {
  it('非 HTTP 上下文不采集指标', async () => {
    const assembled = interceptor();
    const next = { handle: vi.fn().mockReturnValue(of('ok')) } as unknown as CallHandler;

    await expect(lastValueFrom(assembled.interceptor.intercept(context('rpc'), next)))
      .resolves.toBe('ok');
    expect(assembled.recordHttpRequest).not.toHaveBeenCalled();
  });

  it('成功响应使用最终状态码和编译期控制器标签', async () => {
    const assembled = interceptor();
    const next = { handle: () => of('ok') } as CallHandler;

    await expect(lastValueFrom(assembled.interceptor.intercept(context('http', 204), next)))
      .resolves.toBe('ok');
    const recorded = assembled.recordHttpRequest.mock.calls[0]?.[0] as unknown as {
      readonly method: string;
      readonly controller: string;
      readonly handler: string;
      readonly statusCode: number;
      readonly durationSeconds: number;
    };
    expect(recorded).toMatchObject({
      method: 'GET',
      controller: 'HealthController',
      handler: 'ready',
      statusCode: 204,
    });
    expect(recorded.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('按 HttpException 或未知异常记录失败状态且保持原异常', async () => {
    for (const [error, statusCode] of [
      [new BadRequestException('bad'), 400],
      [new Error('unexpected'), 500],
    ] as const) {
      const assembled = interceptor();
      const next = { handle: () => throwError(() => error) } as CallHandler;

      await expect(lastValueFrom(assembled.interceptor.intercept(context('http'), next)))
        .rejects.toBe(error);
      expect(assembled.recordHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode }),
      );
    }
  });
});
