import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalNotificationScheduler } from './approval-notification.scheduler.js';

describe('ApprovalNotificationScheduler', () => {
  it('为钉钉和飞书分别注册唯一调度器', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ApprovalNotificationScheduler({
      upsertJobScheduler,
    } as unknown as Queue<Record<string, never>, unknown, string>);
    await scheduler.onApplicationBootstrap();
    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
    const names = upsertJobScheduler.mock.calls.map((call) => String(call[0]));
    expect(names).toEqual([
      'approval-notification:deliver:dingtalk',
      'approval-notification:deliver:feishu',
    ]);
  });
});
