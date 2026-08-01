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
  readonly claim?: unknown;
} = {}) {
  const findOneAndUpdate = vi.fn()
    .mockReturnValueOnce(query(overrides.claim === undefined ? CLAIM : overrides.claim))
    .mockReturnValue(query(null));
  const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
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

  it('钉钉过期执行租约不自动重发，直接隔离为结果不确定死信', async () => {
    const target = assemble({
      claim: { ...CLAIM, channel: 'dingtalk', status: 'dead' },
    });
    await expect(target.service.processBatch('dingtalk', 'worker-001', 1)).resolves.toBe(0);
    expect(target.send).not.toHaveBeenCalled();
    const quarantine = target.findOneAndUpdate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(quarantine[0]).toMatchObject({
      channel: 'dingtalk',
      status: 'processing',
    });
    const quarantineFilter = quarantine[0] as {
      readonly lockedAt?: { readonly $lt?: unknown };
    };
    expect(quarantineFilter.lockedAt?.$lt).toBeInstanceOf(Date);
    expect(quarantine[1].$set).toMatchObject({
      status: 'dead',
      lastErrorCode: 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE',
      lockedAt: null,
      lockedBy: null,
    });
    expect(target.recordApprovalNotification).toHaveBeenCalledWith('dingtalk', 'dead', 0);
  });

  it('钉钉不可判定平台故障进入死信，明确限流响应仍可退避重试', async () => {
    const indeterminate = assemble({
      claim: null,
      sendError: new OrgPushError(
        'ORG_PLATFORM_NETWORK_ERROR',
        'retryable',
        '平台网络异常',
      ),
    });
    indeterminate.findOneAndUpdate
      .mockReset()
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ ...CLAIM, channel: 'dingtalk' }));
    await expect(
      indeterminate.service.processBatch('dingtalk', 'worker-001', 1),
    ).resolves.toBe(0);
    expectUpdate(indeterminate.updateOne, {
      status: 'dead',
      lastErrorCode: 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE',
    });

    const rateLimited = assemble({
      claim: null,
      sendError: new OrgPushError(
        'ORG_PLATFORM_HTTP_429',
        'retryable',
        '平台限流',
        429,
      ),
    });
    rateLimited.findOneAndUpdate
      .mockReset()
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ ...CLAIM, channel: 'dingtalk' }));
    await expect(
      rateLimited.service.processBatch('dingtalk', 'worker-001', 1),
    ).resolves.toBe(0);
    expectUpdate(rateLimited.updateOne, {
      status: 'pending',
      lastErrorCode: 'ORG_PLATFORM_HTTP_429',
    });
  });

  it('钉钉成功响应无法确认消息回执时也进入结果不确定死信', async () => {
    const target = assemble({
      claim: null,
      sendError: new OrgPushError(
        'DINGTALK_APPROVAL_MESSAGE_RESPONSE_INVALID',
        'retryable',
        '响应无效',
      ),
    });
    target.findOneAndUpdate
      .mockReset()
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ ...CLAIM, channel: 'dingtalk' }));
    await target.service.processBatch('dingtalk', 'worker-001', 1);
    expectUpdate(target.updateOne, {
      status: 'dead',
      lastErrorCode: 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE',
    });
  });

  it('平台发送成功后的终态存储故障不会反向登记发送失败', async () => {
    const target = assemble();
    target.updateOne.mockRejectedValueOnce(new Error('MONGO_UNAVAILABLE'));
    await expect(
      target.service.processBatch('feishu', 'worker-001', 1),
    ).rejects.toThrow('APPROVAL_NOTIFICATION_STORE_UNAVAILABLE');
    expect(target.send).toHaveBeenCalledOnce();
    expect(target.updateOne).toHaveBeenCalledOnce();
    expect(target.recordApprovalNotification).toHaveBeenCalledWith(
      'feishu',
      'state_unavailable',
      expect.any(Number),
    );
  });

  it('平台发送成功后丢失租约时失败关闭且不覆盖新 Worker 状态', async () => {
    const target = assemble();
    target.updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
    await expect(
      target.service.processBatch('feishu', 'worker-001', 1),
    ).rejects.toThrow('APPROVAL_NOTIFICATION_DELIVERY_LEASE_LOST');
    expect(target.updateOne).toHaveBeenCalledOnce();
    const filter = target.updateOne.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter).toMatchObject({
      notificationId: CLAIM.notificationId,
      status: 'processing',
      lockedBy: 'worker-001',
      attempts: 0,
    });
  });

  it('失败释放必须仍持有原租约与尝试版本', async () => {
    const target = assemble({
      sendError: new Error('UNKNOWN_PROVIDER_FAILURE'),
    });
    target.updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
    await expect(
      target.service.processBatch('feishu', 'worker-001', 1),
    ).rejects.toThrow('APPROVAL_NOTIFICATION_RELEASE_LEASE_LOST');
    const filter = target.updateOne.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter).toMatchObject({
      notificationId: CLAIM.notificationId,
      status: 'processing',
      lockedBy: 'worker-001',
      attempts: 0,
    });
  });

  it('数据库认领、隔离和失败回写异常统一为受控存储错误', async () => {
    const claimFailed = assemble();
    claimFailed.findOneAndUpdate.mockReset().mockReturnValueOnce({
      lean: () => ({ exec: () => Promise.reject(new Error('MONGO_DOWN')) }),
    });
    await expect(
      claimFailed.service.processBatch('feishu', 'worker-001', 1),
    ).rejects.toThrow('APPROVAL_NOTIFICATION_STORE_UNAVAILABLE');

    const quarantineFailed = assemble();
    quarantineFailed.findOneAndUpdate.mockReset().mockReturnValueOnce({
      lean: () => ({ exec: () => Promise.reject(new Error('MONGO_DOWN')) }),
    });
    await expect(
      quarantineFailed.service.processBatch('dingtalk', 'worker-001', 1),
    ).rejects.toThrow('APPROVAL_NOTIFICATION_STORE_UNAVAILABLE');

    const releaseFailed = assemble({ profile: null });
    releaseFailed.updateOne.mockRejectedValueOnce(new Error('MONGO_DOWN'));
    await expect(
      releaseFailed.service.processBatch('feishu', 'worker-001', 1),
    ).rejects.toThrow('APPROVAL_NOTIFICATION_STORE_UNAVAILABLE');
  });

  it('运行时拒绝受损通知事实并立即死信，不访问身份或平台', async () => {
    const invalidClaims = [
      { ...CLAIM, notificationId: 'not-ulid' },
      { ...CLAIM, tenantId: 'tenant id' },
      { ...CLAIM, instanceId: '' },
      { ...CLAIM, aggregateVersion: 0 },
      { ...CLAIM, eventType: 'instance.unknown' },
      { ...CLAIM, recipientActorId: 'actor id' },
      { ...CLAIM, channel: 'dingtalk' },
      { ...CLAIM, riskLevel: 'R3' },
      { ...CLAIM, attempts: -1 },
      { ...CLAIM, attempts: 12 },
    ];
    for (const claim of invalidClaims) {
      const target = assemble({ claim });
      await expect(
        target.service.processBatch('feishu', 'worker-001', 1),
      ).resolves.toBe(0);
      expect(target.resolveActive).not.toHaveBeenCalled();
      expect(target.send).not.toHaveBeenCalled();
      expectUpdate(target.updateOne, {
        status: 'dead',
        attempts: claim.attempts === 12 ? 12 : expect.any(Number),
        lastErrorCode: 'APPROVAL_NOTIFICATION_RECORD_INVALID',
      }, { notificationId: claim.notificationId });
    }
  });

  it('身份未绑定、平台业务拒绝与最终尝试进入确定性死信', async () => {
    for (const target of [
      assemble({ identity: null }),
      assemble({ identity: { actorId: 'actor-other', externalUserId: 'user-001' } }),
      assemble({
        sendError: new OrgPushError(
          'ORG_PLATFORM_HTTP_400',
          'business',
          '业务拒绝',
          400,
        ),
      }),
      assemble({
        claim: { ...CLAIM, attempts: 11 },
        sendError: new Error('TRANSIENT_UNKNOWN'),
      }),
    ]) {
      await expect(
        target.service.processBatch('feishu', 'worker-001', 1),
      ).resolves.toBe(0);
      expectUpdate(target.updateOne, { status: 'dead' });
    }
  });

  it('Worker 标识、批次和渠道参数在认领前失败关闭', async () => {
    const target = assemble();
    for (const [workerId, limit] of [
      ['', 1],
      ['worker id', 1],
      ['x'.repeat(129), 1],
      ['worker-001', 0],
      ['worker-001', 101],
      ['worker-001', 1.5],
    ] as const) {
      await expect(
        target.service.processBatch('feishu', workerId, limit),
      ).rejects.toThrow('审批通知 Worker 参数非法');
    }
    expect(target.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

function expectUpdate(
  updateOne: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
  expectedFilter: Record<string, unknown> = {},
): void {
  const call = updateOne.mock.calls[0] as unknown as [
    Record<string, unknown>,
    { $set: Record<string, unknown> },
    Record<string, unknown>,
  ] | undefined;
  expect(call?.[0]).toMatchObject({
    notificationId: CLAIM.notificationId,
    status: 'processing',
    lockedBy: 'worker-001',
    ...expectedFilter,
  });
  const attempts = call?.[0].attempts;
  expect(Number.isInteger(attempts)).toBe(true);
  expect(call?.[1].$set).toMatchObject(expected);
  expect(call?.[2]).toEqual({ runValidators: true });
}
