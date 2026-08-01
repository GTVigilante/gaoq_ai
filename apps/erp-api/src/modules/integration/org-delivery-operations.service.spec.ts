import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { OrgDeliveryDocument } from './org-delivery.schemas.js';
import { OrgDeliveryOperationsService } from './org-delivery-operations.service.js';

const EVENT_ID = '01K00000000000000000000000';

function listQuery(value: unknown) {
  return { sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }) }) };
}

describe('OrgDeliveryOperationsService', () => {
  it('人工队列查询强制可信租户过滤且不投影 envelope', async () => {
    const find = vi.fn().mockReturnValue(listQuery([{
      eventId: EVENT_ID,
      channel: 'feishu',
      aggregateType: 'org.employee',
      aggregateId: 'employee-a',
      aggregateVersion: 2,
      status: 'manual_review',
      attempts: 1,
      operatorRetryCount: 0,
      lastErrorCode: 'ORG_EMPLOYEE_PREPROVISION_REQUIRED',
      lastErrorCategory: 'business',
      updatedAt: new Date('2026-07-21T00:00:00.000Z'),
    }]));
    const service = new OrgDeliveryOperationsService(
      { find } as unknown as Model<OrgDeliveryDocument>,
      { getTenantRequired: () => ({ tenantId: 'tenant-a' }) } as TenantContextService,
      {} as IdempotencyService,
    );

    const result = await service.listTerminal({
      status: 'manual_review', channel: 'feishu', limit: 50,
    });

    expect(result.items).toHaveLength(1);
    const [filter, projection] = find.mock.calls[0] as [Record<string, unknown>, Record<string, number>];
    expect(filter).toMatchObject({ tenantId: 'tenant-a', status: 'manual_review', channel: 'feishu' });
    expect(projection).not.toHaveProperty('envelope');
  });

  it('人工重试在统一幂等事务内仅更新本租户终态记录', async () => {
    const findOneAndUpdate = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ eventId: EVENT_ID }) }),
    });
    const execute = vi.fn().mockImplementation(
      async (_operation: string, _key: string, _request: unknown, handler: (session: ClientSession) => Promise<unknown>) =>
        handler({} as ClientSession),
    );
    const service = new OrgDeliveryOperationsService(
      { findOneAndUpdate } as unknown as Model<OrgDeliveryDocument>,
      { getTenantRequired: () => ({ tenantId: 'tenant-a' }) } as TenantContextService,
      { execute } as unknown as IdempotencyService,
    );

    await expect(service.retry(
      EVENT_ID, 'dingtalk', 'mapping_fixed', 'retry-key-0001',
    )).resolves.toEqual({
      delivery: { eventId: EVENT_ID, channel: 'dingtalk', status: 'pending', reason: 'mapping_fixed' },
    });

    expect(execute).toHaveBeenCalledWith(
      'integration.org_delivery.retry',
      'retry-key-0001',
      { eventId: EVENT_ID, channel: 'dingtalk', reason: 'mapping_fixed' },
      expect.any(Function),
    );
    expect(findOneAndUpdate.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-a', eventId: EVENT_ID, channel: 'dingtalk',
      status: { $in: ['manual_review', 'dead'] },
      lastErrorCode: { $ne: 'ORG_DELIVERY_RESULT_INDETERMINATE' },
    });
    expect(findOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'pending', attempts: 0 },
      $inc: { operatorRetryCount: 1 },
    });
  });

  it('结果不确定记录只有批准例外可进入人工重试', async () => {
    const findOneAndUpdate = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ eventId: EVENT_ID }) }),
    });
    const execute = vi.fn().mockImplementation(
      async (
        _operation: string,
        _key: string,
        _request: unknown,
        handler: (session: ClientSession) => Promise<unknown>,
      ) => handler({} as ClientSession),
    );
    const service = new OrgDeliveryOperationsService(
      { findOneAndUpdate } as unknown as Model<OrgDeliveryDocument>,
      { getTenantRequired: () => ({ tenantId: 'tenant-a' }) } as TenantContextService,
      { execute } as unknown as IdempotencyService,
    );

    await service.retry(EVENT_ID, 'dingtalk', 'approved_exception', 'retry-key-0002');

    expect(findOneAndUpdate.mock.calls[0]?.[0]).not.toHaveProperty('lastErrorCode');
  });

  it('终态列表支持无渠道游标分页并返回下一游标', async () => {
    const records = [
      {
        eventId: '01K00000000000000000000002',
        channel: 'dingtalk',
        aggregateType: 'org.department',
        aggregateId: 'department-a',
        aggregateVersion: 2,
        status: 'dead',
        attempts: 6,
        operatorRetryCount: 0,
        lastErrorCode: 'ORG_PUSH_UNEXPECTED',
        lastErrorCategory: 'retryable',
        updatedAt: new Date('2026-07-21T00:00:00.000Z'),
      },
      {
        eventId: '01K00000000000000000000001',
        channel: 'feishu',
        aggregateType: 'org.employee',
        aggregateId: 'employee-a',
        aggregateVersion: 1,
        status: 'dead',
        attempts: 6,
        operatorRetryCount: 1,
        lastErrorCode: 'ORG_PUSH_UNEXPECTED',
        lastErrorCategory: 'retryable',
        updatedAt: new Date('2026-07-20T00:00:00.000Z'),
      },
    ];
    const find = vi.fn().mockReturnValue(listQuery(records));
    const service = new OrgDeliveryOperationsService(
      { find } as unknown as Model<OrgDeliveryDocument>,
      { getTenantRequired: () => ({ tenantId: 'tenant-a' }) } as TenantContextService,
      {} as IdempotencyService,
    );

    const result = await service.listTerminal({
      status: 'dead',
      beforeEventId: '01K00000000000000000000003',
      limit: 1,
    });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe('01K00000000000000000000002');
    expect(find.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-a',
      eventId: { $lt: '01K00000000000000000000003' },
    });
    expect(find.mock.calls[0]?.[0]).not.toHaveProperty('channel');
  });

  it('不存在或已离开终态的投递拒绝人工重试', async () => {
    const findOneAndUpdate = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    });
    const execute = vi.fn().mockImplementation(
      async (
        _operation: string,
        _key: string,
        _request: unknown,
        handler: (session: ClientSession) => Promise<unknown>,
      ) => handler({} as ClientSession),
    );
    const service = new OrgDeliveryOperationsService(
      { findOneAndUpdate } as unknown as Model<OrgDeliveryDocument>,
      { getTenantRequired: () => ({ tenantId: 'tenant-a' }) } as TenantContextService,
      { execute } as unknown as IdempotencyService,
    );

    await expect(service.retry(
      EVENT_ID,
      'feishu',
      'provider_recovered',
      'retry-key-0003',
    )).rejects.toMatchObject({
      response: { code: 'ORG_DELIVERY_NOT_RETRYABLE' },
    });
  });
});
