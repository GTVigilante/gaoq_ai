import { getQueueToken } from '@nestjs/bullmq';
import { describe, expect, it } from 'vitest';

import { AuditAnchorProcessor } from './audit-anchor.processor.js';
import { AuditAnchorScheduler } from './audit-anchor.scheduler.js';
import { AuditQueueMetricsPoller } from './audit-queue-metrics.poller.js';
import { AuditWorkerModule } from './audit-worker.module.js';
import { AuditModule } from './audit.module.js';

const MODULE_IMPORTS = 'imports';
const MODULE_PROVIDERS = 'providers';

describe('AuditWorkerModule', () => {
  it('后台执行能力只装配在独立 Worker 模块', () => {
    const workerProviders = Reflect.getMetadata(
      MODULE_PROVIDERS,
      AuditWorkerModule,
    ) as unknown[];
    expect(workerProviders).toEqual([
      AuditAnchorProcessor,
      AuditAnchorScheduler,
      AuditQueueMetricsPoller,
    ]);

    const apiProviders = Reflect.getMetadata(MODULE_PROVIDERS, AuditModule) as unknown[];
    expect(apiProviders).not.toContain(AuditAnchorProcessor);
    expect(apiProviders).not.toContain(AuditAnchorScheduler);
    expect(apiProviders).not.toContain(AuditQueueMetricsPoller);
  });

  it('Worker 模块只复用审计核心并注册固定审计维护队列', () => {
    const imports = Reflect.getMetadata(MODULE_IMPORTS, AuditWorkerModule) as Array<
      { readonly exports?: readonly unknown[] } | typeof AuditModule
    >;
    expect(imports).toHaveLength(2);
    expect(imports[0]).toBe(AuditModule);
    expect(imports[1]).toMatchObject({
      exports: [
        expect.objectContaining({ provide: getQueueToken('audit-maintenance') }),
      ],
    });
  });
});
