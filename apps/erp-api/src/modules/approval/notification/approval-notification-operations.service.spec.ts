import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  ApprovalNotificationOperationsService,
  type ApprovalNotificationRetryReason,
} from './approval-notification-operations.service.js';
import type { ApprovalNotificationDocument } from './approval-notification.schema.js';

const SESSION = {} as ClientSession;
const TENANT_ID = 'tenant-001';
const NOTIFICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const BEFORE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const NOW = new Date('2026-07-21T01:00:00.000Z');
const READ_SCOPE = 'erp:approval:notification:read';
const OPERATE_SCOPE = 'erp:approval:notification:operate';
const RECORD = {
  tenantId: TENANT_ID,
  notificationId: NOTIFICATION_ID,
  instanceId: 'instance-001',
  aggregateVersion: 2,
  eventType: 'instance.submitted',
  recipientActorId: 'actor-001',
  channel: 'feishu' as const,
  riskLevel: 'R1' as const,
  status: 'dead' as const,
  attempts: 12,
  operatorRetryCount: 0,
  lastErrorCode: 'ORG_PLATFORM_HTTP_503',
  updatedAt: NOW,
};

function query<T>(value: T) {
  const chain = {
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
}

function context(scopes: readonly string[] = [READ_SCOPE, OPERATE_SCOPE]): TenantContextService {
  return {
    getRequired: () => ({
      tenant: { tenantId: TENANT_ID, source: 'access_token' as const },
      actor: {
        actorId: 'operator-001',
        actorType: 'user' as const,
        scopes,
        roles: [],
        departmentIds: [],
        traceId: 'trace-001',
      },
    }),
  } as unknown as TenantContextService;
}

function idempotency(
  execute = async <T extends Record<string, unknown>>(
    _operation: string,
    _key: string,
    _request: unknown,
    handler: (session: ClientSession) => Promise<T>,
  ): Promise<T> => handler(SESSION),
): IdempotencyService {
  return { execute } as IdempotencyService;
}

function retryRecord(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_ID,
    notificationId: NOTIFICATION_ID,
    status: 'pending',
    attempts: 0,
    operatorRetryCount: 1,
    nextAttemptAt: NOW,
    lockedAt: null,
    lockedBy: null,
    externalMessageId: null,
    lastErrorCode: null,
    sentAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function service(
  records: Partial<Model<ApprovalNotificationDocument>>,
  scopes?: readonly string[],
  idempotencyService = idempotency(),
) {
  return new ApprovalNotificationOperationsService(
    records as Model<ApprovalNotificationDocument>,
    context(scopes),
    idempotencyService,
  );
}

describe('ApprovalNotificationOperationsService', () => {
  it('死信列表强制可信租户、固定最小投影并返回深冻结脱敏分页', async () => {
    const records = [
      RECORD,
      { ...RECORD, notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y5' },
    ];
    const listQuery = query(records);
    const find = vi.fn().mockReturnValue(listQuery);
    const result = await service({ find }).listDead({
      channel: 'feishu',
      beforeNotificationId: BEFORE_ID,
      limit: 1,
    });

    expect(find).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      status: 'dead',
      channel: 'feishu',
      notificationId: { $lt: BEFORE_ID },
    }, {
      tenantId: 1,
      notificationId: 1,
      instanceId: 1,
      aggregateVersion: 1,
      eventType: 1,
      recipientActorId: 1,
      channel: 1,
      riskLevel: 1,
      status: 1,
      attempts: 1,
      operatorRetryCount: 1,
      lastErrorCode: 1,
      updatedAt: 1,
      _id: 0,
    });
    expect(listQuery.sort).toHaveBeenCalledWith({ notificationId: -1 });
    expect(listQuery.limit).toHaveBeenCalledWith(2);
    expect(result).toEqual({
      items: [{
        notificationId: NOTIFICATION_ID,
        instanceId: 'instance-001',
        aggregateVersion: 2,
        eventType: 'instance.submitted',
        recipientActorId: 'actor-001',
        channel: 'feishu',
        riskLevel: 'R1',
        attempts: 12,
        operatorRetryCount: 0,
        lastErrorCode: 'ORG_PLATFORM_HTTP_503',
        updatedAt: NOW.toISOString(),
      }],
      nextCursor: NOTIFICATION_ID,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
  });

  it('空过滤与末页不构造多余查询字段', async () => {
    const find = vi.fn().mockReturnValue(query([]));
    await expect(service({ find }).listDead({ limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(find.mock.calls[0]?.[0]).toEqual({
      tenantId: TENANT_ID,
      status: 'dead',
    });
  });

  it.each([
    ['结构 null', null],
    ['结构数组', []],
    ['未知字段', { limit: 50, tenantId: 'tenant-002' }],
    ['channel', { channel: 'op', limit: 50 }],
    ['beforeNotificationId', { beforeNotificationId: 'bad-id', limit: 50 }],
    ['beforeNotificationId 非字符串', { beforeNotificationId: 1, limit: 50 }],
    ['limit 下界', { limit: 0 }],
    ['limit 非整数', { limit: 1.5 }],
    ['limit 上界', { limit: 101 }],
  ])('应用服务二次拒绝非法列表参数：%s', async (_label, input) => {
    const target = service({ find: vi.fn() });
    await expect(target.listDead(input as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['跨租户', { tenantId: 'tenant-002' }],
    ['状态漂移', { status: 'sent' }],
    ['渠道漂移', { channel: 'dingtalk' }],
    ['非法通知标识', { notificationId: 'bad-id' }],
    ['非法错误码', { lastErrorCode: 'provider error' }],
    ['额外字段', { accessToken: 'forbidden' }],
    ['未来更新时间', { updatedAt: new Date('2999-01-01T00:00:00.000Z') }],
  ])('列表投影受损时整页失败关闭：%s', async (_label, overrides) => {
    const find = vi.fn().mockReturnValue(query([{ ...RECORD, ...overrides }]));
    await expect(service({ find }).listDead({
      channel: 'feishu',
      limit: 50,
    })).rejects.toThrow('APPROVAL_NOTIFICATION_STATE_INVALID');
  });

  it('超出查询预算的返回集合失败关闭', async () => {
    const find = vi.fn().mockReturnValue(query([
      RECORD,
      { ...RECORD, notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y5' },
      { ...RECORD, notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y4' },
    ]));
    await expect(service({ find }).listDead({ limit: 1 }))
      .rejects.toThrow('APPROVAL_NOTIFICATION_STATE_INVALID');
  });

  it('读取方法在应用层再次拒绝缺失 Scope', async () => {
    const target = service({}, []);
    await expect(target.listDead({ limit: 50 })).rejects.toMatchObject({
      response: { code: 'APPROVAL_NOTIFICATION_READ_SCOPE_REQUIRED' },
    });
    await expect(target.reconciliation()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each<[
    ApprovalNotificationRetryReason,
    unknown,
  ]>([
    ['credentials_fixed', {
      $in: [
        'ORG_CREDENTIAL_REF_INVALID',
        'ORG_CREDENTIAL_UNAVAILABLE',
        'ORG_CREDENTIAL_INVALID',
        'ORG_PLATFORM_BINDING_MISSING',
        'ORG_PLATFORM_HTTP_401',
      ],
    }],
    ['identity_bound', {
      $in: [
        'APPROVAL_RECIPIENT_INACTIVE',
        'APPROVAL_RECIPIENT_IDENTITY_UNBOUND',
      ],
    }],
    ['provider_recovered', {
      $in: [
        'ORG_PLATFORM_NETWORK_ERROR',
        'ORG_PLATFORM_RESPONSE_READ_ERROR',
        'ORG_PLATFORM_RESPONSE_TOO_LARGE',
        'ORG_PLATFORM_RESPONSE_INVALID',
        'DINGTALK_TOKEN_RESPONSE_INVALID',
        'FEISHU_TOKEN_RESPONSE_INVALID',
        'DINGTALK_APPROVAL_MESSAGE_RESPONSE_INVALID',
        'FEISHU_APPROVAL_MESSAGE_RESPONSE_INVALID',
        /^ORG_PLATFORM_HTTP_(?:429|5[0-9]{2})$/,
      ],
    }],
    ['approved_exception', 'APPROVAL_NOTIFICATION_DELIVERY_INDETERMINATE'],
  ])('人工重试原因 %s 只匹配对应错误类别', async (reason, expectedErrorFilter) => {
    const updateQuery = query(retryRecord());
    const findOneAndUpdate = vi.fn().mockReturnValue(updateQuery);
    const result = await service({ findOneAndUpdate }).retry(
      NOTIFICATION_ID,
      reason,
      'notification-retry-001',
    );
    const [filter, update, options] = findOneAndUpdate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown>; $inc: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(filter).toEqual({
      tenantId: TENANT_ID,
      notificationId: NOTIFICATION_ID,
      status: 'dead',
      operatorRetryCount: { $lt: 100 },
      lastErrorCode: expectedErrorFilter,
    });
    expect(update.$set).toMatchObject({
      status: 'pending',
      attempts: 0,
      lockedAt: null,
      lockedBy: null,
      externalMessageId: null,
      lastErrorCode: null,
      sentAt: null,
    });
    expect(update.$set.nextAttemptAt).toBe(update.$set.updatedAt);
    expect(update.$inc).toEqual({ operatorRetryCount: 1 });
    expect(options).toMatchObject({
      session: SESSION,
      returnDocument: 'after',
      timestamps: false,
      runValidators: true,
    });
    expect(options.projection).toEqual(expect.objectContaining({
      tenantId: 1,
      notificationId: 1,
      status: 1,
      updatedAt: 1,
      _id: 0,
    }));
    expect(result).toEqual({
      notification: {
        notificationId: NOTIFICATION_ID,
        status: 'pending',
        reason,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.notification)).toBe(true);
  });

  it('幂等服务绑定固定操作名、请求摘要和事务会话', async () => {
    const findOneAndUpdate = vi.fn().mockReturnValue(query(retryRecord()));
    const execute = vi.fn();
    const idempotencyService = {
      execute: async <T extends Record<string, unknown>>(
        operation: string,
        key: string,
        request: unknown,
        handler: (session: ClientSession) => Promise<T>,
      ): Promise<T> => {
        execute(operation, key, request, handler);
        return handler(SESSION);
      },
    } as IdempotencyService;
    await service({ findOneAndUpdate }, undefined, idempotencyService).retry(
      NOTIFICATION_ID,
      'provider_recovered',
      'notification-retry-002',
    );
    expect(execute).toHaveBeenCalledWith(
      'approval.notification.retry',
      'notification-retry-002',
      {
        notificationId: NOTIFICATION_ID,
        reason: 'provider_recovered',
      },
      expect.any(Function),
    );
  });

  it.each([
    ['通知标识', 'bad-id', 'provider_recovered', 'notification-retry-003'],
    ['通知标识非字符串', 1, 'provider_recovered', 'notification-retry-003'],
    ['原因', NOTIFICATION_ID, 'unknown', 'notification-retry-003'],
    ['原因非字符串', NOTIFICATION_ID, 1, 'notification-retry-003'],
    ['幂等键', NOTIFICATION_ID, 'provider_recovered', 'bad'],
    ['幂等键非字符串', NOTIFICATION_ID, 'provider_recovered', 1],
  ])('应用服务二次拒绝非法重试参数：%s', async (
    _label,
    notificationId,
    reason,
    key,
  ) => {
    await expect(service({}).retry(
      notificationId as never,
      reason as ApprovalNotificationRetryReason,
      key as never,
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('写方法在应用层再次拒绝缺失 Scope', async () => {
    await expect(service({}, [READ_SCOPE]).retry(
      NOTIFICATION_ID,
      'provider_recovered',
      'notification-retry-004',
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_NOTIFICATION_OPERATE_SCOPE_REQUIRED' },
    });
  });

  it('不存在、不属于当前状态或达到人工重试上限时统一拒绝', async () => {
    const findOneAndUpdate = vi.fn().mockReturnValue(query(null));
    await expect(service({ findOneAndUpdate }).retry(
      NOTIFICATION_ID,
      'identity_bound',
      'notification-retry-005',
    )).rejects.toBeInstanceOf(NotFoundException);
    await expect(service({ findOneAndUpdate }).retry(
      NOTIFICATION_ID,
      'identity_bound',
      'notification-retry-006',
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_NOTIFICATION_NOT_RETRYABLE' },
    });
  });

  it.each([
    ['租户', { tenantId: 'tenant-002' }],
    ['通知标识', { notificationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y5' }],
    ['状态', { status: 'dead' }],
    ['尝试次数', { attempts: 1 }],
    ['重试上限', { operatorRetryCount: 101 }],
    ['租约', { lockedBy: 'worker-001' }],
    ['平台标识', { externalMessageId: 'message-001' }],
    ['时间不一致', { updatedAt: new Date('2026-07-21T01:00:01.000Z') }],
    ['额外字段', { accessToken: 'forbidden' }],
  ])('重试后投影受损时失败关闭：%s', async (_label, overrides) => {
    const findOneAndUpdate = vi.fn().mockReturnValue(query(retryRecord(overrides)));
    await expect(service({ findOneAndUpdate }).retry(
      NOTIFICATION_ID,
      'provider_recovered',
      'notification-retry-007',
    )).rejects.toThrow('APPROVAL_NOTIFICATION_STATE_INVALID');
  });

  it('对账视图按可信租户聚合双平台四态并严格绑定最老积压', async () => {
    const countDocuments = vi.fn().mockResolvedValue(3);
    const oldestQuery = query({
      tenantId: TENANT_ID,
      status: 'processing',
      createdAt: new Date('2026-07-21T00:00:00.000Z'),
    });
    const findOne = vi.fn().mockReturnValue(oldestQuery);
    const result = await service({ countDocuments, findOne }).reconciliation();

    expect(countDocuments).toHaveBeenCalledTimes(8);
    expect(countDocuments.mock.calls.every((call) =>
      (call[0] as { tenantId?: string }).tenantId === TENANT_ID,
    )).toBe(true);
    expect(findOne).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      status: { $in: ['pending', 'processing'] },
    }, {
      tenantId: 1,
      status: 1,
      createdAt: 1,
      _id: 0,
    });
    expect(oldestQuery.sort).toHaveBeenCalledWith({ createdAt: 1 });
    expect(result).toEqual({
      counts: {
        dingtalk: { pending: 3, processing: 3, sent: 3, dead: 3 },
        feishu: { pending: 3, processing: 3, sent: 3, dead: 3 },
      },
      oldestPendingAt: '2026-07-21T00:00:00.000Z',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.counts)).toBe(true);
    expect(Object.isFrozen(result.counts.dingtalk)).toBe(true);
  });

  it('没有积压时对账返回 null 时间且仍固定全部状态桶', async () => {
    const countDocuments = vi.fn().mockResolvedValue(0);
    const findOne = vi.fn().mockReturnValue(query(null));
    await expect(service({ countDocuments, findOne }).reconciliation()).resolves.toEqual({
      counts: {
        dingtalk: { pending: 0, processing: 0, sent: 0, dead: 0 },
        feishu: { pending: 0, processing: 0, sent: 0, dead: 0 },
      },
      oldestPendingAt: null,
    });
  });

  it.each([
    ['负数计数', -1, null],
    ['非整数计数', 1.5, null],
    ['跨租户最老记录', 0, {
      tenantId: 'tenant-002',
      status: 'pending',
      createdAt: NOW,
    }],
    ['非法状态最老记录', 0, {
      tenantId: TENANT_ID,
      status: 'dead',
      createdAt: NOW,
    }],
    ['额外字段最老记录', 0, {
      tenantId: TENANT_ID,
      status: 'pending',
      createdAt: NOW,
      accessToken: 'forbidden',
    }],
  ])('对账持久化投影受损时失败关闭：%s', async (_label, count, oldest) => {
    const countDocuments = vi.fn().mockResolvedValue(count);
    const findOne = vi.fn().mockReturnValue(query(oldest));
    await expect(service({ countDocuments, findOne }).reconciliation())
      .rejects.toThrow('APPROVAL_NOTIFICATION_STATE_INVALID');
  });
});
