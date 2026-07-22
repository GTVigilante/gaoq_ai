import type { ConfigService } from '@nestjs/config';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../config/environment.js';
import type { MetricsAuthorizationService } from './metrics-authorization.service.js';
import type { MetricsService } from './metrics.service.js';
import { WorkerMetricsServer } from './worker-metrics.server.js';

const runningServers: WorkerMetricsServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(async (server) => server.onApplicationShutdown()));
});

describe('WorkerMetricsServer', () => {
  it('无需指标凭据即可响应存活检查，但不会暴露指标', async () => {
    const verify = vi.fn().mockReturnValueOnce('valid').mockReturnValue('invalid');
    const service = new WorkerMetricsServer(
      { get: () => 0 } as unknown as ConfigService<AppEnvironment, true>,
      { verify } as unknown as MetricsAuthorizationService,
      { contentType: 'text/plain', render: vi.fn() } as unknown as MetricsService,
    );
    runningServers.push(service);
    await service.onApplicationBootstrap();

    const server = (service as unknown as { server: Server }).server;
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('WORKER_TEST_PORT_UNAVAILABLE');

    await expect(fetch(`http://127.0.0.1:${address.port}/health/live`))
      .resolves.toMatchObject({ status: 200 });
    await expect(fetch(`http://127.0.0.1:${address.port}/metrics`))
      .resolves.toMatchObject({ status: 401 });
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
