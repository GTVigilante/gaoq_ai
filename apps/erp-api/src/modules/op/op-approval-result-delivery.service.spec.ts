import { createHash, createHmac } from 'node:crypto';

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import {
  OpApprovalDeliveryError,
} from './op-approval-http.client.js';
import {
  OpApprovalOutboundSecretResolver,
  OpApprovalResultDeliveryService,
} from './op-approval-result-delivery.service.js';
import type {
  OpApprovalResultDeliveryDocument,
  OpApprovalRouteDocument,
} from './persistence/op.schemas.js';

const EVENT_ID = '01K00000000000000000000003';
const INSTANCE_ID = '01K00000000000000000000002';
const SECRET_REF = 'GAOQ_OP_APPROVAL_OUTBOUND_TEST';
const SECRET = 'test-only-op-approval-outbound-secret-32-bytes';

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function deliveryFixture(overrides: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID,
    tenantId: 'tenant-001',
    clientId: 'op-client-001',
    externalEventId: 'approval-event-001',
    sourceDocumentType: 'purchase_order',
    sourceDocumentId: 'po-001',
    approvalInstanceId: INSTANCE_ID,
    approvalVersion: 3,
    result: 'approved' as const,
    occurredAt: new Date('2026-07-22T08:00:00.000Z'),
    status: 'processing' as const,
    attempts: 0,
    operatorRetryCount: 0,
    nextAttemptAt: new Date('2026-07-22T08:00:00.000Z'),
    lockedAt: new Date('2026-07-22T08:00:00.000Z'),
    lockedBy: 'worker-001',
    lastErrorCode: null,
    succeededAt: null,
    ...overrides,
  };
}

function responseFixture(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    requestId: 'request-001',
    body: {
      code: 'OK',
      data: {
        externalEventId: 'approval-event-001',
        approvalInstanceId: INSTANCE_ID,
        approvalVersion: 3,
      },
    },
    ...overrides,
  };
}

function fixture(input: {
  readonly delivery?: ReturnType<typeof deliveryFixture> | null;
  readonly route?: Record<string, unknown> | null;
  readonly httpResult?: unknown;
  readonly updateCounts?: readonly number[];
  readonly auditError?: Error;
  readonly secrets?: OpApprovalOutboundSecretResolver;
} = {}) {
  const delivery = input.delivery === undefined ? deliveryFixture() : input.delivery;
  const route = input.route === undefined
    ? {
        externalTenantId: 'op-tenant-001',
        outboundClientId: 'erp-client-001',
        outboundCredentialSecretRef: SECRET_REF,
      }
    : input.route;
  const updates = [...(input.updateCounts ?? [1])];
  const deliveries = {
    findOneAndUpdate: vi.fn().mockReturnValue(query(delivery)),
    updateOne: vi.fn().mockImplementation(() => Promise.resolve({
      modifiedCount: updates.shift() ?? 1,
    })),
  };
  const routes = { findOne: vi.fn().mockReturnValue(query(route)) };
  const http = { put: vi.fn() };
  const httpResult = input.httpResult === undefined ? responseFixture() : input.httpResult;
  if (httpResult instanceof Error) http.put.mockRejectedValue(httpResult);
  else http.put.mockResolvedValue(httpResult);
  const audit = {
    recordSystem: input.auditError === undefined
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(input.auditError),
  };
  const service = new OpApprovalResultDeliveryService(
    deliveries as unknown as Model<OpApprovalResultDeliveryDocument>,
    routes as unknown as Model<OpApprovalRouteDocument>,
    input.secrets ?? new OpApprovalOutboundSecretResolver(),
    http,
    audit as unknown as AuditService,
  );
  return { service, delivery, route, deliveries, routes, http, audit };
}

function lastUpdate(store: ReturnType<typeof fixture>) {
  return store.deliveries.updateOne.mock.calls.at(-1)?.[1] as {
    readonly $set: Record<string, unknown>;
  };
}

describe('OpApprovalOutboundSecretResolver', () => {
  beforeEach(() => { process.env[SECRET_REF] = SECRET; });
  afterEach(() => { delete process.env[SECRET_REF]; });

  it('只解析专用命名空间且长度合规的 Secret', () => {
    expect(new OpApprovalOutboundSecretResolver().resolve(SECRET_REF)).toBe(SECRET);
  });

  it.each([
    'GAOQ_OP_WEBHOOK_TEST',
    'GAOQ_OP_APPROVAL_OUTBOUND_lowercase',
    'GAOQ_OP_APPROVAL_OUTBOUND_',
  ])('拒绝非法 Secret 引用 %s', (reference) => {
    expect(() => new OpApprovalOutboundSecretResolver().resolve(reference))
      .toThrow('OP_APPROVAL_SECRET_REF_INVALID');
  });

  it.each([
    ['缺失', undefined],
    ['过短', 'x'.repeat(31)],
    ['过长', 'x'.repeat(2_049)],
  ])('%s Secret 时失败关闭', (_name, secret) => {
    if (secret === undefined) delete process.env[SECRET_REF];
    else process.env[SECRET_REF] = secret;
    expect(() => new OpApprovalOutboundSecretResolver().resolve(SECRET_REF))
      .toThrow(ServiceUnavailableException);
  });
});

describe('OpApprovalResultDeliveryService', () => {
  let loggerError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env[SECRET_REF] = SECRET;
    loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env[SECRET_REF];
    vi.restoreAllMocks();
  });

  it.each([
    ['', 1],
    ['worker with space', 1],
    ['worker-001', 0],
    ['worker-001', 101],
    ['worker-001', 1.5],
  ])('拒绝非法 Worker 或批量参数 %#', async (workerId, limit) => {
    const store = fixture();
    await expect(store.service.processBatch(workerId, limit))
      .rejects.toThrow('OP 审批结果投递参数非法');
    expect(store.deliveries.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('没有可投递记录时直接返回', async () => {
    const store = fixture({ delivery: null });
    await expect(store.service.processBatch('worker-001')).resolves.toBe(0);
    expect(store.routes.findOne).not.toHaveBeenCalled();
    expect(store.http.put).not.toHaveBeenCalled();
  });

  it('按过期租约条件认领并用独立凭据和固定 canonical HMAC 回推最小终态', async () => {
    const store = fixture();
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(1);

    const claimFilter = store.deliveries.findOneAndUpdate.mock.calls[0]?.[0] as {
      readonly $or: readonly [
        { readonly status: string },
        { readonly status: string; readonly lockedAt: { readonly $lt: Date } },
      ];
    };
    expect(claimFilter).toMatchObject({
      $or: [
        { status: 'pending' },
        { status: 'processing' },
      ],
    });
    expect(claimFilter.$or[1].lockedAt.$lt).toBeInstanceOf(Date);
    expect(store.routes.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      inboundClientId: 'op-client-001',
      sourceDocumentType: 'purchase_order',
      status: 'active',
    });
    const request = store.http.put.mock.calls[0]?.[0] as {
      readonly path: string;
      readonly body: string;
      readonly headers: Record<string, string>;
    };
    expect(request.path).toBe('/erp/v1/approval-results/approval-event-001');
    expect(request.body).not.toMatch(/formData|approver|comment/iu);
    expect(JSON.parse(request.body)).toEqual({
      schemaVersion: '1.0',
      externalEventId: 'approval-event-001',
      sourceDocumentType: 'purchase_order',
      sourceDocumentId: 'po-001',
      approvalInstanceId: INSTANCE_ID,
      approvalVersion: 3,
      result: 'approved',
      occurredAt: '2026-07-22T08:00:00.000Z',
    });
    const canonical = [
      request.headers['x-gaoq-erp-timestamp'],
      request.headers['x-gaoq-erp-nonce'],
      'PUT',
      request.path,
      'op-tenant-001',
      EVENT_ID,
      createHash('sha256').update(request.body).digest('base64url'),
    ].join('\n');
    expect(request.headers['x-gaoq-erp-signature']).toBe(
      createHmac('sha256', SECRET).update(canonical).digest('hex'),
    );
    expect(store.deliveries.updateOne.mock.calls[0]?.[0]).toEqual({
      eventId: EVENT_ID,
      status: 'processing',
      lockedBy: 'worker-001',
    });
    expect(lastUpdate(store).$set).toMatchObject({
      status: 'succeeded',
      lastErrorCode: null,
    });
    expect(lastUpdate(store).$set.updatedAt).toEqual(lastUpdate(store).$set.succeededAt);
    expect(store.audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({
        outcome: 'success',
        traceId: EVENT_ID,
        metadata: {
          result: 'approved',
          approvalVersion: 3,
          sourceDocumentType: 'purchase_order',
        },
      }),
    );
  });

  it('成功终态后的审计故障只记录稳定告警且不重复外呼', async () => {
    const store = fixture({ auditError: new Error('AUDIT_UNAVAILABLE') });
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(1);
    expect(store.http.put).toHaveBeenCalledOnce();
    expect(store.deliveries.updateOne).toHaveBeenCalledOnce();
    expect(lastUpdate(store).$set).toMatchObject({ status: 'succeeded' });
    expect(loggerError).toHaveBeenCalledWith({
      code: 'OP_APPROVAL_RESULT_AUDIT_AFTER_COMMIT_FAILED',
      outcome: 'success',
    });
  });

  it('路由停用时进入人工复核且不解析凭据或外呼', async () => {
    const store = fixture({ route: null });
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.http.put).not.toHaveBeenCalled();
    expect(lastUpdate(store).$set).toMatchObject({
      status: 'manual_review',
      attempts: 1,
      lastErrorCode: 'OP_APPROVAL_ROUTE_DISABLED',
    });
    expect(lastUpdate(store).$set.updatedAt).toEqual(lastUpdate(store).$set.nextAttemptAt);
    expect(store.audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({
        outcome: 'failure',
        metadata: { failureCode: 'OP_APPROVAL_ROUTE_DISABLED' },
      }),
    );
  });

  it.each([
    ['响应结构', { body: { code: 'NOT_OK' } }],
    ['外部事件', {
      body: {
        code: 'OK',
        data: {
          externalEventId: 'approval-event-other',
          approvalInstanceId: INSTANCE_ID,
          approvalVersion: 3,
        },
      },
    }],
    ['审批实例', {
      body: {
        code: 'OK',
        data: {
          externalEventId: 'approval-event-001',
          approvalInstanceId: '01K00000000000000000000009',
          approvalVersion: 3,
        },
      },
    }],
    ['审批版本', {
      body: {
        code: 'OK',
        data: {
          externalEventId: 'approval-event-001',
          approvalInstanceId: INSTANCE_ID,
          approvalVersion: 4,
        },
      },
    }],
  ])('%s 不匹配时按可重试失败处理', async (_name, overrides) => {
    const store = fixture({ httpResult: responseFixture(overrides) });
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastUpdate(store).$set).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'OP_APPROVAL_RESPONSE_INVALID',
    });
    expect(lastUpdate(store).$set.nextAttemptAt).toBeInstanceOf(Date);
  });

  it.each([
    ['业务错误', 'business', 'manual_review'],
    ['版本冲突', 'conflict', 'manual_review'],
    ['瞬时错误', 'retryable', 'pending'],
  ] as const)('%s 进入对应持久化状态', async (_name, category, status) => {
    const store = fixture({
      httpResult: new OpApprovalDeliveryError(
        'OP_APPROVAL_HTTP_409',
        category,
        '外部失败',
        409,
      ),
    });
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastUpdate(store).$set).toMatchObject({
      status,
      attempts: 1,
      lastErrorCode: 'OP_APPROVAL_HTTP_409',
    });
  });

  it('第六次瞬时失败进入 dead 终态', async () => {
    const store = fixture({
      delivery: deliveryFixture({ attempts: 5 }),
      httpResult: new OpApprovalDeliveryError(
        'OP_APPROVAL_NETWORK_ERROR',
        'retryable',
        '网络失败',
      ),
    });
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastUpdate(store).$set).toMatchObject({
      status: 'dead',
      attempts: 6,
      lastErrorCode: 'OP_APPROVAL_NETWORK_ERROR',
    });
  });

  it('缺失出站 Secret 时持久化固定可重试错误码', async () => {
    delete process.env[SECRET_REF];
    const store = fixture();
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastUpdate(store).$set).toMatchObject({
      status: 'pending',
      lastErrorCode: 'OP_APPROVAL_OUTBOUND_SECRET_UNAVAILABLE',
    });
  });

  it('非法出站 Secret 引用作为业务错误进入人工复核', async () => {
    const store = fixture({
      route: {
        externalTenantId: 'op-tenant-001',
        outboundClientId: 'erp-client-001',
        outboundCredentialSecretRef: 'GAOQ_OP_WEBHOOK_TEST',
      },
    });
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(store.http.put).not.toHaveBeenCalled();
    expect(lastUpdate(store).$set).toMatchObject({
      status: 'manual_review',
      attempts: 1,
      lastErrorCode: 'OP_APPROVAL_SECRET_REF_INVALID',
    });
  });

  it.each([
    ['非法连接器错误码', new OpApprovalDeliveryError(
      'OP:FREE TEXT',
      'business',
      '不可信错误',
    )],
    ['普通异常', new Error('包含不应落库的上游正文')],
  ])('%s 收敛为固定领域错误码', async (_name, error) => {
    const store = fixture({ httpResult: error });
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastUpdate(store).$set).toMatchObject({
      lastErrorCode: 'OP_APPROVAL_DELIVERY_UNEXPECTED',
    });
    expect(JSON.stringify(store.deliveries.updateOne.mock.calls))
      .not.toContain(error.message);
  });

  it('非法 ServiceUnavailable code 不进入持久化或审计', async () => {
    const secrets = {
      resolve: vi.fn(() => {
        throw new ServiceUnavailableException({
          code: 'free text from upstream',
          message: '敏感上游错误',
        });
      }),
    } as unknown as OpApprovalOutboundSecretResolver;
    const store = fixture({ secrets });
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastUpdate(store).$set).toMatchObject({
      lastErrorCode: 'OP_APPROVAL_DELIVERY_UNEXPECTED',
    });
  });

  it('失败终态后的审计故障不掩盖持久化结果或中断批次', async () => {
    const store = fixture({
      route: null,
      auditError: new Error('AUDIT_UNAVAILABLE'),
    });
    await expect(store.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(lastUpdate(store).$set).toMatchObject({ status: 'manual_review' });
    expect(loggerError).toHaveBeenCalledWith({
      code: 'OP_APPROVAL_RESULT_AUDIT_AFTER_COMMIT_FAILED',
      outcome: 'failure',
    });
  });

  it('成功外呼后的持久化租约丢失必须显式失败且禁止回写投递失败', async () => {
    const store = fixture({ updateCounts: [0] });
    await expect(store.service.processBatch('worker-001', 1))
      .rejects.toThrow('OP_APPROVAL_DELIVERY_LEASE_LOST');
    expect(store.http.put).toHaveBeenCalledOnce();
    expect(store.deliveries.updateOne).toHaveBeenCalledOnce();
    expect(lastUpdate(store).$set.status).toBe('succeeded');
    expect(store.audit.recordSystem).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith({
      code: 'OP_APPROVAL_RESULT_LOCAL_FINALIZE_FAILED',
      eventId: EVENT_ID,
    });
  });

  it('失败终态持久化时丢失租约必须显式失败', async () => {
    const store = fixture({ route: null, updateCounts: [0] });
    await expect(store.service.processBatch('worker-001', 1))
      .rejects.toThrow('OP_APPROVAL_DELIVERY_LEASE_LOST');
    expect(store.audit.recordSystem).not.toHaveBeenCalled();
  });
});
