import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { RecruitmentInterviewService } from '../recruitment/application/recruitment-interview.service.js';
import type { OrgExternalIdentityResolver } from './org-external-identity.resolver.js';
import {
  RecruitmentCalendarError,
  type RecruitmentCalendarAdapterRegistry,
} from './recruitment-calendar.adapter.js';
import type { RecruitmentCalendarDeliveryDocument } from './recruitment-calendar-delivery.schema.js';
import { RecruitmentCalendarDeliveryService } from './recruitment-calendar-delivery.service.js';
import { OrgPushError } from './org-push.adapter.js';

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
  readonly projectionVersion?: number;
  readonly projection?: Readonly<Record<string, unknown>>;
  readonly updateResults?: readonly { readonly matchedCount: number }[];
  readonly adapterError?: unknown;
  readonly adapterExternalEventId?: string;
  readonly auditError?: unknown;
}) {
  const claimed = options !== undefined && 'claimed' in options ? options.claimed : delivery;
  const findOneAndUpdate = vi.fn().mockReturnValueOnce(query(claimed))
    .mockReturnValue(query(null));
  const updateMany = vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
  const findOne = vi.fn().mockReturnValue({
    sort: () => query(options?.previousExternalId === undefined || options.previousExternalId === null
      ? null
      : { externalEventId: options.previousExternalId }),
  });
  const updateOne = vi.fn();
  for (const result of options?.updateResults ?? []) updateOne.mockResolvedValueOnce(result);
  updateOne.mockResolvedValue({ matchedCount: 1 });
  const recordSystem = options?.auditError === undefined
    ? vi.fn().mockResolvedValue(undefined)
    : vi.fn().mockRejectedValue(options.auditError);
  const run = vi.fn().mockImplementation((_trusted: unknown, operation: () => Promise<unknown>) => operation());
  const getCalendarProjectionForIntegration = vi.fn().mockResolvedValue({
    ...projection,
    version: options?.projectionVersion ?? projection.version,
    status: options?.projectionStatus ?? 'scheduled',
    ...options?.projection,
  });
  const findBoundExternalUserId = vi.fn().mockImplementation(
    (_tenantId: string, _channel: string, employeeId: string) =>
      Promise.resolve(options?.externalIdentity === undefined
      ? `external-${employeeId}`
      : options.externalIdentity),
  );
  const adapterResult = {
    externalEventId: options?.adapterExternalEventId ?? 'external-event-001',
  };
  const upsert = options?.adapterError === undefined
    ? vi.fn().mockResolvedValue(adapterResult)
    : vi.fn().mockRejectedValue(options.adapterError);
  const cancel = options?.adapterError === undefined
    ? vi.fn().mockResolvedValue(adapterResult)
    : vi.fn().mockRejectedValue(options.adapterError);
  const get = vi.fn().mockReturnValue({ upsert, cancel });
  const service = new RecruitmentCalendarDeliveryService(
    { findOneAndUpdate, findOne, updateOne, updateMany } as unknown as Model<RecruitmentCalendarDeliveryDocument>,
    { run } as unknown as TenantContextService,
    { recordSystem } as unknown as AuditService,
    { getCalendarProjectionForIntegration } as unknown as RecruitmentInterviewService,
    { findBoundExternalUserId } as unknown as OrgExternalIdentityResolver,
    { get } as unknown as RecruitmentCalendarAdapterRegistry,
  );
  return {
    service, findOneAndUpdate, findOne, updateOne, updateMany, run, recordSystem,
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
      attendeeExternalIds: ['external-employee-001', 'external-employee-002'],
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
      projectionVersion: 2,
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1)).resolves.toBe(1);
    expect(store.cancel).toHaveBeenCalledWith(expect.objectContaining({
      externalCalendarId: 'recruitment-calendar', externalEventId: 'external-event-001', version: 2,
    }));
    expect(store.findOne.mock.calls[0]?.[0]).toMatchObject({
      externalCalendarId: 'recruitment-calendar', action: 'upsert',
    });
  });

  it('每批先隔离超时 processing，且无待处理记录时停止', async () => {
    const store = fixture({ claimed: null });
    await expect(store.service.processBatch('dingtalk', 'calendar-worker-001', 2))
      .resolves.toBe(0);
    const [filter, update, settings] = store.updateMany.mock.calls[0] as unknown as [
      {
        readonly channel: string;
        readonly status: string;
        readonly lockedAt: { readonly $lt: unknown };
      },
      { readonly $set: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(filter).toMatchObject({ channel: 'dingtalk', status: 'processing' });
    expect(filter.lockedAt.$lt).toBeInstanceOf(Date);
    expect(update.$set).toMatchObject({
      status: 'manual_review',
      lastErrorCode: 'CALENDAR_DELIVERY_OUTCOME_UNKNOWN',
    });
    expect(settings).toEqual({ timestamps: false });
    expect(store.run).not.toHaveBeenCalled();
  });

  it.each([
    ['', 1],
    ['bad worker', 1],
    ['calendar-worker-001', 0],
    ['calendar-worker-001', 101],
    ['calendar-worker-001', 1.5],
  ])('拒绝非法 workerId 或批量上限：%s/%s', async (workerId, limit) => {
    const store = fixture();
    await expect(store.service.processBatch('feishu', workerId, limit)).rejects.toThrow();
    expect(store.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['eventId', { eventId: 'bad' }],
    ['tenantId', { tenantId: 'bad tenant' }],
    ['channel', { channel: 'dingtalk' }],
    ['externalCalendarId', { externalCalendarId: 'bad calendar' }],
    ['interviewId', { interviewId: 'bad' }],
    ['interviewVersion unsafe', { interviewVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['interviewVersion zero', { interviewVersion: 0 }],
    ['action', { action: 'delete' }],
    ['attempts fraction', { attempts: 0.5 }],
    ['attempts negative', { attempts: -1 }],
    ['attempts exhausted', { attempts: 8 }],
    ['externalEventId', { externalEventId: 'bad id' }],
  ])('损坏投递记录 %s 进入人工复核', async (_label, patch) => {
    const store = fixture({ claimed: { ...delivery, externalEventId: null, ...patch } });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .resolves.toBe(0);
    expect(store.run).not.toHaveBeenCalled();
    expect(store.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: {
        status: 'manual_review',
        lastErrorCode: 'CALENDAR_DELIVERY_RECORD_INVALID',
        lastErrorCategory: 'business',
      },
    });
  });

  it.each([
    ['interviewId', { interviewId: '01J8ZQK7V0A2M4N6P8R0T2W4X9' }],
    ['version unsafe', { version: Number.MAX_SAFE_INTEGER + 1 }],
    ['version zero', { version: 0 }],
    ['status', { status: 'draft' }],
    ['interviewers type', { interviewerIds: null }],
    ['interviewers empty', { interviewerIds: [] }],
    ['interviewers excess', { interviewerIds: Array.from(
      { length: 101 },
      (_, index) => `employee-${String(index).padStart(3, '0')}`,
    ) }],
    ['interviewer invalid', { interviewerIds: ['bad employee'] }],
    ['interviewer duplicate', { interviewerIds: ['employee-001', 'employee-001'] }],
  ])('损坏投影 %s 进入人工复核且不触发平台调用', async (_label, patch) => {
    const store = fixture({ projection: patch });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .resolves.toBe(0);
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'manual_review',
        lastErrorCode: 'CALENDAR_PROJECTION_INVALID',
        lastErrorCategory: 'conflict',
      },
    });
  });

  it('旧版本排期事件被当前新投影明确取代，不以旧幂等键写当前排期', async () => {
    const store = fixture({ projectionVersion: 2 });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .resolves.toBe(1);
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'succeeded', externalEventId: null },
    });
    expect(store.recordSystem.mock.calls[0]?.[0]).toBe('tenant-001');
    expect(store.recordSystem.mock.calls[0]?.[1]).toMatchObject({
      metadata: { result: 'superseded' },
    });
  });

  it('投影版本落后于任务时进入人工复核', async () => {
    const store = fixture({
      claimed: { ...delivery, interviewVersion: 2 },
      projectionVersion: 1,
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .resolves.toBe(0);
    expect(store.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'manual_review',
        lastErrorCode: 'CALENDAR_PROJECTION_VERSION_INVALID',
      },
    });
  });

  it('取消任务没有历史事件时明确跳过平台删除', async () => {
    const store = fixture({
      claimed: { ...delivery, action: 'cancel', interviewVersion: 2 },
      projectionStatus: 'cancelled',
      projectionVersion: 2,
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .resolves.toBe(1);
    expect(store.cancel).not.toHaveBeenCalled();
    expect(store.recordSystem.mock.calls[0]?.[0]).toBe('tenant-001');
    expect(store.recordSystem.mock.calls[0]?.[1]).toMatchObject({
      metadata: { result: 'skipped' },
    });
  });

  it('人工批准重试保留的外部事件标识优先用于更新', async () => {
    const store = fixture({
      claimed: { ...delivery, externalEventId: 'known-event-001' },
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .resolves.toBe(1);
    expect(store.findOne).not.toHaveBeenCalled();
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({
      currentExternalEventId: 'known-event-001',
    }));
  });

  it.each([
    [
      '平台业务错误',
      new RecruitmentCalendarError('CALENDAR_PROVIDER_REJECTED', 'business', '拒绝'),
      'manual_review',
      1,
    ],
    [
      '平台冲突',
      new RecruitmentCalendarError('CALENDAR_PROVIDER_CONFLICT', 'conflict', '冲突'),
      'manual_review',
      1,
    ],
    [
      '平台可重试耗尽',
      new OrgPushError('ORG_PLATFORM_HTTP_503', 'retryable', '不可用', 503),
      'dead',
      8,
    ],
    ['未知异常', new Error('未知'), 'pending', 1],
  ])('%s 按错误类别进入对应终态', async (
    _label,
    adapterError,
    expectedStatus,
    expectedAttempts,
  ) => {
    const store = fixture({
      claimed: {
        ...delivery,
        attempts: expectedAttempts === 8 ? 7 : 0,
      },
      adapterError,
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .resolves.toBe(0);
    expect(store.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: expectedStatus, attempts: expectedAttempts },
    });
  });

  it('部分提交错误保存已知外部事件标识且禁止自动重试', async () => {
    const store = fixture({
      adapterError: new RecruitmentCalendarError(
        'FEISHU_CALENDAR_ATTENDEES_OUTCOME_UNKNOWN',
        'conflict',
        '参与人结果未知',
        undefined,
        'known-event-001',
      ),
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .resolves.toBe(0);
    expect(store.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'manual_review',
        externalEventId: 'known-event-001',
        lastErrorCode: 'FEISHU_CALENDAR_ATTENDEES_OUTCOME_UNKNOWN',
      },
    });
  });

  it('平台返回非法外部标识时作为结果不确定进入人工复核', async () => {
    const store = fixture({ adapterExternalEventId: 'bad id' });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .resolves.toBe(0);
    expect(store.updateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        status: 'manual_review',
        lastErrorCode: 'CALENDAR_EXTERNAL_EVENT_ID_INVALID',
      },
    });
  });

  it('平台已成功而本地终态写入失败时隔离为结果不确定并停止批次', async () => {
    const store = fixture({
      updateResults: [{ matchedCount: 0 }, { matchedCount: 1 }],
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 2))
      .rejects.toThrow('日历投递终态无法确认');
    expect(store.updateOne).toHaveBeenCalledTimes(2);
    expect(store.updateOne.mock.calls[1]?.[1]).toMatchObject({
      $set: {
        status: 'manual_review',
        externalEventId: 'external-event-001',
        lastErrorCode: 'CALENDAR_DELIVERY_STATE_UNAVAILABLE',
      },
    });
    expect(store.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('结果不确定状态也无法落库时仍停止，绝不回写普通失败', async () => {
    const store = fixture({
      updateResults: [{ matchedCount: 0 }, { matchedCount: 0 }],
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .rejects.toThrow('日历投递终态无法确认');
    expect(store.updateOne).toHaveBeenCalledTimes(2);
  });

  it('业务成功后审计失败不把成功终态改写成失败', async () => {
    const store = fixture({ auditError: new Error('审计不可用') });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .rejects.toThrow('日历投递已提交但审计不可用');
    expect(store.updateOne).toHaveBeenCalledOnce();
    expect(store.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'succeeded' },
    });
  });

  it('失败终态审计失败时不执行第二次业务失败回写', async () => {
    const store = fixture({
      externalIdentity: null,
      auditError: new Error('审计不可用'),
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .rejects.toThrow('日历投递失败终态已提交但审计不可用');
    expect(store.updateOne).toHaveBeenCalledOnce();
    expect(store.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'pending' },
    });
  });

  it('失败回写租约丢失时立即停止且不伪造审计证据', async () => {
    const store = fixture({
      externalIdentity: null,
      updateResults: [{ matchedCount: 0 }],
    });
    await expect(store.service.processBatch('feishu', 'calendar-worker-001', 1))
      .rejects.toThrow('CALENDAR_DELIVERY_CLAIM_LOST');
    expect(store.recordSystem).not.toHaveBeenCalled();
  });
});
