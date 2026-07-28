import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { RecruitmentCalendarOperationsService } from './recruitment-calendar-operations.service.js';
import { RecruitmentCalendarOperationsController } from './recruitment-calendar-operations.controller.js';

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X0';

function fixture() {
  const listTerminal = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const resolve = vi.fn().mockResolvedValue({
    delivery: {
      eventId: EVENT_ID,
      channel: 'feishu',
      decision: 'retry',
      status: 'pending',
      reason: 'provider_recovered',
    },
  });
  const record = vi.fn().mockResolvedValue(undefined);
  const controller = new RecruitmentCalendarOperationsController(
    { listTerminal, resolve } as unknown as RecruitmentCalendarOperationsService,
    { record } as unknown as AuditService,
  );
  return { controller, listTerminal, resolve, record };
}

describe('RecruitmentCalendarOperationsController', () => {
  it('校验查询并转发终态分页参数', async () => {
    const store = fixture();
    await expect(store.controller.list(
      'dead', 'dingtalk', EVENT_ID, '100',
    )).resolves.toEqual({ items: [], nextCursor: null });
    expect(store.listTerminal).toHaveBeenCalledWith({
      status: 'dead',
      channel: 'dingtalk',
      beforeEventId: EVENT_ID,
      limit: 100,
    });
  });

  it.each([
    ['状态', () => fixture().controller.list('pending', undefined, undefined, undefined)],
    ['渠道', () => fixture().controller.list('dead', 'op', undefined, undefined)],
    ['游标', () => fixture().controller.list('dead', undefined, 'bad-id', undefined)],
    ['数量', () => fixture().controller.list('dead', undefined, undefined, '101')],
  ])('%s非法时在控制器边界拒绝', (_label, invoke) => {
    expect(invoke).toThrow(BadRequestException);
  });

  it('以幂等键执行重试并记录 R2 成功审计', async () => {
    const store = fixture();
    await expect(store.controller.resolve(
      EVENT_ID,
      'feishu',
      'calendar-retry-001',
      {
        externalCalendarId: 'calendar-001',
        decision: 'retry',
        reason: 'provider_recovered',
      },
    )).resolves.toMatchObject({ delivery: { status: 'pending' } });
    expect(store.resolve).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      channel: 'feishu',
      externalCalendarId: 'calendar-001',
      decision: 'retry',
      reason: 'provider_recovered',
      idempotencyKey: 'calendar-retry-001',
    });
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.recruitment_calendar.resolve',
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { decision: 'retry', reason: 'provider_recovered' },
    }));
  });

  it('确认成功强制要求合法外部事件标识', async () => {
    const store = fixture();
    await expect(store.controller.resolve(
      EVENT_ID,
      'feishu',
      'calendar-accept-001',
      {
        externalCalendarId: 'calendar-001',
        decision: 'accept_succeeded',
        reason: 'approved_exception',
      },
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.controller.resolve(
      EVENT_ID,
      'feishu',
      'calendar-accept-001',
      {
        externalCalendarId: 'calendar-001',
        decision: 'accept_succeeded',
        reason: 'approved_exception',
        externalEventId: 'bad id',
      },
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['eventId', 'bad-event', 'feishu', 'calendar-key-001', {
      externalCalendarId: 'calendar-001', decision: 'retry', reason: 'identity_fixed',
    }],
    ['channel', EVENT_ID, 'op', 'calendar-key-001', {
      externalCalendarId: 'calendar-001', decision: 'retry', reason: 'identity_fixed',
    }],
    ['calendar', EVENT_ID, 'feishu', 'calendar-key-001', {
      externalCalendarId: 'bad id', decision: 'retry', reason: 'identity_fixed',
    }],
    ['decision', EVENT_ID, 'feishu', 'calendar-key-001', {
      externalCalendarId: 'calendar-001', decision: 'delete', reason: 'identity_fixed',
    }],
    ['reason', EVENT_ID, 'feishu', 'calendar-key-001', {
      externalCalendarId: 'calendar-001', decision: 'retry', reason: 'unknown',
    }],
    ['idempotency', EVENT_ID, 'feishu', 'bad', {
      externalCalendarId: 'calendar-001', decision: 'retry', reason: 'identity_fixed',
    }],
  ])('%s 写入参数非法时失败关闭', async (_label, eventId, channel, key, body) => {
    const store = fixture();
    await expect(store.controller.resolve(eventId, channel, key, body)).rejects
      .toBeInstanceOf(BadRequestException);
  });

  it('业务处置失败时记录 R2 失败审计且不追加成功审计', async () => {
    const store = fixture();
    store.resolve.mockRejectedValueOnce(new Error('无法处置'));
    await expect(store.controller.resolve(
      EVENT_ID,
      'dingtalk',
      'calendar-retry-003',
      {
        externalCalendarId: 'calendar-001',
        decision: 'retry',
        reason: 'approved_exception',
      },
    )).rejects.toThrow('无法处置');
    expect(store.record).toHaveBeenCalledOnce();
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });
});
