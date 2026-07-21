import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OpApprovalBridgeDocument } from '../persistence/op.schemas.js';
import { OpApprovalBridgeService } from './op-approval-bridge.service.js';

function query(value: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

describe('OpApprovalBridgeService', () => {
  it('只按可信租户查询固定投影且不返回表单', async () => {
    const findOne = vi.fn().mockReturnValue(query({
      externalEventId: 'approval-event-001', sourceDocumentType: 'purchase_order',
      sourceDocumentId: 'po-001', approvalInstanceId: '01K00000000000000000000001',
      templateCode: 'PURCHASE_ORDER', approvalStatus: 'running', approvalVersion: 2,
      completedAt: null, updatedAt: new Date('2026-07-22T08:00:00.000Z'),
    }));
    const context = new TenantContextService();
    const service = new OpApprovalBridgeService(
      context, { findOne } as unknown as Model<OpApprovalBridgeDocument>,
    );
    const result = await context.run({
      tenant: { tenantId: 'tenant-001', source: 'access_token' },
      actor: {
        actorType: 'user', actorId: 'actor-001', tenantId: 'tenant-001', roleCodes: [],
        scopes: [], departmentIds: [], traceId: 'trace-001',
      },
    }, () => service.get('approval-event-001'));
    expect(findOne.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-001', externalEventId: 'approval-event-001',
    });
    expect(JSON.stringify(result)).not.toMatch(/formData|payloadHash|clientId/iu);
  });
});
