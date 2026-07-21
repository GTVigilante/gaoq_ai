import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OpApprovalResultDeliveryDocument } from '../persistence/op.schemas.js';
import { OpApprovalResultOperationsService } from './op-approval-result-operations.service.js';

const EVENT_ID = '01K00000000000000000000001';

function listQuery(value: unknown) {
  return { sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }) }) };
}

describe('OpApprovalResultOperationsService', () => {
  it('异常投递查询强制租户过滤且不投影外呼正文或凭据', async () => {
    const find = vi.fn().mockReturnValue(listQuery([{
      eventId: EVENT_ID, externalEventId: 'approval-event-001',
      sourceDocumentType: 'purchase_order', sourceDocumentId: 'po-001',
      approvalInstanceId: '01K00000000000000000000002', approvalVersion: 3,
      result: 'approved', status: 'manual_review', attempts: 1, operatorRetryCount: 0,
      lastErrorCode: 'OP_APPROVAL_HTTP_409', updatedAt: new Date('2026-07-22T08:00:00Z'),
    }]));
    const service = new OpApprovalResultOperationsService(
      { find } as unknown as Model<OpApprovalResultDeliveryDocument>,
      { getTenantRequired: () => ({ tenantId: 'tenant-001' }) } as TenantContextService,
      {} as IdempotencyService,
    );
    const result = await service.listTerminal({ status: 'manual_review', limit: 50 });
    expect(result.items).toHaveLength(1);
    const [filter, projection] = find.mock.calls[0] as [Record<string, unknown>, Record<string, number>];
    expect(filter).toMatchObject({ tenantId: 'tenant-001', status: 'manual_review' });
    expect(projection).not.toHaveProperty('body');
    expect(projection).not.toHaveProperty('outboundCredentialSecretRef');
  });

  it('人工重试在统一幂等事务内只复位本租户终态记录', async () => {
    const findOneAndUpdate = vi.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve({ eventId: EVENT_ID }) }),
    });
    const execute = vi.fn().mockImplementation(async (
      _operation: string, _key: string, _request: unknown,
      handler: (session: ClientSession) => Promise<unknown>,
    ) => handler({} as ClientSession));
    const service = new OpApprovalResultOperationsService(
      { findOneAndUpdate } as unknown as Model<OpApprovalResultDeliveryDocument>,
      { getTenantRequired: () => ({ tenantId: 'tenant-001' }) } as TenantContextService,
      { execute } as unknown as IdempotencyService,
    );
    await expect(service.retry(EVENT_ID, 'route_fixed', 'retry-key-0001')).resolves.toEqual({
      delivery: { eventId: EVENT_ID, status: 'pending', reason: 'route_fixed' },
    });
    expect(findOneAndUpdate.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-001', eventId: EVENT_ID,
      status: { $in: ['manual_review', 'dead'] },
    });
    expect(findOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
      $set: { status: 'pending', attempts: 0, lastErrorCode: null },
      $inc: { operatorRetryCount: 1 },
    });
  });
});
