import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { RecruitmentManagementService } from './application/recruitment-management.service.js';
import { RecruitmentManagementController } from './recruitment-management.controller.js';

const REQUISITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y8';
const requisition = {
  id: REQUISITION_ID, departmentId: 'department-001', positionTitle: '小红书经纪人',
  headcount: 2, status: 'draft' as const, approvalInstanceId: null, version: 1,
};
const position = {
  id: POSITION_ID, requisitionId: REQUISITION_ID, title: '小红书经纪人',
  departmentId: 'department-001', jobLevelId: 'job-level-001', location: '上海', headcount: 2,
  status: 'draft' as const, version: 1, publishedAt: null, closedAt: null,
};

function fixture() {
  const recruitment = {
    createRequisition: vi.fn().mockResolvedValue({ requisition }),
    getRequisition: vi.fn().mockResolvedValue(requisition),
    submitRequisition: vi.fn().mockResolvedValue({
      requisition: { ...requisition, status: 'pending_approval', version: 2 },
    }),
    syncRequisitionApproval: vi.fn().mockResolvedValue({
      requisition: { ...requisition, status: 'approved', version: 3 },
    }),
    createPosition: vi.fn().mockResolvedValue({ position }),
    getPosition: vi.fn().mockResolvedValue(position),
    transitionPosition: vi.fn().mockResolvedValue({
      position: { ...position, status: 'open', version: 2 },
    }),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const headers = new Map<string, string>();
  const response = {
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
  } as unknown as Response;
  const controller = new RecruitmentManagementController(
    recruitment as unknown as RecruitmentManagementService,
    { record } as unknown as AuditService,
  );
  return { controller, recruitment, record, headers, response };
}

describe('RecruitmentManagementController', () => {
  it('七个端点使用独立最小 Scope', () => {
    const expected: Readonly<Record<MethodName, string>> = {
      createRequisition: 'erp:recruitment:requisition:create',
      getRequisition: 'erp:recruitment:management:read',
      submitRequisition: 'erp:recruitment:requisition:submit',
      syncApproval: 'erp:recruitment:requisition:sync_approval',
      createPosition: 'erp:recruitment:position:create',
      getPosition: 'erp:recruitment:management:read',
      transitionPosition: 'erp:recruitment:position:transition',
    };
    for (const [name, scope] of Object.entries(expected) as [MethodName, string][]) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method(name))).toEqual([scope]);
    }
  });

  it('HC 提交强制 ULID、If-Match 和幂等键，并以 R2 审计', async () => {
    const store = fixture();
    await expect(store.controller.submitRequisition(
      REQUISITION_ID, '1', 'requisition-submit-key-001', store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_IF_MATCH_REQUIRED' } });
    const result = await store.controller.submitRequisition(
      REQUISITION_ID, '"1"', 'requisition-submit-key-001', store.response,
    );
    expect(store.recruitment.submitRequisition).toHaveBeenCalledWith(
      REQUISITION_ID, 1, 'requisition-submit-key-001',
    );
    expect(store.headers.get('ETag')).toBe('"2"');
    expect(result.requisition.status).toBe('pending_approval');
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recruitment.requisition.submit', riskLevel: 'R2',
      resourceId: REQUISITION_ID, metadata: { version: 2, status: 'pending_approval' },
    }));
  });

  it('审批同步不接收 outcome 请求体，只传递可信版本和幂等键', async () => {
    const store = fixture();
    const result = await store.controller.syncApproval(
      REQUISITION_ID, '"2"', 'requisition-sync-key-001', store.response,
    );
    expect(store.recruitment.syncRequisitionApproval).toHaveBeenCalledWith(
      REQUISITION_ID, 2, 'requisition-sync-key-001',
    );
    expect(result.requisition.status).toBe('approved');
    expect(store.headers.get('ETag')).toBe('"3"');
  });

  it('岗位发布强制版本且审计不携带业务原文', async () => {
    const store = fixture();
    const result = await store.controller.transitionPosition(
      POSITION_ID, '"1"', 'position-transition-key-001',
      { targetStatus: 'open' }, store.response,
    );
    expect(store.recruitment.transitionPosition).toHaveBeenCalledWith(
      POSITION_ID, 1, 'position-transition-key-001', 'open',
    );
    expect(result.position).toMatchObject({ status: 'open', version: 2 });
    expect(JSON.stringify(store.record.mock.calls)).not.toMatch(/小红书经纪人|上海/u);
  });
});

type MethodName =
  | 'createRequisition'
  | 'getRequisition'
  | 'submitRequisition'
  | 'syncApproval'
  | 'createPosition'
  | 'getPosition'
  | 'transitionPosition';

function method(name: MethodName): object {
  const value: unknown = Object.getOwnPropertyDescriptor(
    RecruitmentManagementController.prototype, name,
  )?.value;
  if (typeof value !== 'function') throw new Error(`控制器方法 ${name} 不存在`);
  return value;
}
