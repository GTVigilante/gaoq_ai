import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentCalendarDeliveryDocument } from './recruitment-calendar-delivery.schema.js';
import { RecruitmentCalendarOperationsService } from './recruitment-calendar-operations.service.js';

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X0';
const record = {
  eventId: EVENT_ID,
  channel: 'feishu' as const,
  externalCalendarId: 'calendar-001',
  interviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X1',
  interviewVersion: 2,
  action: 'upsert' as const,
  status: 'manual_review' as const,
  attempts: 1,
  operatorResolutionCount: 0,
  lastErrorCode: 'FEISHU_CALENDAR_RESULT_UNKNOWN',
  lastErrorCategory: 'conflict',
  externalEventId: null,
  updatedAt: new Date('2026-07-28T08:00:00.000Z'),
};

function findQuery(result: readonly unknown[]) {
  return {
    sort: () => ({
      limit: () => ({ lean: () => ({ exec: () => Promise.resolve(result) }) }),
    }),
  };
}

function updateQuery(result: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(result) }) };
}

function fixture(options?: {
  readonly records?: readonly unknown[];
  readonly updated?: unknown;
}) {
  const find = vi.fn().mockReturnValue(findQuery(options?.records ?? [record]));
  const findOneAndUpdate = vi.fn().mockReturnValue(updateQuery(
    options !== undefined && 'updated' in options ? options.updated : record,
  ));
  const getTenantRequired = vi.fn().mockReturnValue({ tenantId: 'tenant-001' });
  const execute = vi.fn().mockImplementation(
    async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<unknown>,
    ) => handler({} as ClientSession),
  );
  const service = new RecruitmentCalendarOperationsService(
    { find, findOneAndUpdate } as unknown as Model<RecruitmentCalendarDeliveryDocument>,
    { getTenantRequired } as unknown as TenantContextService,
    { execute } as unknown as IdempotencyService,
  );
  return { service, find, findOneAndUpdate, getTenantRequired, execute };
}

describe('RecruitmentCalendarOperationsService', () => {
  it('按可信租户分页返回脱敏终态摘要', async () => {
    const next = { ...record, eventId: '01J8ZQK7V0A2M4N6P8R0T2W4W9' };
    const store = fixture({ records: [record, next] });

    await expect(store.service.listTerminal({
      status: 'manual_review',
      channel: 'feishu',
      beforeEventId: '01J8ZQK7V0A2M4N6P8R0T2W4X9',
      limit: 1,
    })).resolves.toEqual({
      items: [{
        eventId: EVENT_ID,
        channel: 'feishu',
        externalCalendarId: 'calendar-001',
        interviewId: record.interviewId,
        interviewVersion: 2,
        action: 'upsert',
        status: 'manual_review',
        attempts: 1,
        operatorResolutionCount: 0,
        lastErrorCode: 'FEISHU_CALENDAR_RESULT_UNKNOWN',
        lastErrorCategory: 'conflict',
        hasExternalEventId: false,
        updatedAt: '2026-07-28T08:00:00.000Z',
      }],
      nextCursor: EVENT_ID,
    });
    expect(store.find.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-001',
      status: 'manual_review',
      channel: 'feishu',
      eventId: { $lt: '01J8ZQK7V0A2M4N6P8R0T2W4X9' },
    });
    const projection = store.find.mock.calls[0]?.[1] as Record<string, number>;
    expect(projection).not.toHaveProperty('location');
    expect(projection).not.toHaveProperty('attendeeExternalIds');
  });

  it('无可选过滤且未满一页时返回空游标并兼容旧记录默认计数', async () => {
    const store = fixture({
      records: [{
        ...record,
        operatorResolutionCount: undefined,
        externalEventId: 'provider-event-001',
      }],
    });
    const result = await store.service.listTerminal({
      status: 'dead',
      limit: 50,
    });
    expect(store.find.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-001',
      status: 'dead',
    });
    expect(result).toMatchObject({
      items: [{ operatorResolutionCount: 0, hasExternalEventId: true }],
      nextCursor: null,
    });
  });

  it('普通故障修复后幂等重置为 pending 并保留可用于更新的外部标识', async () => {
    const store = fixture();

    await expect(store.service.resolve({
      eventId: EVENT_ID,
      channel: 'feishu',
      externalCalendarId: 'calendar-001',
      decision: 'retry',
      reason: 'provider_recovered',
      idempotencyKey: 'calendar-retry-001',
    })).resolves.toEqual({
      delivery: {
        eventId: EVENT_ID,
        channel: 'feishu',
        decision: 'retry',
        status: 'pending',
        reason: 'provider_recovered',
      },
    });

    expect(store.execute).toHaveBeenCalledWith(
      'integration.recruitment_calendar.resolve',
      'calendar-retry-001',
      expect.objectContaining({ decision: 'retry', reason: 'provider_recovered' }),
      expect.any(Function),
    );
    const [filter, update, options] = store.findOneAndUpdate.mock.calls[0] as unknown as [
      Record<string, unknown>, Record<string, unknown>, Record<string, unknown>,
    ];
    expect(filter).toMatchObject({
      tenantId: 'tenant-001',
      eventId: EVENT_ID,
      status: { $in: ['manual_review', 'dead'] },
    });
    const errorFilter = filter.lastErrorCode as { readonly $nin: unknown };
    expect(errorFilter.$nin).toBeInstanceOf(Array);
    expect(update).toMatchObject({
      $set: {
        status: 'pending',
        attempts: 0,
        lockedAt: null,
        lockedBy: null,
        succeededAt: null,
      },
      $inc: { operatorResolutionCount: 1 },
    });
    expect(options).toMatchObject({ runValidators: true, timestamps: false });
    expect((update.$set as Record<string, unknown>)).not.toHaveProperty('externalEventId');
  });

  it('批准例外可确认平台成功并清理失败状态', async () => {
    const store = fixture();

    await expect(store.service.resolve({
      eventId: EVENT_ID,
      channel: 'dingtalk',
      externalCalendarId: 'calendar-001',
      decision: 'accept_succeeded',
      reason: 'approved_exception',
      externalEventId: 'provider-event-001',
      idempotencyKey: 'calendar-accept-001',
    })).resolves.toMatchObject({
      delivery: { decision: 'accept_succeeded', status: 'succeeded' },
    });

    const [filter, update] = store.findOneAndUpdate.mock.calls[0] as unknown as [
      Record<string, unknown>, { readonly $set: Record<string, unknown> },
    ];
    expect(filter).not.toHaveProperty('lastErrorCode');
    expect(update.$set).toMatchObject({
      status: 'succeeded',
      externalEventId: 'provider-event-001',
      lastErrorCode: null,
      lastErrorCategory: null,
    });
  });

  it('不存在、非终态或未批准的结果不确定任务失败关闭', async () => {
    const store = fixture({ updated: null });

    await expect(store.service.resolve({
      eventId: EVENT_ID,
      channel: 'feishu',
      externalCalendarId: 'calendar-001',
      decision: 'retry',
      reason: 'identity_fixed',
      idempotencyKey: 'calendar-retry-002',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_CALENDAR_DELIVERY_NOT_RESOLVABLE' },
    });
  });

  it('服务边界也拒绝缺少外部事件标识的成功确认', async () => {
    const store = fixture();
    await expect(store.service.resolve({
      eventId: EVENT_ID,
      channel: 'feishu',
      externalCalendarId: 'calendar-001',
      decision: 'accept_succeeded',
      reason: 'approved_exception',
      idempotencyKey: 'calendar-accept-002',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_CALENDAR_EXTERNAL_EVENT_ID_REQUIRED' },
    });
    expect(store.execute).not.toHaveBeenCalled();
  });
});
