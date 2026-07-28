import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RecruitmentChannelOperationsService } from './recruitment-channel-operations.service.js';
import type {
  RecruitmentChannelPositionDeliveryDocument,
  RecruitmentChannelStageDeliveryDocument,
} from './recruitment-channel.schemas.js';

const EVENT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y0';
const RESOURCE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y1';
const UPDATED_AT = new Date('2026-07-28T08:00:00.000Z');

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
  readonly positionRecords?: readonly unknown[];
  readonly stageRecords?: readonly unknown[];
  readonly updated?: unknown;
}) {
  const positionFind = vi.fn().mockReturnValue(findQuery(options?.positionRecords ?? []));
  const stageFind = vi.fn().mockReturnValue(findQuery(options?.stageRecords ?? []));
  const positionUpdate = vi.fn().mockReturnValue(updateQuery(
    options !== undefined && 'updated' in options ? options.updated : { eventId: EVENT_ID },
  ));
  const stageUpdate = vi.fn().mockReturnValue(updateQuery(
    options !== undefined && 'updated' in options ? options.updated : { eventId: EVENT_ID },
  ));
  const execute = vi.fn().mockImplementation(
    async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<unknown>,
    ) => handler({} as ClientSession),
  );
  const service = new RecruitmentChannelOperationsService(
    {
      find: positionFind,
      findOneAndUpdate: positionUpdate,
    } as unknown as Model<RecruitmentChannelPositionDeliveryDocument>,
    {
      find: stageFind,
      findOneAndUpdate: stageUpdate,
    } as unknown as Model<RecruitmentChannelStageDeliveryDocument>,
    {
      getTenantRequired: vi.fn().mockReturnValue({ tenantId: 'tenant-001' }),
    } as unknown as TenantContextService,
    { execute } as unknown as IdempotencyService,
  );
  return { service, positionFind, stageFind, positionUpdate, stageUpdate, execute };
}

describe('RecruitmentChannelOperationsService', () => {
  it('按可信租户分页返回职位投递脱敏摘要', async () => {
    const record = {
      eventId: EVENT_ID, positionId: RESOURCE_ID, positionVersion: 3,
      action: 'close', targetStatus: 'paused', status: 'manual_review',
      attempts: 2, operatorResolutionCount: 1,
      failureCode: 'RECRUITMENT_CHANNEL_POSITION_OUTCOME_UNKNOWN',
      updatedAt: UPDATED_AT,
    };
    const store = fixture({ positionRecords: [
      record,
      { ...record, eventId: '01J8ZQK7V0A2M4N6P8R0T2W4X9' },
    ] });
    await expect(store.service.listTerminal({
      kind: 'position',
      status: 'manual_review',
      beforeEventId: '01J8ZQK7V0A2M4N6P8R0T2W4Z0',
      limit: 1,
    })).resolves.toEqual({
      items: [{
        kind: 'position', eventId: EVENT_ID, resourceId: RESOURCE_ID,
        version: 3, operation: 'close:paused', status: 'manual_review',
        attempts: 2, operatorResolutionCount: 1,
        failureCode: 'RECRUITMENT_CHANNEL_POSITION_OUTCOME_UNKNOWN',
        updatedAt: UPDATED_AT.toISOString(),
      }],
      nextCursor: EVENT_ID,
    });
    expect(store.positionFind.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-001',
      status: 'manual_review',
      eventId: { $lt: '01J8ZQK7V0A2M4N6P8R0T2W4Z0' },
    });
    expect(store.stageFind).not.toHaveBeenCalled();
  });

  it('阶段投递摘要不暴露候选人、凭据或外部标识', async () => {
    const store = fixture({ stageRecords: [{
      eventId: EVENT_ID, applicationId: RESOURCE_ID, applicationVersion: 4,
      stage: 'offer', status: 'dead', attempts: 12,
      operatorResolutionCount: undefined, failureCode: 'CHANNEL_RATE_LIMITED',
      updatedAt: UPDATED_AT,
    }] });
    const result = await store.service.listTerminal({
      kind: 'stage', status: 'dead', limit: 50,
    });
    expect(result).toEqual({
      items: [{
        kind: 'stage', eventId: EVENT_ID, resourceId: RESOURCE_ID,
        version: 4, operation: 'offer', status: 'dead', attempts: 12,
        operatorResolutionCount: 0, failureCode: 'CHANNEL_RATE_LIMITED',
        updatedAt: UPDATED_AT.toISOString(),
      }],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/credential|external|candidate/iu);
  });

  it.each(['position', 'stage'] as const)(
    '供应商确认未提交且存在批准例外时可幂等重入 pending：%s',
    async (kind) => {
      const store = fixture();
      await expect(store.service.retry({
        kind,
        eventId: EVENT_ID,
        reason: 'approved_exception',
        providerConfirmedNotCommitted: true,
        idempotencyKey: `channel-retry-${kind}`,
      })).resolves.toEqual({
        delivery: {
          kind, eventId: EVENT_ID, status: 'pending', reason: 'approved_exception',
        },
      });
      const update = kind === 'position' ? store.positionUpdate : store.stageUpdate;
      const [filter, mutation] = update.mock.calls[0] as unknown as [
        Record<string, unknown>,
        { readonly $set: Record<string, unknown>; readonly $inc: Record<string, unknown> },
      ];
      expect(filter).toEqual({
        tenantId: 'tenant-001',
        eventId: EVENT_ID,
        status: { $in: ['manual_review', 'dead'] },
      });
      expect(mutation).toMatchObject({
        $set: {
          status: 'pending', attempts: 0, lockedAt: null,
          lockedBy: null, succeededAt: null,
        },
        $inc: { operatorResolutionCount: 1 },
      });
      expect(store.execute).toHaveBeenCalledWith(
        'integration.recruitment_channel.retry',
        `channel-retry-${kind}`,
        expect.objectContaining({ providerConfirmedNotCommitted: true }),
        expect.any(Function),
      );
    },
  );

  it('普通修复只能重试非结果未知 dead 记录', async () => {
    const store = fixture();
    await store.service.retry({
      kind: 'position',
      eventId: EVENT_ID,
      reason: 'provider_recovered',
      providerConfirmedNotCommitted: false,
      idempotencyKey: 'channel-retry-dead',
    });
    const filter = store.positionUpdate.mock.calls[0]?.[0] as {
      readonly tenantId?: unknown;
      readonly eventId?: unknown;
      readonly status?: unknown;
      readonly failureCode?: { readonly $nin?: unknown };
    } | undefined;
    expect(filter).toMatchObject({
      tenantId: 'tenant-001',
      eventId: EVENT_ID,
      status: 'dead',
    });
    expect(filter?.failureCode?.$nin).toBeInstanceOf(Array);
  });

  it('不存在或缺少批准证据时失败关闭', async () => {
    const store = fixture({ updated: null });
    await expect(store.service.retry({
      kind: 'stage',
      eventId: EVENT_ID,
      reason: 'approved_exception',
      providerConfirmedNotCommitted: false,
      idempotencyKey: 'channel-retry-denied',
    })).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_CHANNEL_DELIVERY_NOT_RESOLVABLE' },
    });
  });
});
