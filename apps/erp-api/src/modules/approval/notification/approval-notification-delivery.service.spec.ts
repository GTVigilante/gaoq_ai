import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type { ExternalIdentityRepository } from '../../identity/external-identity.repository.js';
import type { OrgPlatformTokenService } from '../../integration/org-platform-token.service.js';
import { OrgPushError } from '../../integration/org-push.adapter.js';
import type { ApprovalNotificationAdapterRegistry } from './approval-notification.adapter.js';
import type { MetricsService } from '../../../core/observability/metrics.service.js';
import { ApprovalNotificationDeliveryService } from './approval-notification-delivery.service.js';
import type { ApprovalNotificationDocument } from './approval-notification.schema.js';

const CLAIM = {
  notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
  tenantId: 'tenant-001',
  instanceId: 'instance-001',
  aggregateVersion: 2,
  eventType: 'instance.submitted',
  recipientActorId: 'actor-001',
  channel: 'feishu' as const,
  riskLevel: 'R1' as const,
  status: 'processing' as const,
  attempts: 0,
  nextAttemptAt: new Date(),
  lockedAt: new Date(),
  lockedBy: 'worker-001',
  externalMessageId: null,
  lastErrorCode: null,
  sentAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function assemble(overrides: {
  readonly profile?: unknown;
  readonly identity?: unknown;
  readonly sendError?: unknown;
} = {}) {
  const findOneAndUpdate = vi.fn()
    .mockReturnValueOnce(query(CLAIM))
    .mockReturnValue(query(null));
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const resolveActive = vi.fn().mockResolvedValue(
    overrides.profile === undefined
      ? { actorId: 'actor-001', employeeId: 'employee-001', status: 'active' }
      : overrides.profile,
  );
  const findBoundByEmployee = vi.fn().mockResolvedValue(
    overrides.identity === undefined
      ? { actorId: 'actor-001', externalUserId: 'user-001', unionId: 'union-001' }
      : overrides.identity,
  );
  const getAccess = vi.fn().mockResolvedValue({
    accessToken: 'token-001', externalTenantId: 'external-tenant-001', clientId: 'app-001',
  });
  const invalidate = vi.fn();
  const recordApprovalNotification = vi.fn();
  const send = overrides.sendError === undefined
    ? vi.fn().mockResolvedValue({ externalMessageId: 'message-001' })
    : vi.fn().mockRejectedValue(overrides.sendError);
  const service = new ApprovalNotificationDeliveryService(
    { findOneAndUpdate, updateOne } as unknown as Model<ApprovalNotificationDocument>,
    { resolveActive } as unknown as AccessProfileRepository,
    { findBoundByEmployee } as unknown as ExternalIdentityRepository,
    { getAccess, invalidate } as unknown as OrgPlatformTokenService,
    { get: () => ({ send }) } as unknown as ApprovalNotificationAdapterRegistry,
    { recordApprovalNotification } as unknown as MetricsService,
  );
  return {
    service, findOneAndUpdate, updateOne, resolveActive, findBoundByEmployee,
    getAccess, invalidate, send, recordApprovalNotification,
  };
}

describe('ApprovalNotificationDeliveryService', () => {
  it('解析 ERP 主体与平台绑定后发送，并以租约条件原子标记成功', async () => {
    const target = assemble();
    await expect(target.service.processBatch('feishu', 'worker-001', 2)).resolves.toBe(1);
    expect(target.resolveActive).toHaveBeenCalledWith('tenant-001', 'actor-001');
    expect(target.findBoundByEmployee).toHaveBeenCalledWith(
      'tenant-001', 'feishu', 'external-tenant-001', 'employee-001',
    );
    expect(target.send.mock.calls[0]?.[0]).toMatchObject({
      notificationId: CLAIM.notificationId,
      externalUserId: 'user-001',
    });
    expectUpdate(target.updateOne, { status: 'sent', externalMessageId: 'message-001' });
    expect(target.recordApprovalNotification).toHaveBeenCalledWith(
      'feishu', 'sent', expect.any(Number),
    );
  });

  it('停用收件人直接进入死信且不调用平台', async () => {
    const target = assemble({ profile: null });
    await expect(target.service.processBatch('feishu', 'worker-001', 1)).resolves.toBe(0);
    expect(target.send).not.toHaveBeenCalled();
    expectUpdate(target.updateOne, {
      status: 'dead', attempts: 1, lastErrorCode: 'APPROVAL_RECIPIENT_INACTIVE',
    });
    expect(target.recordApprovalNotification).toHaveBeenCalledWith(
      'feishu', 'dead', expect.any(Number),
    );
  });

  it('平台瞬时故障退避重试，不触碰审批聚合', async () => {
    const target = assemble({
      sendError: new OrgPushError('ORG_PLATFORM_HTTP_503', 'retryable', '平台暂不可用', 503),
    });
    await expect(target.service.processBatch('feishu', 'worker-001', 1)).resolves.toBe(0);
    expectUpdate(target.updateOne, {
      status: 'pending', attempts: 1, lastErrorCode: 'ORG_PLATFORM_HTTP_503',
    });
  });

  it('平台拒绝过期令牌时安全失效当前缓存并重试', async () => {
    const target = assemble({
      sendError: new OrgPushError('ORG_PLATFORM_HTTP_401', 'business', '令牌失效', 401),
    });
    await target.service.processBatch('feishu', 'worker-001', 1);
    expect(target.invalidate).toHaveBeenCalledWith('tenant-001', 'feishu', 'token-001');
    expectUpdate(target.updateOne, { status: 'pending' });
  });

  it('认领查询同时覆盖待处理和过期租约', async () => {
    const target = assemble();
    await target.service.processBatch('feishu', 'worker-001', 1);
    const filter = target.findOneAndUpdate.mock.calls[0]?.[0] as {
      $or: readonly Record<string, unknown>[];
    };
    expect(filter.$or.some((value) => value.status === 'pending')).toBe(true);
    const recovery = filter.$or.find((value) => value.status === 'processing') as {
      lockedAt?: { $lt?: unknown };
    } | undefined;
    expect(recovery?.lockedAt?.$lt).toBeInstanceOf(Date);
  });
});

function expectUpdate(updateOne: ReturnType<typeof vi.fn>, expected: Record<string, unknown>): void {
  const call = updateOne.mock.calls[0] as unknown as [
    Record<string, unknown>,
    { $set: Record<string, unknown> },
    Record<string, unknown>,
  ] | undefined;
  expect(call?.[0]).toMatchObject({
    notificationId: CLAIM.notificationId,
    status: 'processing',
    lockedBy: 'worker-001',
  });
  expect(call?.[1].$set).toMatchObject(expected);
  expect(call?.[2]).toEqual({ runValidators: true });
}
