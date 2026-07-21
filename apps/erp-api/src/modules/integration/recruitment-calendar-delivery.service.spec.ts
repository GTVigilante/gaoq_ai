import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentInterviewService } from '../recruitment/application/recruitment-interview.service.js';
import type { OrgExternalIdentityResolver } from './org-external-identity.resolver.js';
import type { RecruitmentCalendarAdapterRegistry } from './recruitment-calendar.adapter.js';
import type { RecruitmentCalendarDeliveryDocument } from './recruitment-calendar-delivery.schema.js';
import { RecruitmentCalendarDeliveryService } from './recruitment-calendar-delivery.service.js';

const delivery = {
  eventId: '01J8ZQK7V0A2M4N6P8R0T2W4X0', tenantId: 'tenant-001', channel: 'feishu' as const,
  externalCalendarId: 'recruitment-calendar',
  interviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X1', interviewVersion: 1,
  action: 'upsert' as const, attempts: 0,
};
const projection = {
  interviewId: delivery.interviewId, applicationId: 'application-001', version: 1,
  status: 'scheduled' as const, startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:00:00.000Z', timezone: 'Asia/Shanghai',
  interviewerIds: ['employee-001', 'employee-002'], location: 'https://meeting.example/secret',
};

function query(result: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(result) }) };
}

function fixture(options?: {
  readonly claimed?: unknown;
  readonly previousExternalId?: string | null;
  readonly externalIdentity?: string | null;
  readonly projectionStatus?: 'scheduled' | 'completed' | 'cancelled';
}) {
  const findOneAndUpdate = vi.fn().mockReturnValueOnce(query(options?.claimed ?? delivery))
    .mockReturnValue(query(null));
  const findOne = vi.fn().mockReturnValue({
    sort: () => query(options?.previousExternalId === undefined || options.previousExternalId === null
      ? null
      : { externalEventId: options.previousExternalId }),
  });
  const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
  const run = vi.fn().mockImplementation((_trusted: unknown, operation: () => Promise<unknown>) => operation());
  const getCalendarProjectionForIntegration = vi.fn().mockResolvedValue({
    ...projection, status: options?.projectionStatus ?? 'scheduled',
  });
  const findBoundExternalUserId = vi.fn().mockResolvedValue(
    options?.externalIdentity === undefined ? 'external-user-001' : options.externalIdentity,
  );
  const upsert = vi.fn().mockResolvedValue({ externalEventId: 'external-event-001' });
  const cancel = vi.fn().mockResolvedValue({ externalEventId: 'external-event-001' });
  const get = vi.fn().mockReturnValue({ upsert, cancel });
  const service = new RecruitmentCalendarDeliveryService(
    { findOneAndUpdate, findOne, updateOne } as unknown as Model<RecruitmentCalendarDeliveryDocument>,
    { run } as unknown as TenantContextService,
    { getCalendarProjectionForIntegration } as unknown as RecruitmentInterviewService,
    { findBoundExternalUserId } as unknown as OrgExternalIdentityResolver,
    { get } as unknown as RecruitmentCalendarAdapterRegistry,
  );
  return {
    service, findOneAndUpdate, findOne, updateOne, run,
    getCalendarProjectionForIntegration, findBoundExternalUserId, get, upsert, cancel,
  };
}

describe('RecruitmentCalendarDeliveryService', () => {
  it('在可审计 system_job 租户上下文中解密投影并调用标准适配器', async () => {
    const store = fixture();
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 10)).resolves.toBe(1);
    const trusted = store.run.mock.calls[0]?.[0] as unknown as {
      readonly tenant: { readonly source: string };
      readonly actor: { readonly actorType: string; readonly scopes: readonly string[] };
    };
    expect(trusted).toMatchObject({
      tenant: { source: 'service_identity' },
      actor: { actorType: 'system_job', scopes: ['erp:integration:calendar:deliver'] },
    });
    expect(store.findBoundExternalUserId).toHaveBeenCalledTimes(2);
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', interviewId: delivery.interviewId,
      externalCalendarId: 'recruitment-calendar',
      attendeeExternalIds: ['external-user-001', 'external-user-001'],
      location: projection.location, currentExternalEventId: null,
    }));
    expect(store.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'succeeded', externalEventId: 'external-event-001' },
    });
  });

  it('外部员工身份未就绪时按可重试失败保留任务', async () => {
    const store = fixture({ externalIdentity: null });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1)).resolves.toBe(0);
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'pending', attempts: 1,
        lastErrorCode: 'CALENDAR_EXTERNAL_IDENTITY_PENDING', lastErrorCategory: 'retryable',
      },
    });
  });

  it('排期任务延迟到面试已取消时不再补建外部日程', async () => {
    const store = fixture({ projectionStatus: 'cancelled' });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1)).resolves.toBe(1);
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'succeeded', externalEventId: null },
    });
  });

  it('取消任务复用已成功投递的外部事件标识', async () => {
    const store = fixture({
      claimed: { ...delivery, action: 'cancel', interviewVersion: 2 },
      previousExternalId: 'external-event-001', projectionStatus: 'cancelled',
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1)).resolves.toBe(1);
    expect(store.cancel).toHaveBeenCalledWith(expect.objectContaining({
      externalCalendarId: 'recruitment-calendar', externalEventId: 'external-event-001', version: 2,
    }));
    expect(store.findOne.mock.calls[0]?.[0]).toMatchObject({
      externalCalendarId: 'recruitment-calendar', action: 'upsert',
    });
  });
});
