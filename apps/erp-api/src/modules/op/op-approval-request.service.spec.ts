import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

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
const INSTANCE_ID = INBOX_ID;
const OCCURRED_AT = '2026-07-22T08:00:00.000Z';
const raw = Buffer.from(JSON.stringify({
  schemaVersion: '1.0', type: 'approval.requested', occurredAt: OCCURRED_AT,
  data: {
    sourceDocumentType: 'purchase_order', sourceDocumentId: 'po-001',
    initiatorEmployeeId: 'employee-001', title: '采购审批', formData: { amount: 12_345 },
  },
}));

function query<T>(value: T) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

describe('OpApprovalRequestService', () => {
  it('解密并校验 Inbox 后，在可信 Worker 上下文复用审批应用服务并建立桥接', async () => {
    const claimed = {
      id: INBOX_ID, tenantId: 'tenant-001', clientId: 'op-client-001',
      externalEventId: 'approval-event-001', payloadHash: hashOpApprovalPayload(raw),
      providerOccurredAt: new Date(OCCURRED_AT), receivedAt: new Date(OCCURRED_AT),
    };
    const inbox = {
      findOneAndUpdate: vi.fn().mockReturnValue(query(claimed)),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const routes = { findOne: vi.fn().mockReturnValue(query({ templateCode: 'PURCHASE_ORDER' })) };
    const bridges = {
      updateOne: vi.fn()
        .mockResolvedValueOnce({ upsertedCount: 1 })
        .mockResolvedValueOnce({ matchedCount: 1 }),
      findOne: vi.fn()
        .mockReturnValueOnce(query({
          ...claimed, templateCode: 'PURCHASE_ORDER', approvalInstanceId: INBOX_ID,
          sourceDocumentType: 'purchase_order', sourceDocumentId: 'po-001',
        }))
        .mockReturnValueOnce(query({
          ...claimed, templateCode: 'PURCHASE_ORDER', approvalInstanceId: INSTANCE_ID,
          sourceDocumentType: 'purchase_order', sourceDocumentId: 'po-001',
        })),
    };
    const crypto = { unprotect: vi.fn().mockReturnValue(raw) };
    const approvals = { createAndSubmitFromOp: vi.fn().mockResolvedValue({
      instance: { id: INSTANCE_ID, status: 'running', version: 2, completedAt: null },
    }) };
    const audit = { recordSystem: vi.fn().mockResolvedValue(undefined) };
    const context = new TenantContextService();
    const service = new OpApprovalRequestService(
      inbox as unknown as Model<OpApprovalRequestInboxDocument>,
      routes as unknown as Model<OpApprovalRouteDocument>,
      bridges as unknown as Model<OpApprovalBridgeDocument>,
      crypto as unknown as OpApprovalWebhookCryptoService,
      approvals as unknown as ApprovalApplicationService,
      context, audit as unknown as AuditService,
    );
    await expect(service.process({ tenantId: 'tenant-001', inboxId: INBOX_ID })).resolves.toBe(1);
    expect(approvals.createAndSubmitFromOp).toHaveBeenCalledWith(
      expect.stringMatching(/^opapp:/),
      expect.objectContaining({
        instanceId: INBOX_ID,
        templateCode: 'PURCHASE_ORDER', initiatorEmployeeId: 'employee-001',
        sourceDocumentType: 'purchase_order', sourceDocumentId: 'po-001',
      }),
    );
    expect(bridges.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $setOnInsert: {
        approvalInstanceId: INBOX_ID, approvalStatus: 'processing', approvalVersion: 0,
      },
    });
    expect(bridges.updateOne.mock.calls[1]?.[1]).toMatchObject({
      $set: { approvalStatus: 'running', approvalVersion: 2 },
    });
    const completionCall = inbox.updateOne.mock.calls[0] as unknown as readonly [
      Readonly<Record<string, unknown>>,
      { readonly $set: { readonly status: string } },
      Readonly<Record<string, unknown>>,
    ];
    expect(completionCall[0]).toEqual({
      tenantId: 'tenant-001', id: INBOX_ID, status: 'processing',
    });
    expect(completionCall[1].$set.status).toBe('completed');
    expect(completionCall[2]).toEqual({ runValidators: true });
  });
});
