import { describe, expect, it } from 'vitest';

import {
  calculateOpApprovalNextAttemptAt,
  OP_APPROVAL_MAX_ATTEMPTS,
} from './op-approval.policy.js';

describe('OP 审批桥重试策略', () => {
  it('采用六档带抖动退避', () => {
    const now = new Date('2026-07-22T00:00:00.000Z');
    expect(OP_APPROVAL_MAX_ATTEMPTS).toBe(6);
    expect(calculateOpApprovalNextAttemptAt(1, now, () => 0.5).getTime() - now.getTime())
      .toBe(1_000);
    expect(calculateOpApprovalNextAttemptAt(6, now, () => 0.5).getTime() - now.getTime())
      .toBe(1_800_000);
  });

  it('拒绝越界次数和非法随机源', () => {
    const now = new Date();
    expect(() => calculateOpApprovalNextAttemptAt(0, now)).toThrow(RangeError);
    expect(() => calculateOpApprovalNextAttemptAt(1, now, () => 1)).toThrow(RangeError);
  });
});
