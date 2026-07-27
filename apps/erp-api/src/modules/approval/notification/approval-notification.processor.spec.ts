import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalNotificationDeliveryService } from './approval-notification-delivery.service.js';
import { ApprovalNotificationProcessor } from './approval-notification.processor.js';
import type { ApprovalNotificationJobName } from './approval-notification.queue.js';

const job = (
  name: string,
  data: unknown = {},
): Job<Record<string, never>, unknown, ApprovalNotificationJobName> => ({
  name,
  data,
}) as Job<Record<string, never>, unknown, ApprovalNotificationJobName>;

describe('ApprovalNotificationProcessor', () => {
  it('按固定任务名路由到双平台并复用同一受控 Worker 标识', async () => {
    const processBatch = vi.fn().mockResolvedValue(3);
    const processor = new ApprovalNotificationProcessor({
      processBatch,
    } as unknown as ApprovalNotificationDeliveryService);

    await expect(processor.process(job('deliver:dingtalk'))).resolves.toBe(3);
    await expect(processor.process(job('deliver:feishu'))).resolves.toBe(3);

    expect(processBatch).toHaveBeenNthCalledWith(
      1,
      'dingtalk',
      expect.stringMatching(
        /^approval-notification-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      25,
    );
    expect(processBatch).toHaveBeenNthCalledWith(
      2,
      'feishu',
      processBatch.mock.calls[0]?.[1],
      25,
    );
  });

  it('拒绝未知任务名和任何非空或非对象载荷', async () => {
    const processBatch = vi.fn();
    const processor = new ApprovalNotificationProcessor({
      processBatch,
    } as unknown as ApprovalNotificationDeliveryService);

    await expect(
      processor.process(job('deliver:unknown')),
    ).rejects.toThrow('APPROVAL_NOTIFICATION_JOB_INVALID');

    for (const data of [
      null,
      [],
      'payload',
      { tenantId: 'client-controlled' },
    ]) {
      await expect(
        processor.process(job('deliver:feishu', data)),
      ).rejects.toThrow('APPROVAL_NOTIFICATION_JOB_DATA_INVALID');
    }
    expect(processBatch).not.toHaveBeenCalled();
  });
});
