import {
  BadRequestException,
  RequestMethod,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Request, Response } from 'express';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import {
  PUBLIC_ROUTE_KEY,
  RAW_RESPONSE_KEY,
} from '../http/public-route.decorator.js';
import { HttpMetricsInterceptor } from './http-metrics.interceptor.js';
import { MetricsAccessGuard } from './metrics-access.guard.js';
import { MetricsAuthorizationService } from './metrics-authorization.service.js';
import { MetricsController } from './metrics.controller.js';
import type { MetricsService } from './metrics.service.js';
import { QueueMetricsPoller } from './queue-metrics.poller.js';

const METRICS_TOKEN = 'metrics-token-that-is-at-least-32-characters';

const authorization = (expected: string | undefined): MetricsAuthorizationService =>
  new MetricsAuthorizationService({
    get: vi.fn().mockReturnValue(expected),
  } as unknown as ConfigService<AppEnvironment, true>);

function httpContext(options: {
  readonly statusCode?: number;
  readonly method?: string;
  readonly type?: string;
} = {}) {
  class BoundedController {}
  function boundedHandler() {}
  const request = { method: options.method ?? 'GET' } as Request;
  const response = { statusCode: options.statusCode ?? 200 } as Response;
  const context = {
    getType: () => options.type ?? 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getClass: () => BoundedController,
    getHandler: () => boundedHandler,
  } as unknown as ExecutionContext;
  return { context, request, response };
}

class TestQueueMetricsPoller extends QueueMetricsPoller {
  constructor(queue: Queue, metrics: MetricsService) {
    super('audit-maintenance', queue, metrics);
  }
}

function queueFixture() {
  const getJobCounts = vi.fn().mockResolvedValue({
    waiting: 2,
    active: 1,
    delayed: 3,
    failed: 4,
  });
  const setQueueJobs = vi.fn();
  const recordQueueMetricsPollFailure = vi.fn();
  const poller = new TestQueueMetricsPoller(
    { getJobCounts } as unknown as Queue,
    {
      setQueueJobs,
      recordQueueMetricsPollFailure,
    } as unknown as MetricsService,
  );
  return {
    getJobCounts,
    setQueueJobs,
    recordQueueMetricsPollFailure,
    poller,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Prometheus 抓取凭据', () => {
  it('未配置独立凭据时明确停用端点', () => {
    expect(authorization(undefined).verify(`Bearer ${METRICS_TOKEN}`)).toBe('disabled');
  });

  it('只接受规范 Bearer 和恒定时间摘要一致的凭据', () => {
    const service = authorization(METRICS_TOKEN);

    expect(service.verify(`Bearer ${METRICS_TOKEN}`)).toBe('valid');
    expect(service.verify(`Bearer ${'x'.repeat(METRICS_TOKEN.length)}`)).toBe('invalid');
  });

  it.each([
    undefined,
    '',
    `Basic ${METRICS_TOKEN}`,
    `Bearer  ${METRICS_TOKEN}`,
    `bearer ${METRICS_TOKEN}`,
    'Bearer too-short',
    `Bearer ${'a'.repeat(257)}`,
    `Bearer ${'a'.repeat(31)}中`,
    `Bearer ${METRICS_TOKEN} `,
  ])('拒绝非规范 Authorization：%s', (header) => {
    expect(authorization(METRICS_TOKEN).verify(header)).toBe('invalid');
  });
});

describe('API 指标入口与低基数 HTTP 采集', () => {
  it('固定公共原始响应路由，并继续装配独立指标守卫', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MetricsController)).toBe('metrics');
    expect(Reflect.getMetadata(PUBLIC_ROUTE_KEY, MetricsController)).toBe(true);
    expect(Reflect.getMetadata(RAW_RESPONSE_KEY, MetricsController)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, MetricsController)).toContain(
      MetricsAccessGuard,
    );
    const handler = Object.getOwnPropertyDescriptor(
      MetricsController.prototype,
      'scrape',
    )?.value as object;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });

  it('抓取响应固定 Prometheus 类型、禁止缓存并原样返回注册器结果', async () => {
    const render = vi.fn().mockResolvedValue('metric 1\n');
    const setHeader = vi.fn();
    const controller = new MetricsController({
      contentType: 'text/plain; version=0.0.4',
      render,
    } as unknown as MetricsService);

    await expect(controller.scrape({ setHeader } as unknown as Response))
      .resolves.toBe('metric 1\n');

    expect(setHeader).toHaveBeenNthCalledWith(
      1,
      'Content-Type',
      'text/plain; version=0.0.4',
    );
    expect(setHeader).toHaveBeenNthCalledWith(2, 'Cache-Control', 'no-store');
    expect(render).toHaveBeenCalledOnce();
  });

  it('非 HTTP 上下文不采集指标且不访问 HTTP 适配器', async () => {
    const recordHttpRequest = vi.fn();
    const interceptor = new HttpMetricsInterceptor({
      recordHttpRequest,
    } as unknown as MetricsService);
    const { context } = httpContext({ type: 'rpc' });
    const next = { handle: vi.fn().mockReturnValue(of('rpc-result')) };

    await expect(firstValueFrom(interceptor.intercept(
      context,
      next as unknown as CallHandler,
    ))).resolves.toBe('rpc-result');

    expect(recordHttpRequest).not.toHaveBeenCalled();
  });

  it('成功请求只记录方法、编译期控制器/方法、状态码和耗时', async () => {
    const recordHttpRequest = vi.fn();
    const interceptor = new HttpMetricsInterceptor({
      recordHttpRequest,
    } as unknown as MetricsService);
    const { context } = httpContext({ statusCode: 201, method: 'POST' });

    await expect(firstValueFrom(interceptor.intercept(
      context,
      { handle: () => of({ id: 'result-001' }) },
    ))).resolves.toEqual({ id: 'result-001' });

    expect(recordHttpRequest).toHaveBeenCalledOnce();
    const recorded = recordHttpRequest.mock.calls[0]?.[0] as unknown as {
      readonly controller: string;
      readonly durationSeconds: number;
      readonly handler: string;
      readonly method: string;
      readonly statusCode: number;
    };
    expect(recorded).toMatchObject({
      method: 'POST',
      controller: 'BoundedController',
      handler: 'boundedHandler',
      statusCode: 201,
    });
    expect(typeof recorded.durationSeconds).toBe('number');
    expect(recorded).not.toHaveProperty('tenantId');
  });

  it('HTTP 异常保留协议状态，未知异常统一记录 500 并继续向上抛出', async () => {
    for (const [failure, expectedStatus] of [
      [new BadRequestException('invalid'), 400],
      [new Error('unexpected'), 500],
    ] as const) {
      const recordHttpRequest = vi.fn();
      const interceptor = new HttpMetricsInterceptor({
        recordHttpRequest,
      } as unknown as MetricsService);
      const { context } = httpContext();

      await expect(firstValueFrom(interceptor.intercept(
        context,
        { handle: () => throwError(() => failure) },
      ))).rejects.toBe(failure);

      expect(recordHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: expectedStatus }),
      );
    }
  });
});

describe('BullMQ 低基数队列采集', () => {
  it('启动时立即采集固定四种状态并注册十五秒后台轮询', async () => {
    vi.useFakeTimers();
    const store = queueFixture();

    await store.poller.onApplicationBootstrap();
    expect(store.getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'delayed',
      'failed',
    );
    expect(store.setQueueJobs).toHaveBeenCalledWith('audit-maintenance', {
      waiting: 2,
      active: 1,
      delayed: 3,
      failed: 4,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.getJobCounts).toHaveBeenCalledTimes(2);
    store.poller.onApplicationShutdown();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getJobCounts).toHaveBeenCalledTimes(2);
  });

  it('采集失败只增加固定队列失败指标并保持后续轮询能力', async () => {
    vi.useFakeTimers();
    const store = queueFixture();
    store.getJobCounts
      .mockRejectedValueOnce(new Error('REDIS_UNAVAILABLE'))
      .mockResolvedValueOnce({ waiting: 0, active: 0, delayed: 0, failed: 0 });

    await expect(store.poller.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(store.recordQueueMetricsPollFailure)
      .toHaveBeenCalledWith('audit-maintenance');
    expect(store.setQueueJobs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.setQueueJobs).toHaveBeenCalledWith('audit-maintenance', {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
    });
    store.poller.onApplicationShutdown();
  });

  it('上一次采集未完成时跳过重叠轮询，禁止并发放大 Redis 压力', async () => {
    const store = queueFixture();
    let resolveCounts: ((value: {
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
    }) => void) | undefined;
    store.getJobCounts.mockReturnValueOnce(new Promise((resolve) => {
      resolveCounts = resolve;
    }));
    const refresh = (
      store.poller as unknown as { refresh(): Promise<void> }
    ).refresh.bind(store.poller);

    const first = refresh();
    await Promise.resolve();
    await expect(refresh()).resolves.toBeUndefined();
    expect(store.getJobCounts).toHaveBeenCalledOnce();

    resolveCounts?.({ waiting: 1, active: 0, delayed: 0, failed: 0 });
    await first;
    await refresh();
    expect(store.getJobCounts).toHaveBeenCalledTimes(2);
  });

  it('从未启动的采集器关闭时保持幂等', () => {
    expect(queueFixture().poller.onApplicationShutdown()).toBeUndefined();
  });
});
