import { createHash } from 'node:crypto';

import {
  BadRequestException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Model } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../approval/application/approval-application.service.js';
import { hashOpApprovalPayload } from './op-approval.contract.js';
import { OpApprovalRequestService } from './op-approval-request.service.js';
import type { OpApprovalWebhookCryptoService } from './op-approval-webhook-crypto.service.js';
import type {
  OpApprovalBridgeDocument,
  OpApprovalRequestInboxDocument,
  OpApprovalRouteDocument,
} from './persistence/op.schemas.js';

const INBOX_ID = '01K00000000000000000000001';
const OTHER_ID = '01K00000000000000000000002';
const OCCURRED_AT = '2026-07-22T08:00:00.000Z';
const DEFAULT_RAW = Buffer.from(JSON.stringify({
  schemaVersion: '1.0',
  type: 'approval.requested',
  occurredAt: OCCURRED_AT,
  data: {
    sourceDocumentType: 'purchase_order',
    sourceDocumentId: 'po-001',
    initiatorEmployeeId: 'employee-001',
    title: '采购审批',
    formData: { amount: 12_345 },
  },
}));

type Claimed = {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly externalEventId: string;
  readonly payloadHash: string;
  readonly providerOccurredAt: Date;
  readonly receivedAt: Date;
};

type Bridge = Claimed & {
  readonly templateCode: string;
  readonly approvalInstanceId: string;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
};

type ApprovalInstance = {
  readonly id: string;
  readonly status: 'draft' | 'running' | 'approved' | 'rejected' | 'withdrawn' | 'archived';
  readonly version: number;
  readonly completedAt: string | null;
};

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function defaultClaim(raw: Buffer = DEFAULT_RAW): Claimed {
  return {
    id: INBOX_ID,
    tenantId: 'tenant-001',
    clientId: 'op-client-001',
    externalEventId: 'approval-event-001',
    payloadHash: hashOpApprovalPayload(raw),
    providerOccurredAt: new Date(OCCURRED_AT),
    receivedAt: new Date(OCCURRED_AT),
  };
}

function defaultBridge(claimed: Claimed): Bridge {
  return {
    ...claimed,
    templateCode: 'PURCHASE_ORDER',
    approvalInstanceId: claimed.id,
    sourceDocumentType: 'purchase_order',
    sourceDocumentId: 'po-001',
  };
}

function defaultInstance(): ApprovalInstance {
  return {
    id: INBOX_ID,
    status: 'running',
    version: 2,
    completedAt: null,
  };
}

function harness(options: {
  readonly raw?: Buffer;
  readonly claimed?: Claimed | null;
  readonly route?: { readonly templateCode: string } | null;
  readonly reserveBridge?: Bridge | null;
  readonly finalBridge?: Bridge | null;
  readonly instance?: ApprovalInstance;
} = {}) {
  const raw = options.raw ?? DEFAULT_RAW;
  const claimed = options.claimed === undefined ? defaultClaim(raw) : options.claimed;
  const bridgeBase = defaultBridge(claimed ?? defaultClaim(raw));
  const reserveBridge = options.reserveBridge === undefined ? bridgeBase : options.reserveBridge;
  const finalBridge = options.finalBridge === undefined ? bridgeBase : options.finalBridge;
  const inbox = {
    findOneAndUpdate: vi.fn().mockReturnValue(query(claimed)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const routes = {
    findOne: vi.fn().mockReturnValue(query(
      options.route === undefined ? { templateCode: 'PURCHASE_ORDER' } : options.route,
    )),
  };
  const bridges = {
    updateOne: vi.fn()
      .mockResolvedValueOnce({ upsertedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 1 }),
    findOne: vi.fn()
      .mockReturnValueOnce(query(reserveBridge))
      .mockReturnValueOnce(query(finalBridge)),
  };
  const crypto = { unprotect: vi.fn().mockReturnValue(raw) };
  const approvals = {
    createAndSubmitFromOp: vi.fn().mockResolvedValue({
      instance: options.instance ?? defaultInstance(),
    }),
  };
  const audit = { recordSystem: vi.fn().mockResolvedValue(undefined) };
  const context = new TenantContextService();
  const service = new OpApprovalRequestService(
    inbox as unknown as Model<OpApprovalRequestInboxDocument>,
    routes as unknown as Model<OpApprovalRouteDocument>,
    bridges as unknown as Model<OpApprovalBridgeDocument>,
    crypto as unknown as OpApprovalWebhookCryptoService,
    approvals as unknown as ApprovalApplicationService,
    context,
    audit as unknown as AuditService,
  );
  return {
    service,
    inbox,
    routes,
    bridges,
    crypto,
    approvals,
    audit,
    context,
    claimed,
  };
}

function failureStatus(
  inbox: ReturnType<typeof harness>['inbox'],
): { readonly status: string; readonly failureCode: string | null; readonly processedAt: Date | null } {
  const call = inbox.updateOne.mock.calls.at(-1) as unknown as readonly [
    Readonly<Record<string, unknown>>,
    {
      readonly $set: {
        readonly status: string;
        readonly failureCode: string | null;
        readonly processedAt: Date | null;
      };
    },
  ] | undefined;
  expect(call).toBeDefined();
  if (call === undefined) throw new Error('测试预期 Inbox 已形成终态');
  return call[1].$set;
}

describe('OpApprovalRequestService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('拒绝非法任务参数，且不读取任何租户 Inbox', async () => {
    const testHarness = harness();

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
      tenantOverride: 'tenant-evil',
    })).rejects.toMatchObject({ name: 'ZodError' });
    expect(testHarness.inbox.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('没有可认领 Inbox 时幂等跳过', async () => {
    const testHarness = harness({ claimed: null });

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(0);
    expect(testHarness.crypto.unprotect).not.toHaveBeenCalled();
    expect(testHarness.approvals.createAndSubmitFromOp).not.toHaveBeenCalled();
  });

  it('解密并校验 Inbox 后，在可信 Worker 上下文复用审批应用服务并建立桥接', async () => {
    const testHarness = harness();
    testHarness.approvals.createAndSubmitFromOp.mockImplementation(() => {
      expect(testHarness.context.getRequired()).toEqual({
        tenant: { tenantId: 'tenant-001', source: 'service_identity' },
        actor: {
          actorType: 'system_job',
          actorId: 'system:op-approval-bridge',
          tenantId: 'tenant-001',
          roleCodes: ['INTEGRATION_WORKER'],
          scopes: ['erp:approval:op:ingest'],
          departmentIds: [],
          traceId: INBOX_ID,
        },
      });
      return Promise.resolve({ instance: defaultInstance() });
    });

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(1);

    expect(testHarness.inbox.findOneAndUpdate).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      id: INBOX_ID,
      $or: [
        { status: { $in: ['pending', 'failed'] } },
        {
          status: 'processing',
          processingStartedAt: { $lt: expect.any(Date) as Date },
        },
      ],
    }, {
      $set: {
        status: 'processing',
        processingStartedAt: expect.any(Date) as Date,
        failureCode: null,
      },
      $inc: { attempts: 1 },
    }, { returnDocument: 'after', runValidators: true });
    const expectedKey = `opapp:${createHash('sha256')
      .update(JSON.stringify(['tenant-001', 'op-client-001', 'approval-event-001']), 'utf8')
      .digest('base64url')}`;
    expect(testHarness.approvals.createAndSubmitFromOp).toHaveBeenCalledWith(
      expectedKey,
      {
        instanceId: INBOX_ID,
        templateCode: 'PURCHASE_ORDER',
        title: '采购审批',
        formData: { amount: 12_345 },
        initiatorEmployeeId: 'employee-001',
        sourceDocumentType: 'purchase_order',
        sourceDocumentId: 'po-001',
      },
    );
    expect(testHarness.bridges.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $setOnInsert: {
        approvalInstanceId: INBOX_ID,
        approvalStatus: 'processing',
        approvalVersion: 0,
      },
    });
    expect(testHarness.bridges.updateOne.mock.calls[1]?.[1]).toMatchObject({
      $set: {
        approvalStatus: 'running',
        approvalVersion: 2,
        completedAt: null,
      },
    });
    expect(failureStatus(testHarness.inbox)).toMatchObject({
      status: 'completed',
      failureCode: null,
      processedAt: expect.any(Date) as Date,
    });
    expect(testHarness.audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001',
      expect.objectContaining({
        action: 'op.approval.create_submit',
        resourceType: 'approval_instance',
        resourceId: INBOX_ID,
        outcome: 'success',
        traceId: INBOX_ID,
      }),
    );
  });

  it('完成终态后的成功审计失败只记录稳定错误，不释放完成 Inbox', async () => {
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const testHarness = harness();
    testHarness.audit.recordSystem.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(1);

    expect(testHarness.inbox.updateOne).toHaveBeenCalledTimes(1);
    expect(failureStatus(testHarness.inbox).status).toBe('completed');
    expect(logger).toHaveBeenCalledWith({
      code: 'OP_APPROVAL_REQUEST_AUDIT_AFTER_COMMIT_FAILED',
      outcome: 'success',
    });
  });

  it.each([
    ['载荷摘要错配', (claim: Claimed) => ({ ...claim, payloadHash: 'A'.repeat(43) }),
      'OP_APPROVAL_PAYLOAD_HASH_MISMATCH'],
    ['事件时间错配', (claim: Claimed) => ({
      ...claim,
      providerOccurredAt: new Date('2026-07-22T08:00:01.000Z'),
    }), 'OP_APPROVAL_ENVELOPE_TIME_MISMATCH'],
  ])('%s时持久化稳定失败终态且不创建审批', async (_label, changeClaim, code) => {
    const claimed = changeClaim(defaultClaim());
    const testHarness = harness({ claimed });

    await expect(testHarness.service.process({
      tenantId: claimed.tenantId,
      inboxId: claimed.id,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox)).toMatchObject({
      status: 'failed',
      failureCode: code,
      processedAt: null,
    });
    expect(testHarness.approvals.createAndSubmitFromOp).not.toHaveBeenCalled();
  });

  it.each([
    ['非法 JSON', Buffer.from('{'), 'OP_APPROVAL_BODY_INVALID'],
    ['非法固定契约', Buffer.from(JSON.stringify({
      schemaVersion: '1.0',
      type: 'approval.requested',
      occurredAt: OCCURRED_AT,
      data: {},
    })), 'OP_APPROVAL_BODY_INVALID'],
  ])('%s作为永久错误消费并形成失败终态', async (_label, raw, code) => {
    const testHarness = harness({ raw });

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox).failureCode).toBe(code);
  });

  it('路由被停用后失败关闭且不触发审批副作用', async () => {
    const testHarness = harness({ route: null });

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox).failureCode).toBe('OP_APPROVAL_ROUTE_DISABLED');
    expect(testHarness.approvals.createAndSubmitFromOp).not.toHaveBeenCalled();
  });

  it.each([
    ['不存在', () => null],
    ['载荷摘要错配', (bridge: Bridge) => ({ ...bridge, payloadHash: 'B'.repeat(43) })],
    ['审批实例错配', (bridge: Bridge) => ({ ...bridge, approvalInstanceId: OTHER_ID })],
    ['模板错配', (bridge: Bridge) => ({ ...bridge, templateCode: 'OTHER' })],
    ['来源类型错配', (bridge: Bridge) => ({ ...bridge, sourceDocumentType: 'expense' })],
    ['来源标识错配', (bridge: Bridge) => ({ ...bridge, sourceDocumentId: 'po-002' })],
  ])('预占桥接%s时拒绝创建第二个审批', async (_label, mutate) => {
    const claimed = defaultClaim();
    const testHarness = harness({ reserveBridge: mutate(defaultBridge(claimed)) });

    await expect(testHarness.service.process({
      tenantId: claimed.tenantId,
      inboxId: claimed.id,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox).failureCode).toBe('OP_APPROVAL_BRIDGE_CONFLICT');
    expect(testHarness.approvals.createAndSubmitFromOp).not.toHaveBeenCalled();
  });

  it('预占桥接遇到唯一键竞争时失败关闭且不创建审批', async () => {
    const testHarness = harness();
    testHarness.bridges.updateOne.mockReset();
    testHarness.bridges.updateOne.mockRejectedValueOnce({ code: 11_000 });

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox).failureCode).toBe('OP_APPROVAL_UNIQUE_CONFLICT');
    expect(testHarness.approvals.createAndSubmitFromOp).not.toHaveBeenCalled();
  });

  it('审批应用返回非运行态时拒绝把桥接伪装成运行中', async () => {
    const testHarness = harness({
      instance: {
        ...defaultInstance(),
        status: 'approved',
        version: 3,
        completedAt: OCCURRED_AT,
      },
    });

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox).failureCode)
      .toBe('OP_APPROVAL_INITIAL_STATUS_INVALID');
  });

  it('桥接状态更新没有持有目标记录时失败关闭', async () => {
    const testHarness = harness();
    testHarness.bridges.updateOne.mockReset();
    testHarness.bridges.updateOne
      .mockResolvedValueOnce({ upsertedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox).failureCode).toBe('OP_APPROVAL_BRIDGE_CONFLICT');
  });

  it.each([
    ['不存在', () => null],
    ['载荷摘要错配', (bridge: Bridge) => ({ ...bridge, payloadHash: 'B'.repeat(43) })],
    ['审批实例错配', (bridge: Bridge) => ({ ...bridge, approvalInstanceId: OTHER_ID })],
    ['来源类型错配', (bridge: Bridge) => ({ ...bridge, sourceDocumentType: 'expense' })],
    ['来源标识错配', (bridge: Bridge) => ({ ...bridge, sourceDocumentId: 'po-002' })],
  ])('审批提交后桥接%s时形成冲突终态', async (_label, mutate) => {
    const claimed = defaultClaim();
    const testHarness = harness({ finalBridge: mutate(defaultBridge(claimed)) });

    await expect(testHarness.service.process({
      tenantId: claimed.tenantId,
      inboxId: claimed.id,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox).failureCode).toBe('OP_APPROVAL_BRIDGE_CONFLICT');
  });

  it.each([
    [
      '结构化稳定错误码',
      new BadRequestException({
        code: 'APPROVAL_TEMPLATE_NOT_PUBLISHED',
        message: '审批模板未发布',
      }),
      'APPROVAL_TEMPLATE_NOT_PUBLISHED',
    ],
    [
      '非法外部错误码',
      new BadRequestException({ code: 'invalid-code', message: 'bad' }),
      'OP_APPROVAL_HTTP_REJECTED',
    ],
    [
      '纯文本响应',
      new HttpException('bad request', 409),
      'OP_APPROVAL_HTTP_REJECTED',
    ],
  ])('审批应用 4xx %s作为永久失败消费', async (_label, error, code) => {
    const testHarness = harness();
    testHarness.approvals.createAndSubmitFromOp.mockRejectedValueOnce(error);

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox).failureCode).toBe(code);
  });

  it('审批应用瞬时失败时保留稳定失败码并抛出原错误以触发队列重试', async () => {
    const error = new ServiceUnavailableException({
      code: 'APPROVAL_DEPENDENCY_UNAVAILABLE',
      message: '审批依赖暂不可用',
    });
    const testHarness = harness();
    testHarness.approvals.createAndSubmitFromOp.mockRejectedValueOnce(error);

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).rejects.toBe(error);
    expect(failureStatus(testHarness.inbox).failureCode)
      .toBe('APPROVAL_DEPENDENCY_UNAVAILABLE');
  });

  it.each([
    ['稳定内部错误', new Error('OP_APPROVAL_TEMPORARY_FAILURE'), 'OP_APPROVAL_TEMPORARY_FAILURE'],
    ['非稳定错误', new Error('temporary failure'), 'OP_APPROVAL_PROCESSING_FAILED'],
    ['非 Error 异常', Object.freeze({ reason: 'temporary' }), 'OP_APPROVAL_PROCESSING_FAILED'],
  ])('%s保留原异常供 Worker 重试', async (_label, error, code) => {
    const testHarness = harness();
    testHarness.approvals.createAndSubmitFromOp.mockRejectedValueOnce(error);

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).rejects.toBe(error);
    expect(failureStatus(testHarness.inbox).failureCode).toBe(code);
  });

  it('失败终态后的审计故障不覆盖永久错误分类', async () => {
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const testHarness = harness({ route: null });
    testHarness.audit.recordSystem.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).resolves.toBe(1);
    expect(failureStatus(testHarness.inbox).failureCode).toBe('OP_APPROVAL_ROUTE_DISABLED');
    expect(logger).toHaveBeenCalledWith({
      code: 'OP_APPROVAL_REQUEST_AUDIT_AFTER_COMMIT_FAILED',
      outcome: 'failure',
    });
  });

  it('Inbox 租约丢失时失败关闭，不记录未经持久化的成功审计', async () => {
    const testHarness = harness();
    testHarness.inbox.updateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(testHarness.service.process({
      tenantId: 'tenant-001',
      inboxId: INBOX_ID,
    })).rejects.toThrow('OP_APPROVAL_INBOX_LEASE_LOST');
    expect(testHarness.audit.recordSystem).not.toHaveBeenCalled();
  });
});
