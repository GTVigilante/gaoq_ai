import type { ConfigService } from '@nestjs/config';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { MetricsAuthorizationService } from './metrics-authorization.service.js';
import type { MetricsService } from './metrics.service.js';
import { WorkerMetricsServer } from './worker-metrics.server.js';

const token = 'metrics-token-that-is-at-least-32-characters';
const runningServers: WorkerMetricsServer[] = [];

function fixture(input: {
  readonly enabled?: boolean;
  readonly port?: number;
  readonly render?: ReturnType<typeof vi.fn>;
} = {}) {
  const enabled = input.enabled ?? true;
  const verify = vi.fn((authorization: string | undefined) => {
    if (!enabled) return 'disabled';
    return authorization === `Bearer ${token}`
      ? 'valid'
      : 'invalid';
  });
  const render = input.render ?? vi.fn().mockResolvedValue('# metrics');
  const service = new WorkerMetricsServer(
    { get: () => input.port ?? 0 } as unknown as ConfigService<AppEnvironment, true>,
    { verify } as unknown as MetricsAuthorizationService,
    {
      contentType: 'text/plain; version=0.0.4',
      render,
    } as unknown as MetricsService,
  );
  (service as unknown as {
    logger: { log: ReturnType<typeof vi.fn> };
  }).logger = { log: vi.fn() };
  return { service, verify, render };
}

function addressOf(service: WorkerMetricsServer): string {
  const server = (service as unknown as { server: Server }).server;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('WORKER_TEST_PORT_UNAVAILABLE');
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(async (server) => server.onApplicationShutdown()));
});

describe('WorkerMetricsServer', () => {
  it('未配置独立凭据时不启动任何 HTTP 监听器', async () => {
    const assembled = fixture({ enabled: false });

    await assembled.service.onApplicationBootstrap();
    await assembled.service.onApplicationShutdown();

    expect(assembled.verify).toHaveBeenCalledWith(undefined);
    expect((assembled.service as unknown as { server?: Server }).server).toBeUndefined();
  });

  it('存活检查不要求指标凭据，其他路径失败关闭', async () => {
    const assembled = fixture();
    runningServers.push(assembled.service);
    await assembled.service.onApplicationBootstrap();
    const origin = addressOf(assembled.service);

    const live = await fetch(`${origin}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.text()).toBe('OK');
    expect(live.headers.get('cache-control')).toBe('no-store');
    expect(live.headers.get('x-content-type-options')).toBe('nosniff');

    const missing = await fetch(`${origin}/unknown`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('Not Found');

    const wrongMethod = await fetch(`${origin}/metrics`, { method: 'POST' });
    expect(wrongMethod.status).toBe(404);
  });

  it('指标入口要求规范 Bearer 并返回防缓存 Prometheus 文本', async () => {
    const assembled = fixture();
    runningServers.push(assembled.service);
    await assembled.service.onApplicationBootstrap();
    const origin = addressOf(assembled.service);

    const unauthorized = await fetch(`${origin}/metrics`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
    expect(unauthorized.headers.get('x-content-type-options')).toBe('nosniff');

    const response = await fetch(`${origin}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('# metrics');
    expect(assembled.render).toHaveBeenCalledOnce();
  });

  it('渲染失败只返回稳定 500 且不泄漏异常', async () => {
    const assembled = fixture({
      render: vi.fn().mockRejectedValue(new Error('secret render details')),
    });
    runningServers.push(assembled.service);
    await assembled.service.onApplicationBootstrap();

    const response = await fetch(`${addressOf(assembled.service)}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('重复启动保持单例监听，关闭后清理句柄且允许幂等关闭', async () => {
    const assembled = fixture();
    await assembled.service.onApplicationBootstrap();
    runningServers.push(assembled.service);
    const first = (assembled.service as unknown as { server: Server }).server;

    await assembled.service.onApplicationBootstrap();
    expect((assembled.service as unknown as { server: Server }).server).toBe(first);

    await assembled.service.onApplicationShutdown();
    expect((assembled.service as unknown as { server?: Server }).server).toBeUndefined();
    await assembled.service.onApplicationShutdown();
  });

  it('端口占用时启动失败并清理未监听句柄', async () => {
    const first = fixture();
    await first.service.onApplicationBootstrap();
    runningServers.push(first.service);
    const address = (first.service as unknown as { server: Server }).server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('WORKER_TEST_PORT_UNAVAILABLE');
    }
    const second = fixture({ port: address.port });

    await expect(second.service.onApplicationBootstrap()).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect((second.service as unknown as { server?: Server }).server).toBeUndefined();
    await second.service.onApplicationShutdown();
  });
});
