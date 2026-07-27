import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { ApprovalNotificationOperationsService } from './approval-notification-operations.service.js';
import type { ApprovalNotificationDocument } from './approval-notification.schema.js';

const SESSION = {} as ClientSession;
const RECORD = {
  notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
  instanceId: 'instance-001',
  aggregateVersion: 2,
  eventType: 'instance.submitted',
  recipientActorId: 'actor-001',
  channel: 'feishu' as const,
  riskLevel: 'R1' as const,
  attempts: 12,
  operatorRetryCount: 0,
  lastErrorCode: 'ORG_PLATFORM_HTTP_503',
  updatedAt: new Date('2026-07-21T01:00:00.000Z'),
};

function listQuery<T>(value: T) {
  const query = {
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function context(): TenantContextService {
  return {
    getTenantRequired: () => ({ tenantId: 'tenant-001', source: 'access_token' as const }),
  } as unknown as TenantContextService;
}

function idempotency(): IdempotencyService {
  return {
    execute: async <T extends Record<string, unknown>>(
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<T>,
    ): Promise<T> => handler(SESSION),
  } as IdempotencyService;
}

describe('ApprovalNotificationOperationsService', () => {
  it('死信列表强制租户过滤且只返回脱敏投影', async () => {
    const query = listQuery([RECORD]);
    const find = vi.fn().mockReturnValue(query);
    const service = new ApprovalNotificationOperationsService(
      { find } as unknown as Model<ApprovalNotificationDocument>,
      context(),
      idempotency(),
    );
    const result = await service.listDead({ channel: 'feishu', limit: 50 });
    expect(find.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-001', status: 'dead', channel: 'feishu',
    });
    const projection = find.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(projection).not.toHaveProperty('externalMessageId');
    expect(projection).not.toHaveProperty('accessToken');
    expect(result.items[0]).toMatchObject({
      notificationId: RECORD.notificationId,
      lastErrorCode: 'ORG_PLATFORM_HTTP_503',
    });
  });

  it('人工重试只允许租户内死信，并在幂等事务中记录操作次数', async () => {
    const query = listQuery({ ...RECORD, status: 'pending' });
    const findOneAndUpdate = vi.fn().mockReturnValue(query);
    const service = new ApprovalNotificationOperationsService(
      { findOneAndUpdate } as unknown as Model<ApprovalNotificationDocument>,
      context(),
      idempotency(),
    );
    const result = await service.retry(
      RECORD.notificationId,
      'provider_recovered',
      'idempotency-key-001',
    );
    const call = findOneAndUpdate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown>; $inc: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(call[0]).toEqual({
      tenantId: 'tenant-001',
      notificationId: RECORD.notificationId,
      status: 'dead',
      lastErrorCode: {
        $ne: 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE',
      },
    });
    expect(call[1].$set).toMatchObject({ status: 'pending', attempts: 0, lastErrorCode: null });
    expect(call[1].$inc).toEqual({ operatorRetryCount: 1 });
    expect(call[2]).toMatchObject({ session: SESSION, returnDocument: 'after' });
    expect(result.notification).toEqual({
      notificationId: RECORD.notificationId,
      status: 'pending',
      reason: 'provider_recovered',
    });
  });

  it('结果不确定死信只接受明确批准例外，普通修复原因不能触发重发', async () => {
    const approvedQuery = listQuery({ ...RECORD, status: 'pending' });
    const approvedUpdate = vi.fn().mockReturnValue(approvedQuery);
    const approved = new ApprovalNotificationOperationsService(
      { findOneAndUpdate: approvedUpdate } as unknown as Model<ApprovalNotificationDocument>,
      context(),
      idempotency(),
    );
    await approved.retry(
      RECORD.notificationId,
      'approved_exception',
      'idempotency-key-001',
    );
    expect(approvedUpdate.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-001',
      notificationId: RECORD.notificationId,
      status: 'dead',
      lastErrorCode: 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE',
    });

    const deniedUpdate = vi.fn().mockReturnValue(listQuery(null));
    const denied = new ApprovalNotificationOperationsService(
      { findOneAndUpdate: deniedUpdate } as unknown as Model<ApprovalNotificationDocument>,
      context(),
      idempotency(),
    );
    await expect(
      denied.retry(
        RECORD.notificationId,
        'provider_recovered',
        'idempotency-key-002',
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'APPROVAL_NOTIFICATION_NOT_RETRYABLE',
      },
    });
  });

  it('死信列表支持游标分页，空过滤不会构造多余字段', async () => {
    const records = [
      RECORD,
      { ...RECORD, notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y5' },
    ];
    const pageQuery = listQuery(records);
    const find = vi.fn().mockReturnValue(pageQuery);
    const service = new ApprovalNotificationOperationsService(
      { find } as unknown as Model<ApprovalNotificationDocument>,
      context(),
      idempotency(),
    );
    const result = await service.listDead({
      beforeNotificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
      limit: 1,
    });
    expect(find.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-001',
      status: 'dead',
      notificationId: { $lt: '01J8ZQK7V0A2M4N6P8R0T2W4Y7' },
    });
    expect(pageQuery.limit).toHaveBeenCalledWith(2);
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe(RECORD.notificationId);

    const lastPage = new ApprovalNotificationOperationsService(
      { find: vi.fn().mockReturnValue(listQuery([])) } as unknown as Model<ApprovalNotificationDocument>,
      context(),
      idempotency(),
    );
    await expect(lastPage.listDead({ limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('对账视图按租户聚合双平台四态并报告最老积压', async () => {
    const countDocuments = vi.fn().mockResolvedValue(3);
    const findOne = vi.fn().mockReturnValue(listQuery({
      createdAt: new Date('2026-07-21T00:00:00.000Z'),
    }));
    const service = new ApprovalNotificationOperationsService(
      { countDocuments, findOne } as unknown as Model<ApprovalNotificationDocument>,
      context(),
      idempotency(),
    );
    const result = await service.reconciliation();
    expect(countDocuments).toHaveBeenCalledTimes(8);
    const filters = countDocuments.mock.calls.map((call) => call[0] as unknown as {
      tenantId?: string;
    });
    expect(filters.every((filter) => filter.tenantId === 'tenant-001')).toBe(true);
    expect(result.counts.dingtalk.pending).toBe(3);
    expect(result.counts.feishu.dead).toBe(3);
    expect(result.oldestPendingAt).toBe('2026-07-21T00:00:00.000Z');
  });

  it('没有积压时对账返回 null 时间且仍固定全部状态桶', async () => {
    const countDocuments = vi.fn().mockResolvedValue(0);
    const findOne = vi.fn().mockReturnValue(listQuery(null));
    const service = new ApprovalNotificationOperationsService(
      { countDocuments, findOne } as unknown as Model<ApprovalNotificationDocument>,
      context(),
      idempotency(),
    );
    await expect(service.reconciliation()).resolves.toEqual({
      counts: {
        dingtalk: { pending: 0, processing: 0, sent: 0, dead: 0 },
        feishu: { pending: 0, processing: 0, sent: 0, dead: 0 },
      },
      oldestPendingAt: null,
    });
  });
});
