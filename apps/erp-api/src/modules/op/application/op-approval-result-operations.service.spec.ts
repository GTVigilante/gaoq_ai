import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OpApprovalResultDeliveryDocument } from '../persistence/op.schemas.js';
import {
  OpApprovalResultOperationsService,
  type OpApprovalResultRetryReason,
} from './op-approval-result-operations.service.js';

const TENANT_ID = 'tenant-001';
const EVENT_ID = '01K00000000000000000000001';
const OLDER_EVENT_ID = '01J00000000000000000000001';
const NOW = new Date('2026-07-22T08:00:00Z');

function terminalRecord(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    externalEventId: 'approval-event-001',
    sourceDocumentType: 'purchase_order',
    sourceDocumentId: 'po-001',
    approvalInstanceId: '01K00000000000000000000002',
    approvalVersion: 3,
    result: 'approved',
    status: 'manual_review',
    attempts: 1,
    operatorRetryCount: 0,
    lastErrorCode: 'OP_APPROVAL_HTTP_409',
    updatedAt: NOW,
    ...overrides,
  };
}

function retriedRecord(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    status: 'pending',
    attempts: 0,
    operatorRetryCount: 1,
    nextAttemptAt: NOW,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    succeededAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function listQuery(value: unknown) {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockImplementation(() =>
            value instanceof Error ? Promise.reject(value) : Promise.resolve(value),
          ),
        }),
      }),
    }),
  };
}

function updateQuery(value: unknown) {
  return {
    lean: vi.fn().mockReturnValue({
      exec: vi.fn().mockImplementation(() =>
        value instanceof Error ? Promise.reject(value) : Promise.resolve(value),
      ),
    }),
  };
}

function context(scopes: readonly string[]): TenantContextService {
  return {
    getRequired: () => ({
      tenant: { tenantId: TENANT_ID },
      actor: { scopes },
    }),
  } as unknown as TenantContextService;
}

function idempotency(execute?: ReturnType<typeof vi.fn>): IdempotencyService {
  const implementation = execute ?? vi.fn().mockImplementation(async (
    _operation: string,
    _key: string,
    _request: unknown,
    handler: (session: ClientSession) => Promise<unknown>,
  ) => handler({} as ClientSession));
  return { execute: implementation } as unknown as IdempotencyService;
}

function createService(input: {
  readonly find?: ReturnType<typeof vi.fn>;
  readonly findOneAndUpdate?: ReturnType<typeof vi.fn>;
  readonly scopes: readonly string[];
  readonly execute?: ReturnType<typeof vi.fn>;
}) {
  return new OpApprovalResultOperationsService(
    {
      find: input.find,
      findOneAndUpdate: input.findOneAndUpdate,
    } as unknown as Model<OpApprovalResultDeliveryDocument>,
    context(input.scopes),
    idempotency(input.execute),
  );
}

describe('OpApprovalResultOperationsService', () => {
  it('异常投递查询强制租户、状态、游标和最小投影，并冻结分页响应', async () => {
    const find = vi.fn().mockReturnValue(listQuery([
      terminalRecord(),
      terminalRecord({
        eventId: OLDER_EVENT_ID,
        externalEventId: 'approval-event-002',
        sourceDocumentId: 'po-002',
      }),
    ]));
    const service = createService({
      find,
      scopes: ['erp:op:approval_result:read'],
    });

    const result = await service.listTerminal({
      status: 'manual_review',
      beforeEventId: '01KZZZZZZZZZZZZZZZZZZZZZZZ',
      limit: 1,
    });

    expect(result).toEqual({
      items: [{
        eventId: EVENT_ID,
        externalEventId: 'approval-event-001',
        sourceDocumentType: 'purchase_order',
        sourceDocumentId: 'po-001',
        approvalInstanceId: '01K00000000000000000000002',
        approvalVersion: 3,
        result: 'approved',
        status: 'manual_review',
        attempts: 1,
        operatorRetryCount: 0,
        lastErrorCode: 'OP_APPROVAL_HTTP_409',
        updatedAt: NOW.toISOString(),
      }],
      nextCursor: EVENT_ID,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    const [filter, projection] = find.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, number>,
    ];
    expect(filter).toEqual({
      tenantId: TENANT_ID,
      status: 'manual_review',
      eventId: { $lt: '01KZZZZZZZZZZZZZZZZZZZZZZZ' },
    });
    expect(projection).toMatchObject({ tenantId: 1, eventId: 1, updatedAt: 1, _id: 0 });
    expect(projection).not.toHaveProperty('body');
    expect(projection).not.toHaveProperty('outboundCredentialSecretRef');
  });

  it('末页返回空游标且不添加未提供的游标过滤', async () => {
    const find = vi.fn().mockReturnValue(listQuery([terminalRecord({ status: 'dead' })]));
    const service = createService({
      find,
      scopes: ['erp:op:approval_result:read'],
    });

    await expect(service.listTerminal({ status: 'dead', limit: 50 })).resolves.toMatchObject({
      nextCursor: null,
    });
    expect(find.mock.calls[0]?.[0]).toEqual({ tenantId: TENANT_ID, status: 'dead' });
  });

  it('应用层拒绝缺失读取 Scope，且不访问数据库', async () => {
    const find = vi.fn();
    const service = createService({ find, scopes: [] });

    await expect(service.listTerminal({ status: 'dead', limit: 50 })).rejects.toMatchObject({
      response: { code: 'OP_APPROVAL_RESULT_READ_SCOPE_REQUIRED' },
    });
    expect(find).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'processing', limit: 50 }, 'OP_APPROVAL_RESULT_STATUS_INVALID'],
    [{ status: 'dead', beforeEventId: 'bad', limit: 50 }, 'OP_APPROVAL_RESULT_EVENT_ID_INVALID'],
    [{ status: 'dead', limit: 0 }, 'OP_APPROVAL_RESULT_LIMIT_INVALID'],
    [{ status: 'dead', limit: 1.5 }, 'OP_APPROVAL_RESULT_LIMIT_INVALID'],
    [{ status: 'dead', limit: 101 }, 'OP_APPROVAL_RESULT_LIMIT_INVALID'],
  ])('应用层拒绝非法查询参数 %#', async (input, code) => {
    const find = vi.fn();
    const service = createService({
      find,
      scopes: ['erp:op:approval_result:read'],
    });

    await expect(service.listTerminal(
      input as Parameters<OpApprovalResultOperationsService['listTerminal']>[0],
    )).rejects.toMatchObject({ response: { code } });
    expect(find).not.toHaveBeenCalled();
  });

  it.each([
    ['跨租户记录', { tenantId: 'tenant-002' }],
    ['状态不匹配', { status: 'dead' }],
    ['字段越界', { approvalVersion: 2 }],
    ['终态无错误码', { lastErrorCode: null }],
    ['未来更新时间', { updatedAt: new Date('2999-01-01T00:00:00Z') }],
    ['多余持久化字段', { body: 'secret' }],
  ])('读取持久化状态异常时失败关闭：%s', async (_label, overrides) => {
    const service = createService({
      find: vi.fn().mockReturnValue(listQuery([terminalRecord(overrides)])),
      scopes: ['erp:op:approval_result:read'],
    });

    await expect(service.listTerminal({ status: 'manual_review', limit: 50 }))
      .rejects.toThrow('OP_APPROVAL_RESULT_STATE_INVALID');
  });

  it('透传数据库读取异常', async () => {
    const service = createService({
      find: vi.fn().mockReturnValue(listQuery(new Error('mongo unavailable'))),
      scopes: ['erp:op:approval_result:read'],
    });

    await expect(service.listTerminal({ status: 'dead', limit: 50 }))
      .rejects.toThrow('mongo unavailable');
  });

  it.each([
    ['provider_recovered', {
      status: 'dead',
      lastErrorCode: {
        $nin: [
          'OP_APPROVAL_SECRET_REF_INVALID',
          'OP_APPROVAL_OUTBOUND_SECRET_UNAVAILABLE',
        ],
      },
    }],
    ['approved_exception', { status: 'manual_review' }],
    ['credentials_fixed', {
      status: { $in: ['manual_review', 'dead'] },
      lastErrorCode: {
        $in: [
          'OP_APPROVAL_SECRET_REF_INVALID',
          'OP_APPROVAL_OUTBOUND_SECRET_UNAVAILABLE',
        ],
      },
    }],
    ['route_fixed', {
      status: 'manual_review',
      lastErrorCode: {
        $in: [
          'OP_APPROVAL_ROUTE_DISABLED',
          'OP_APPROVAL_BASE_URL_INVALID',
          'OP_APPROVAL_TARGET_INVALID',
          'OP_APPROVAL_PATH_INVALID',
        ],
      },
    }],
  ] satisfies readonly [OpApprovalResultRetryReason, Record<string, unknown>][])(
    '人工重试原因 %s 只匹配对应失败类别',
    async (reason, eligibility) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      try {
        const findOneAndUpdate = vi.fn().mockReturnValue(updateQuery(retriedRecord()));
        const execute = vi.fn().mockImplementation(async (
          _operation: string,
          _key: string,
          _request: unknown,
          handler: (session: ClientSession) => Promise<unknown>,
        ) => handler({} as ClientSession));
        const service = createService({
          findOneAndUpdate,
          execute,
          scopes: ['erp:op:approval_result:operate'],
        });

        const result = await service.retry(EVENT_ID, reason, 'retry-key-0001');

        expect(result).toEqual({
          delivery: { eventId: EVENT_ID, status: 'pending', reason },
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.delivery)).toBe(true);
        expect(execute).toHaveBeenCalledWith(
          'op.approval_result.retry',
          'retry-key-0001',
          { eventId: EVENT_ID, reason },
          expect.any(Function),
        );
        const [filter, update, options] = findOneAndUpdate.mock.calls[0] as [
          Record<string, unknown>,
          { $set: Record<string, unknown>; $inc: Record<string, number> },
          Record<string, unknown>,
        ];
        expect(filter).toEqual({
          tenantId: TENANT_ID,
          eventId: EVENT_ID,
          operatorRetryCount: { $lt: 100 },
          ...eligibility,
        });
        expect(update.$set).toMatchObject({
          status: 'pending',
          attempts: 0,
          nextAttemptAt: NOW,
          updatedAt: NOW,
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: null,
          succeededAt: null,
        });
        expect(update.$inc).toEqual({ operatorRetryCount: 1 });
        expect(options).toMatchObject({
          returnDocument: 'after',
          timestamps: false,
          runValidators: true,
          projection: { tenantId: 1, eventId: 1, status: 1, _id: 0 },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('应用层拒绝缺失运维 Scope，且不启动幂等事务', async () => {
    const execute = vi.fn();
    const service = createService({ scopes: [], execute });

    await expect(service.retry(EVENT_ID, 'route_fixed', 'retry-key-0001'))
      .rejects.toMatchObject({
        response: { code: 'OP_APPROVAL_RESULT_OPERATE_SCOPE_REQUIRED' },
      });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['bad', 'route_fixed', 'retry-key-0001', 'OP_APPROVAL_RESULT_EVENT_ID_INVALID'],
    [EVENT_ID, 'manual', 'retry-key-0001', 'OP_APPROVAL_RESULT_REASON_INVALID'],
    [EVENT_ID, 'route_fixed', 'short', 'IDEMPOTENCY_KEY_REQUIRED'],
  ])(
    '应用层拒绝非法人工重试参数 %#',
    async (eventId, reason, key, code) => {
      const execute = vi.fn();
      const service = createService({
        scopes: ['erp:op:approval_result:operate'],
        execute,
      });

      await expect(service.retry(
        eventId,
        reason as OpApprovalResultRetryReason,
        key,
      )).rejects.toMatchObject({ response: { code } });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('记录不存在或原因与失败类别不匹配时拒绝重试', async () => {
    const service = createService({
      findOneAndUpdate: vi.fn().mockReturnValue(updateQuery(null)),
      scopes: ['erp:op:approval_result:operate'],
    });

    await expect(service.retry(EVENT_ID, 'route_fixed', 'retry-key-0001'))
      .rejects.toMatchObject({
        response: { code: 'OP_APPROVAL_RESULT_NOT_RETRYABLE' },
      });
  });

  it.each([
    ['跨租户', { tenantId: 'tenant-002' }],
    ['事件错绑', { eventId: OLDER_EVENT_ID }],
    ['状态未复位', { status: 'manual_review' }],
    ['计数未复位', { attempts: 1 }],
    ['锁未释放', { lockedBy: 'worker-1' }],
    ['错误码未清理', { lastErrorCode: 'OP_APPROVAL_ROUTE_DISABLED' }],
    ['执行时间不一致', { nextAttemptAt: new Date('2026-07-22T08:00:01Z') }],
    ['多余字段', { outboundCredentialSecretRef: 'secret-ref' }],
  ])('重试后的持久化状态异常时失败关闭：%s', async (_label, overrides) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const service = createService({
        findOneAndUpdate: vi.fn().mockReturnValue(updateQuery(retriedRecord(overrides))),
        scopes: ['erp:op:approval_result:operate'],
      });

      await expect(service.retry(EVENT_ID, 'route_fixed', 'retry-key-0001'))
        .rejects.toThrow('OP_APPROVAL_RESULT_STATE_INVALID');
    } finally {
      vi.useRealTimers();
    }
  });

  it('透传幂等事务异常且不访问投递集合', async () => {
    const findOneAndUpdate = vi.fn();
    const execute = vi.fn().mockRejectedValue(new Error('idempotency unavailable'));
    const service = createService({
      findOneAndUpdate,
      execute,
      scopes: ['erp:op:approval_result:operate'],
    });

    await expect(service.retry(EVENT_ID, 'route_fixed', 'retry-key-0001'))
      .rejects.toThrow('idempotency unavailable');
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
