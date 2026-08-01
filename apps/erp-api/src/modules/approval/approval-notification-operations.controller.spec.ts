import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { ApprovalNotificationOperationsService } from './notification/approval-notification-operations.service.js';
import { ApprovalNotificationOperationsController } from './approval-notification-operations.controller.js';

const NOTIFICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';

function fixture() {
  const listDead = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const reconciliation = vi.fn().mockResolvedValue({
    counts: {
      dingtalk: { pending: 0, processing: 0, sent: 0, dead: 0 },
      feishu: { pending: 0, processing: 0, sent: 0, dead: 0 },
    },
    oldestPendingAt: null,
  });
  const retry = vi.fn().mockResolvedValue({
    notification: {
      notificationId: NOTIFICATION_ID,
      status: 'pending',
      reason: 'provider_recovered',
    },
  });
  const record = vi.fn().mockResolvedValue(undefined);
  const controller = new ApprovalNotificationOperationsController(
    { listDead, reconciliation, retry } as unknown as ApprovalNotificationOperationsService,
    { record } as unknown as AuditService,
  );
  const logger = Reflect.get(controller, 'logger') as {
    error: (message: unknown) => void;
  };
  const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  return { controller, listDead, reconciliation, retry, record, loggerError };
}

describe('ApprovalNotificationOperationsController', () => {
  it('校验并转发死信查询的渠道、游标和规范分页', async () => {
    const store = fixture();
    await expect(store.controller.listDead(
      'feishu',
      NOTIFICATION_ID,
      '100',
    )).resolves.toEqual({ items: [], nextCursor: null });
    expect(store.listDead).toHaveBeenCalledWith({
      channel: 'feishu',
      beforeNotificationId: NOTIFICATION_ID,
      limit: 100,
    });
  });

  it('查询默认分页且不构造空过滤字段', async () => {
    const store = fixture();
    await store.controller.listDead(undefined, undefined, undefined);
    expect(store.listDead).toHaveBeenCalledWith({ limit: 50 });
  });

  it.each([
    ['渠道', 'op', undefined, undefined],
    ['游标', undefined, 'bad-id', undefined],
    ['数量下界', undefined, undefined, '0'],
    ['数量上界', undefined, undefined, '101'],
    ['前导零', undefined, undefined, '01'],
    ['指数形式', undefined, undefined, '1e2'],
    ['小数', undefined, undefined, '1.5'],
    ['空白', undefined, undefined, ' 1'],
    ['数组', undefined, undefined, ['1']],
  ])('%s 非法时在查询边界失败关闭', (
    _label,
    channel,
    before,
    limit,
  ) => {
    const store = fixture();
    expect(() => store.controller.listDead(channel, before, limit))
      .toThrow(BadRequestException);
    expect(store.listDead).not.toHaveBeenCalled();
  });

  it('转发只读对账请求', async () => {
    const store = fixture();
    await expect(store.controller.reconciliation()).resolves.toMatchObject({
      oldestPendingAt: null,
    });
    expect(store.reconciliation).toHaveBeenCalledOnce();
  });

  it.each([
    'credentials_fixed',
    'identity_bound',
    'provider_recovered',
    'approved_exception',
  ])('以原因 %s 和幂等键执行 R2 重试并记录成功审计', async (reason) => {
    const store = fixture();
    await expect(store.controller.retry(
      NOTIFICATION_ID,
      'approval-retry-001',
      { reason },
    )).resolves.toMatchObject({
      notification: { status: 'pending' },
    });
    expect(store.retry).toHaveBeenCalledWith(
      NOTIFICATION_ID,
      reason,
      'approval-retry-001',
    );
    expect(store.record).toHaveBeenCalledWith({
      action: 'approval.notification.retry',
      resourceType: 'approval_notification',
      resourceId: NOTIFICATION_ID,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { reason },
    });
  });

  it.each([
    ['通知标识', 'bad-id', 'approval-retry-002', { reason: 'provider_recovered' }],
    ['幂等键缺失', NOTIFICATION_ID, undefined, { reason: 'provider_recovered' }],
    ['幂等键非法', NOTIFICATION_ID, 'bad', { reason: 'provider_recovered' }],
    ['正文缺失', NOTIFICATION_ID, 'approval-retry-002', undefined],
    ['正文为空', NOTIFICATION_ID, 'approval-retry-002', {}],
    ['正文为 null', NOTIFICATION_ID, 'approval-retry-002', null],
    ['正文为数组', NOTIFICATION_ID, 'approval-retry-002', ['provider_recovered']],
    ['未知原因', NOTIFICATION_ID, 'approval-retry-002', { reason: 'unknown' }],
    ['额外字段', NOTIFICATION_ID, 'approval-retry-002', {
      reason: 'provider_recovered',
      accessToken: 'forbidden',
    }],
  ])('%s 非法时在任何业务或审计副作用前拒绝', async (
    _label,
    notificationId,
    key,
    body,
  ) => {
    const store = fixture();
    await expect(store.controller.retry(notificationId, key, body))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(store.retry).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it('业务重试失败时记录一次失败审计并保留原始异常', async () => {
    const store = fixture();
    const businessError = new Error('通知不可重试');
    store.retry.mockRejectedValueOnce(businessError);

    await expect(store.controller.retry(
      NOTIFICATION_ID,
      'approval-retry-003',
      { reason: 'identity_bound' },
    )).rejects.toBe(businessError);
    expect(store.record).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: { reason: 'identity_bound' },
    }));
  });

  it('业务失败后的审计故障不得覆盖原始异常', async () => {
    const store = fixture();
    const businessError = new Error('通知不可重试');
    store.retry.mockRejectedValueOnce(businessError);
    store.record.mockRejectedValueOnce(new Error('审计不可用'));

    await expect(store.controller.retry(
      NOTIFICATION_ID,
      'approval-retry-004',
      { reason: 'credentials_fixed' },
    )).rejects.toBe(businessError);
    expect(store.retry).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledOnce();
    expect(store.loggerError).toHaveBeenCalledWith({
      code: 'APPROVAL_NOTIFICATION_RETRY_FAILURE_AUDIT_FAILED',
      notificationId: NOTIFICATION_ID,
    });
  });

  it('业务已提交后的成功审计故障不得改变成功响应或重复执行', async () => {
    const store = fixture();
    store.record.mockRejectedValueOnce(new Error('审计不可用'));

    await expect(store.controller.retry(
      NOTIFICATION_ID,
      'approval-retry-005',
      { reason: 'provider_recovered' },
    )).resolves.toMatchObject({
      notification: { status: 'pending' },
    });
    expect(store.retry).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledOnce();
    expect(store.loggerError).toHaveBeenCalledWith({
      code: 'APPROVAL_NOTIFICATION_RETRY_AUDIT_AFTER_COMMIT_FAILED',
      notificationId: NOTIFICATION_ID,
    });
  });
});
