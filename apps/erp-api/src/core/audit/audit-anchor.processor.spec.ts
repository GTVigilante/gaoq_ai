import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { AuditAnchorService } from './audit-anchor.service.js';
import { AuditAnchorProcessor } from './audit-anchor.processor.js';
import { AUDIT_ANCHOR_JOB } from './audit-maintenance.queue.js';

function job(name: string, data: unknown): Job<unknown, number, typeof AUDIT_ANCHOR_JOB> {
  return { name, data } as Job<unknown, number, typeof AUDIT_ANCHOR_JOB>;
}

describe('AuditAnchorProcessor', () => {
  it('只以固定批量执行无租户载荷的内部锚定任务', async () => {
    const anchorPendingTenants = vi.fn().mockResolvedValue(7);
    const processor = new AuditAnchorProcessor({
      anchorPendingTenants,
    } as unknown as AuditAnchorService);

    await expect(processor.process(job(AUDIT_ANCHOR_JOB, {}))).resolves.toBe(7);
    await expect(
      processor.process(job(AUDIT_ANCHOR_JOB, Object.create(null) as object)),
    ).resolves.toBe(7);

    expect(anchorPendingTenants).toHaveBeenNthCalledWith(1, 100);
    expect(anchorPendingTenants).toHaveBeenNthCalledWith(2, 100);
  });

  it('拒绝未知任务名，不触发审计锚定', async () => {
    const anchorPendingTenants = vi.fn();
    const processor = new AuditAnchorProcessor({
      anchorPendingTenants,
    } as unknown as AuditAnchorService);

    await expect(
      processor.process(job('client-controlled', {})),
    ).rejects.toThrow('AUDIT_MAINTENANCE_JOB_UNKNOWN');
    expect(anchorPendingTenants).not.toHaveBeenCalled();
  });

  it.each([
    ['空值', null],
    ['数组', []],
    ['字符串', '{}'],
    ['额外字段', { tenantId: 'client-controlled' }],
    ['自定义原型', Object.create({ tenantId: 'prototype-controlled' }) as object],
  ])('拒绝%s任务载荷', async (_description, data) => {
    const anchorPendingTenants = vi.fn();
    const processor = new AuditAnchorProcessor({
      anchorPendingTenants,
    } as unknown as AuditAnchorService);

    await expect(
      processor.process(job(AUDIT_ANCHOR_JOB, data)),
    ).rejects.toThrow('AUDIT_MAINTENANCE_JOB_DATA_INVALID');
    expect(anchorPendingTenants).not.toHaveBeenCalled();
  });

  it('原样传播锚定失败以交由 BullMQ 重试和失败队列观测', async () => {
    const error = new Error('AUDIT_WORM_NETWORK_ERROR');
    const processor = new AuditAnchorProcessor({
      anchorPendingTenants: vi.fn().mockRejectedValue(error),
    } as unknown as AuditAnchorService);

    await expect(
      processor.process(job(AUDIT_ANCHOR_JOB, {})),
    ).rejects.toBe(error);
  });
});
