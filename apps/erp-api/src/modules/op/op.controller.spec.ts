import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import type { OpApprovalBridgeService } from './application/op-approval-bridge.service.js';
import type { OpApprovalResultOperationsService } from './application/op-approval-result-operations.service.js';
import type { OpOperatingSummaryService } from './application/op-operating-summary.service.js';
import { OpController } from './op.controller.js';

const EVENT_ID = '01K00000000000000000000001';
const summary = Object.freeze({
  summaryDate: '2026-07-22',
  revision: 2,
  currency: 'CNY' as const,
  metrics: Object.freeze({
    gmvMinor: 123_456,
    paidOrderCount: 12,
    refundMinor: 500,
    refundOrderCount: 1,
    activeCustomerCount: 8,
  }),
});

function fixture() {
  const summaries = { getLatest: vi.fn().mockResolvedValue(summary) };
  const approvalBridges = {
    get: vi.fn().mockResolvedValue({
      externalEventId: 'op-event-001',
      sourceDocumentType: 'purchase_order',
      sourceDocumentId: 'po-001',
      approvalInstanceId: '01K00000000000000000000002',
      templateCode: 'PURCHASE_ORDER',
      approvalStatus: 'running',
      approvalVersion: 2,
      completedAt: null,
      updatedAt: '2026-07-22T08:00:00.000Z',
    }),
  };
  const approvalResultOperations = {
    listTerminal: vi.fn().mockResolvedValue({
      items: [{ eventId: EVENT_ID, status: 'dead' }],
      nextCursor: null,
    }),
    retry: vi.fn().mockResolvedValue({
      eventId: EVENT_ID,
      status: 'pending',
      attempt: 3,
    }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new OpController(
    summaries as unknown as OpOperatingSummaryService,
    approvalBridges as unknown as OpApprovalBridgeService,
    approvalResultOperations as unknown as OpApprovalResultOperationsService,
    audit as unknown as AuditService,
  );
  return { controller, summaries, approvalBridges, approvalResultOperations, audit };
}

describe('OpController', () => {
  it('经营摘要 REST 只返回白名单投影并记录最小 R0 审计', async () => {
    const store = fixture();
    const result = await store.controller.getOperatingSummary('2026-07-22');

    expect(result).toBe(summary);
    expect(Object.keys(result).sort()).toEqual([
      'currency', 'metrics', 'revision', 'summaryDate',
    ]);
    expect(store.summaries.getLatest).toHaveBeenCalledWith('2026-07-22');
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'op.operating_summary.read',
      resourceType: 'op_operating_summary',
      resourceId: '2026-07-22:2',
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { summaryDate: '2026-07-22', revision: 2 },
    });
  });

  it('经营摘要日期格式非法时不调用应用服务', async () => {
    const store = fixture();
    await expect(store.controller.getOperatingSummary('2026-7-22'))
      .rejects.toMatchObject({
        response: { code: 'OP_OPERATING_SUMMARY_DATE_INVALID' },
      });
    expect(store.summaries.getLatest).not.toHaveBeenCalled();
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it('R0 读取审计失败保持失败关闭', async () => {
    const store = fixture();
    const failure = new Error('audit unavailable');
    store.audit.record.mockRejectedValueOnce(failure);
    await expect(store.controller.getOperatingSummary('2026-07-22')).rejects.toBe(failure);
  });

  it('审批桥读取复用应用服务且审计不包含表单正文', async () => {
    const store = fixture();
    const result = await store.controller.getApprovalBridge('op-event-001');

    expect(result).toMatchObject({ approvalInstanceId: '01K00000000000000000000002' });
    expect(store.approvalBridges.get).toHaveBeenCalledWith('op-event-001');
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'op.approval_bridge.read',
      resourceType: 'op_approval_bridge',
      resourceId: '01K00000000000000000000002',
      riskLevel: 'R0',
      outcome: 'success',
      metadata: {
        externalEventId: 'op-event-001',
        sourceDocumentType: 'purchase_order',
        approvalStatus: 'running',
      },
    });
  });

  it.each([
    ['manual_review' as const, undefined, undefined, {
      status: 'manual_review',
      limit: 50,
    }],
    ['dead' as const, EVENT_ID, '25', {
      status: 'dead',
      beforeEventId: EVENT_ID,
      limit: 25,
    }],
  ])('按白名单分页读取%s投递终态', async (status, before, limit, expected) => {
    const store = fixture();
    const result = await store.controller.listApprovalResultDeliveries(status, before, limit);

    expect(result.items).toHaveLength(1);
    expect(store.approvalResultOperations.listTerminal).toHaveBeenCalledWith(expected);
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'op.approval.result.list',
      resourceId: status,
      metadata: { status, count: 1 },
    }));
  });

  it.each([
    ['状态缺失', undefined, undefined, undefined, 'OP_APPROVAL_RESULT_STATUS_INVALID'],
    ['状态非法', 'processing', undefined, undefined, 'OP_APPROVAL_RESULT_STATUS_INVALID'],
    ['游标非法', 'dead', 'bad', undefined, 'OP_APPROVAL_RESULT_EVENT_ID_INVALID'],
    ['limit 为零', 'dead', undefined, '0', 'OP_APPROVAL_RESULT_LIMIT_INVALID'],
    ['limit 为小数', 'dead', undefined, '1.5', 'OP_APPROVAL_RESULT_LIMIT_INVALID'],
    ['limit 超上限', 'dead', undefined, '101', 'OP_APPROVAL_RESULT_LIMIT_INVALID'],
  ])('%s时拒绝查询控制面', async (_name, status, before, limit, code) => {
    const store = fixture();
    await expect(store.controller.listApprovalResultDeliveries(status, before, limit))
      .rejects.toMatchObject({ response: { code } });
    expect(store.approvalResultOperations.listTerminal).not.toHaveBeenCalled();
  });

  it.each([
    'credentials_fixed',
    'route_fixed',
    'provider_recovered',
    'approved_exception',
  ] as const)('以原因 %s 执行幂等重试并记录 R2 成功审计', async (reason) => {
    const store = fixture();
    const result = await store.controller.retryApprovalResultDelivery(
      EVENT_ID,
      'retry-key-001',
      { reason },
    );

    expect(result).toMatchObject({ eventId: EVENT_ID, status: 'pending' });
    expect(store.approvalResultOperations.retry).toHaveBeenCalledWith(
      EVENT_ID,
      reason,
      'retry-key-001',
    );
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'op.approval.result.retry',
      resourceType: 'op_approval_result',
      resourceId: EVENT_ID,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { reason },
    });
  });

  it.each([
    ['事件 ID 非法', 'bad', 'retry-key-001', 'credentials_fixed', 'OP_APPROVAL_RESULT_EVENT_ID_INVALID'],
    ['原因缺失', EVENT_ID, 'retry-key-001', undefined, 'OP_APPROVAL_RESULT_REASON_INVALID'],
    ['原因非法', EVENT_ID, 'retry-key-001', 'manual', 'OP_APPROVAL_RESULT_REASON_INVALID'],
    ['幂等键缺失', EVENT_ID, undefined, 'credentials_fixed', 'IDEMPOTENCY_KEY_REQUIRED'],
    ['幂等键非法', EVENT_ID, 'short', 'credentials_fixed', 'IDEMPOTENCY_KEY_REQUIRED'],
  ])('%s时不执行重试', async (_name, eventId, idempotencyKey, reason, code) => {
    const store = fixture();
    await expect(store.controller.retryApprovalResultDelivery(
      eventId,
      idempotencyKey,
      reason === undefined ? {} : { reason },
    )).rejects.toMatchObject({ response: { code } });
    expect(store.approvalResultOperations.retry).not.toHaveBeenCalled();
    if (code === 'IDEMPOTENCY_KEY_REQUIRED') {
      expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'op.approval.result.retry',
        outcome: 'failure',
      }));
    } else {
      expect(store.audit.record).not.toHaveBeenCalled();
    }
  });

  it('重试失败保留原始错误并尝试记录失败审计', async () => {
    const store = fixture();
    const failure = new Error('provider unavailable');
    store.approvalResultOperations.retry.mockRejectedValueOnce(failure);

    await expect(store.controller.retryApprovalResultDelivery(
      EVENT_ID,
      'retry-key-001',
      { reason: 'provider_recovered' },
    )).rejects.toBe(failure);
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'op.approval.result.retry',
      outcome: 'failure',
    }));
  });

  it.each([
    ['成功终态', false],
    ['业务失败终态', true],
  ])('%s后的审计异常不覆盖已形成的决定', async (_name, operationFails) => {
    const store = fixture();
    const auditFailure = new Error('audit unavailable');
    store.audit.record.mockRejectedValueOnce(auditFailure);
    if (operationFails) {
      const operationFailure = new Error('provider unavailable');
      store.approvalResultOperations.retry.mockRejectedValueOnce(operationFailure);
      await expect(store.controller.retryApprovalResultDelivery(
        EVENT_ID,
        'retry-key-001',
        { reason: 'provider_recovered' },
      )).rejects.toBe(operationFailure);
    } else {
      await expect(store.controller.retryApprovalResultDelivery(
        EVENT_ID,
        'retry-key-001',
        { reason: 'provider_recovered' },
      )).resolves.toMatchObject({ status: 'pending' });
    }
    expect(store.audit.record).toHaveBeenCalledOnce();
  });
});
