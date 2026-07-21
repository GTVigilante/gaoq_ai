import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { OrgIntegrationScheduler } from './org-integration.scheduler.js';

describe('OrgIntegrationScheduler', () => {
  it('幂等注册 relay、双平台、开户与对账调度任务', async () => {
    const upsertJobScheduler = vi.fn<
      (schedulerId: string, repeat: unknown, template: unknown) => Promise<object>
    >().mockResolvedValue({});
    const scheduler = new OrgIntegrationScheduler({
      upsertJobScheduler,
    } as unknown as Queue<Record<string, never>, unknown, string>);

    await scheduler.onApplicationBootstrap();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(8);
    expect(upsertJobScheduler.mock.calls.map((call) => call[0])).toEqual([
      'org-integration:relay',
      'org-integration:relay:calendar',
      'org-integration:deliver:dingtalk',
      'org-integration:deliver:feishu',
      'org-integration:deliver:calendar:dingtalk',
      'org-integration:deliver:calendar:feishu',
      'org-integration:provision',
      'org-integration:reconcile',
    ]);
    expect(upsertJobScheduler.mock.calls[7]?.[1]).toEqual({ every: 86_400_000 });
  });
});
