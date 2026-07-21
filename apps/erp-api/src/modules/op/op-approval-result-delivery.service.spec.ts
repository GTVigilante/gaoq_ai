import { createHash, createHmac } from 'node:crypto';

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

function fixture(httpResult: unknown = {
  status: 200, requestId: 'request-001', body: {
    code: 'OK', data: {
      externalEventId: 'approval-event-001', approvalInstanceId: INSTANCE_ID,
      approvalVersion: 3,
    },
  },
}) {
  const delivery = {
    eventId: EVENT_ID, tenantId: 'tenant-001', clientId: 'op-client-001',
    externalEventId: 'approval-event-001', sourceDocumentType: 'purchase_order',
    sourceDocumentId: 'po-001', approvalInstanceId: INSTANCE_ID, approvalVersion: 3,
    result: 'approved' as const, occurredAt: new Date('2026-07-22T08:00:00.000Z'),
    status: 'processing' as const, attempts: 0, operatorRetryCount: 0,
  };
  const deliveries = {
    findOneAndUpdate: vi.fn()
      .mockReturnValueOnce(query(delivery)).mockReturnValueOnce(query(null)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const routes = { findOne: vi.fn().mockReturnValue(query({
    externalTenantId: 'op-tenant-001', outboundClientId: 'erp-client-001',
    outboundCredentialSecretRef: SECRET_REF,
  })) };
  const http = { put: vi.fn() };
  if (httpResult instanceof Error) http.put.mockRejectedValue(httpResult);
  else http.put.mockResolvedValue(httpResult);
  const audit = { recordSystem: vi.fn().mockResolvedValue(undefined) };
  const service = new OpApprovalResultDeliveryService(
    deliveries as unknown as Model<OpApprovalResultDeliveryDocument>,
    routes as unknown as Model<OpApprovalRouteDocument>,
    new OpApprovalOutboundSecretResolver(), http,
    audit as unknown as AuditService,
  );
  return { service, delivery, deliveries, routes, http, audit };
}

describe('OpApprovalResultDeliveryService', () => {
  beforeEach(() => { process.env[SECRET_REF] = SECRET; });
  afterEach(() => { delete process.env[SECRET_REF]; });

  it('用独立凭据和固定 canonical HMAC 回推最小终态正文', async () => {
    const store = fixture();
    await expect(store.service.processBatch('worker-001', 2)).resolves.toBe(1);
    const request = store.http.put.mock.calls[0]?.[0] as {
      readonly path: string; readonly body: string; readonly headers: Record<string, string>;
    };
    expect(request.path).toBe('/erp/v1/approval-results/approval-event-001');
    expect(request.body).not.toMatch(/formData|approver|comment/iu);
    const canonical = [
      request.headers['x-gaoq-erp-timestamp'], request.headers['x-gaoq-erp-nonce'],
      'PUT', request.path, 'op-tenant-001', EVENT_ID,
      createHash('sha256').update(request.body).digest('base64url'),
    ].join('\n');
    expect(request.headers['x-gaoq-erp-signature']).toBe(
      createHmac('sha256', SECRET).update(canonical).digest('hex'),
    );
    expect(store.deliveries.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'succeeded', lastErrorCode: null },
    });
  });

  it('业务冲突进入人工复核，审计失败不会把已成功投递改回失败', async () => {
    const conflict = fixture(new OpApprovalDeliveryError(
      'OP_APPROVAL_HTTP_409', 'conflict', '冲突', 409,
    ));
    await expect(conflict.service.processBatch('worker-001', 1)).resolves.toBe(0);
    expect(conflict.deliveries.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'manual_review', lastErrorCode: 'OP_APPROVAL_HTTP_409' },
    });

    const committed = fixture();
    committed.audit.recordSystem.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));
    await expect(committed.service.processBatch('worker-002', 1))
      .rejects.toThrow('OP_APPROVAL_POST_COMMIT_AUDIT_FAILED');
    expect(committed.http.put).toHaveBeenCalledOnce();
    expect(committed.deliveries.updateOne).toHaveBeenCalledOnce();
    expect(committed.deliveries.updateOne.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'succeeded' },
    });
  });
});
