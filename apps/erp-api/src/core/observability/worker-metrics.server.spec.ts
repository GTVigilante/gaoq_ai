import type { ConfigService } from '@nestjs/config';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { MetricsAuthorizationService } from './metrics-authorization.service.js';
import type { MetricsService } from './metrics.service.js';
import { WorkerMetricsServer } from './worker-metrics.server.js';

const TOKEN = 'worker-metrics-token-that-is-at-least-32-characters';
const runningServers: WorkerMetricsServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(async (server) => server.onApplicationShutdown()));
});

async function startServer(options: {
  readonly render?: () => Promise<string>;
} = {}) {
  const verify = vi.fn((authorization: string | undefined) =>
    authorization === `Bearer ${TOKEN}` ? 'valid' : 'invalid');
  const render = vi.fn(options.render ?? (() => Promise.resolve('worker_metric 1\n')));
  const service = new WorkerMetricsServer(
    { get: () => 0 } as unknown as ConfigService<AppEnvironment, true>,
    { verify } as unknown as MetricsAuthorizationService,
    {
      contentType: 'text/plain; version=0.0.4',
      render,
    } as unknown as MetricsService,
  );
  runningServers.push(service);
  await service.onApplicationBootstrap();
  const server = (service as unknown as { server: Server }).server;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('WORKER_TEST_PORT_UNAVAILABLE');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    render,
    server,
    service,
    verify,
  };
}

describe('WorkerMetricsServer', () => {
  it('无需指标凭据即可响应存活检查，但不会暴露指标', async () => {
    const store = await startServer();

    const live = await fetch(`${store.baseUrl}/health/live`);
    expect(live.status).toBe(200);
    await expect(live.text()).resolves.toBe('OK');

    const metrics = await fetch(`${store.baseUrl}/metrics`);
    expect(metrics.status).toBe(401);
    await expect(metrics.text()).resolves.toBe('Unauthorized');
    expect(store.render).not.toHaveBeenCalled();
    expect(store.verify).toHaveBeenCalledTimes(2);
  });

  it('只允许 GET 存活探针和 GET 指标路径，其他请求固定返回 404', async () => {
    const store = await startServer();

    for (const [path, method] of [
      ['/unknown', 'GET'],
      ['/health/live', 'POST'],
      ['/metrics', 'POST'],
      ['/metrics?query=forbidden', 'GET'],
    ] as const) {
      const response = await fetch(`${store.baseUrl}${path}`, { method });
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe('Not Found');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }

    expect(store.render).not.toHaveBeenCalled();
  });

  it('有效独立 Bearer 返回 Prometheus 原文并禁止缓存', async () => {
    const store = await startServer();

    const response = await fetch(`${store.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('worker_metric 1\n');
    expect(store.render).toHaveBeenCalledOnce();
  });

  it('指标渲染失败只返回固定 500，不泄露内部异常正文', async () => {
    const store = await startServer({
      render: () => Promise.reject(new Error('SECRET_BACKEND_FAILURE')),
    });

    const response = await fetch(`${store.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('Internal Server Error');
  });

  it('未配置抓取凭据时不监听端口，关闭流程保持幂等', async () => {
    const service = new WorkerMetricsServer(
      { get: vi.fn() } as unknown as ConfigService<AppEnvironment, true>,
      {
        verify: vi.fn().mockReturnValue('disabled'),
      } as unknown as MetricsAuthorizationService,
      {
        contentType: 'text/plain',
        render: vi.fn(),
      } as unknown as MetricsService,
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect((service as unknown as { server?: Server }).server).toBeUndefined();
    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('关闭已监听端口并允许重复关闭', async () => {
    const store = await startServer();

    await expect(store.service.onApplicationShutdown()).resolves.toBeUndefined();
    expect(store.server.listening).toBe(false);
    await expect(store.service.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
