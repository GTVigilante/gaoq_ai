import { describe, expect, it } from 'vitest';

import {
  APPROVAL_NOTIFICATION_MAX_ATTEMPTS,
  nextApprovalNotificationAttemptAt,
} from './approval-notification.policy.js';

describe('审批通知重试策略', () => {
  it('按指数退避并在六小时封顶', () => {
    const now = new Date('2026-07-21T00:00:00.000Z');
    expect(nextApprovalNotificationAttemptAt(1, now, () => 0.5).getTime() - now.getTime())
      .toBe(1_000);
    expect(nextApprovalNotificationAttemptAt(
      APPROVAL_NOTIFICATION_MAX_ATTEMPTS, now, () => 0.5,
    ).getTime() - now.getTime()).toBe(6 * 60 * 60 * 1_000);
  });

  it('非法次数和随机源失败关闭', () => {
    expect(() => nextApprovalNotificationAttemptAt(0, new Date())).toThrow();
    expect(() => nextApprovalNotificationAttemptAt(1, new Date(), () => 1)).toThrow();
  });
});
