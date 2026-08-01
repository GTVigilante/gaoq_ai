import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { IntegrationController } from './integration.controller.js';
import type { OrgDeliveryOperationsService } from './org-delivery-operations.service.js';

const EVENT_ID = '01K00000000000000000000000';

function fixture() {
  const listTerminal = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const retry = vi.fn().mockResolvedValue({
    delivery: {
      eventId: EVENT_ID,
      channel: 'feishu',
      status: 'pending',
      reason: 'provider_recovered',
    },
  });
  const record = vi.fn().mockResolvedValue(undefined);
  const controller = new IntegrationController(
    { listTerminal, retry } as unknown as OrgDeliveryOperationsService,
    { record } as unknown as AuditService,
  );
  return { controller, listTerminal, retry, record };
}

describe('IntegrationController', () => {
  it('严格转发终态查询并使用规范默认分页', async () => {
    const store = fixture();
    await expect(store.controller.list(
      'manual_review', undefined, undefined, undefined,
    )).resolves.toEqual({ items: [], nextCursor: null });
    expect(store.listTerminal).toHaveBeenCalledWith({
      status: 'manual_review',
      limit: 50,
    });

    await store.controller.list('dead', 'op', EVENT_ID, '100');
    expect(store.listTerminal).toHaveBeenLastCalledWith({
      status: 'dead',
      channel: 'op',
      beforeEventId: EVENT_ID,
      limit: 100,
    });
  });

  it.each([
    ['状态', () => fixture().controller.list('pending', undefined, undefined, undefined)],
    ['渠道', () => fixture().controller.list('dead', 'wecom', undefined, undefined)],
    ['游标', () => fixture().controller.list('dead', undefined, 'bad-id', undefined)],
    ['零数量', () => fixture().controller.list('dead', undefined, undefined, '0')],
    ['前导零', () => fixture().controller.list('dead', undefined, undefined, '01')],
    ['指数数字', () => fixture().controller.list('dead', undefined, undefined, '1e2')],
    ['超上限', () => fixture().controller.list('dead', undefined, undefined, '101')],
  ])('%s非法或非规范时在查询入口失败关闭', (_label, invoke) => {
    expect(invoke).toThrow(BadRequestException);
  });

  it('人工重试校验枚举参数、调用应用服务并记录 R2 审计', async () => {
    const store = fixture();

    await expect(store.controller.retry(
      EVENT_ID,
      'feishu',
      'retry-key-0001',
      { reason: 'provider_recovered' },
    )).resolves.toMatchObject({ delivery: { status: 'pending' } });

    expect(store.retry).toHaveBeenCalledWith(
      EVENT_ID, 'feishu', 'provider_recovered', 'retry-key-0001',
    );
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.org_delivery.retry', riskLevel: 'R2', outcome: 'success',
    }));
  });

  it.each([
    ['eventId', 'bad-event', 'feishu', 'retry-key-0001', { reason: 'mapping_fixed' }],
    ['channel', EVENT_ID, 'wecom', 'retry-key-0001', { reason: 'mapping_fixed' }],
    ['reason', EVENT_ID, 'feishu', 'retry-key-0001', { reason: 'anything' }],
    ['idempotency', EVENT_ID, 'feishu', 'short', { reason: 'mapping_fixed' }],
    ['body 缺失', EVENT_ID, 'feishu', 'retry-key-0001', null],
    ['body 额外字段', EVENT_ID, 'feishu', 'retry-key-0001', {
      reason: 'mapping_fixed',
      providerToken: 'forbidden',
    }],
  ])('%s 写入参数非法时不会调用应用服务', async (
    _label,
    eventId,
    channel,
    key,
    body,
  ) => {
    const store = fixture();
    await expect(store.controller.retry(eventId, channel, key, body))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(store.retry).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it('人工重试失败也记录 R2 失败审计且不泄露异常详情', async () => {
    const store = fixture();
    store.retry.mockRejectedValueOnce(new Error('上游返回的敏感详情'));

    await expect(store.controller.retry(
      EVENT_ID, 'dingtalk', 'retry-key-0002', { reason: 'credentials_fixed' },
    )).rejects.toThrow('上游返回的敏感详情');
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: { reason: 'credentials_fixed' },
    }));
    expect(JSON.stringify(store.record.mock.calls)).not.toContain('上游返回的敏感详情');
  });

  it('业务失败时审计故障不得覆盖原始异常', async () => {
    const store = fixture();
    const businessError = new Error('组织投递状态不可重试');
    store.retry.mockRejectedValueOnce(businessError);
    store.record.mockRejectedValueOnce(new Error('审计不可用'));

    await expect(store.controller.retry(
      EVENT_ID, 'op', 'retry-key-0003', { reason: 'approved_exception' },
    )).rejects.toBe(businessError);
    expect(store.record).toHaveBeenCalledOnce();
  });

  it('业务已提交后的成功审计故障不得改变成功响应', async () => {
    const store = fixture();
    store.record.mockRejectedValueOnce(new Error('审计不可用'));

    await expect(store.controller.retry(
      EVENT_ID, 'feishu', 'retry-key-0004', { reason: 'mapping_fixed' },
    )).resolves.toMatchObject({ delivery: { status: 'pending' } });
    expect(store.retry).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledOnce();
  });
});
