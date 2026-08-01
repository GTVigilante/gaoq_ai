import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { RecruitmentChannelOperationsController } from './recruitment-channel-operations.controller.js';
import type { RecruitmentChannelOperationsService } from './recruitment-channel-operations.service.js';

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y0';

function fixture() {
  const listTerminal = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const retry = vi.fn().mockResolvedValue({
    delivery: {
      kind: 'position', eventId: EVENT_ID, status: 'pending',
      reason: 'approved_exception',
    },
  });
  const record = vi.fn().mockResolvedValue(undefined);
  const controller = new RecruitmentChannelOperationsController(
    { listTerminal, retry } as unknown as RecruitmentChannelOperationsService,
    { record } as unknown as AuditService,
  );
  return { controller, listTerminal, retry, record };
}

describe('RecruitmentChannelOperationsController', () => {
  it('校验查询并转发终态分页参数', async () => {
    const store = fixture();
    await expect(store.controller.list(
      'position', 'manual_review', EVENT_ID, '100',
    )).resolves.toEqual({ items: [], nextCursor: null });
    expect(store.listTerminal).toHaveBeenCalledWith({
      kind: 'position',
      status: 'manual_review',
      beforeEventId: EVENT_ID,
      limit: 100,
    });
  });

  it.each([
    ['类型', () => fixture().controller.list('unknown', 'dead', undefined, undefined)],
    ['状态', () => fixture().controller.list('stage', 'pending', undefined, undefined)],
    ['游标', () => fixture().controller.list('stage', 'dead', 'bad-id', undefined)],
    ['数量', () => fixture().controller.list('stage', 'dead', undefined, '101')],
  ])('%s非法时在控制器边界拒绝', (_label, invoke) => {
    expect(invoke).toThrow(BadRequestException);
  });

  it('以幂等键执行批准重试并记录 R2 成功审计', async () => {
    const store = fixture();
    await expect(store.controller.retry(
      'position',
      EVENT_ID,
      'channel-retry-001',
      {
        reason: 'approved_exception',
        providerConfirmedNotCommitted: true,
      },
    )).resolves.toMatchObject({ delivery: { status: 'pending' } });
    expect(store.retry).toHaveBeenCalledWith({
      kind: 'position',
      eventId: EVENT_ID,
      reason: 'approved_exception',
      providerConfirmedNotCommitted: true,
      idempotencyKey: 'channel-retry-001',
    });
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.recruitment_channel.retry',
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        kind: 'position',
        reason: 'approved_exception',
        providerConfirmedNotCommitted: true,
      },
    }));
  });

  it.each([
    ['kind', 'unknown', EVENT_ID, 'channel-key-001', { reason: 'mapping_fixed' }],
    ['eventId', 'stage', 'bad-id', 'channel-key-001', { reason: 'mapping_fixed' }],
    ['reason', 'stage', EVENT_ID, 'channel-key-001', { reason: 'unknown' }],
    ['idempotency', 'stage', EVENT_ID, 'bad', { reason: 'mapping_fixed' }],
  ])('%s 写入参数非法时失败关闭', async (_label, kind, eventId, key, body) => {
    const store = fixture();
    await expect(store.controller.retry(kind, eventId, key, body)).rejects
      .toBeInstanceOf(BadRequestException);
  });

  it('业务处置失败时记录 R2 失败审计且不追加成功审计', async () => {
    const store = fixture();
    store.retry.mockRejectedValueOnce(new Error('无法处置'));
    await expect(store.controller.retry(
      'stage',
      EVENT_ID,
      'channel-retry-002',
      { reason: 'provider_recovered' },
    )).rejects.toThrow('无法处置');
    expect(store.record).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });

  it('成功状态提交后的审计故障不把已提交结果改写为失败', async () => {
    const store = fixture();
    store.record.mockRejectedValueOnce(new Error('审计不可用'));
    await expect(store.controller.retry(
      'position',
      EVENT_ID,
      'channel-retry-003',
      { reason: 'mapping_fixed' },
    )).resolves.toMatchObject({ delivery: { status: 'pending' } });
  });

  it('失败审计故障不覆盖原始业务错误', async () => {
    const store = fixture();
    store.retry.mockRejectedValueOnce(new Error('原始业务错误'));
    store.record.mockRejectedValueOnce(new Error('审计不可用'));
    await expect(store.controller.retry(
      'stage',
      EVENT_ID,
      'channel-retry-004',
      { reason: 'credentials_fixed' },
    )).rejects.toThrow('原始业务错误');
  });
});
