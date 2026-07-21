import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type {
  DepartmentRepository,
  JobLevelRepository,
} from '../../org/persistence/org.repositories.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import type {
  RecruitmentPositionRepository,
  RecruitmentRequisitionRepository,
} from '../persistence/recruitment.repositories.js';
import { RecruitmentManagementService } from './recruitment-management.service.js';

const REQUISITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y8';
const APPROVAL_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const SESSION = { id: 'session' } as unknown as ClientSession;

const draftRequisition = {
  id: REQUISITION_ID, tenantId: 'tenant-001', departmentId: 'department-001',
  positionTitle: '小红书经纪人', headcount: 2, justification: '业务增长需要补充招聘人数',
  status: 'draft' as const, approvalInstanceId: null, version: 1, createdBy: 'actor-001',
  createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
};

const draftPosition = {
  id: POSITION_ID, tenantId: 'tenant-001', requisitionId: REQUISITION_ID,
  title: '小红书经纪人', departmentId: 'department-001', jobLevelId: 'job-level-001',
  location: '上海', headcount: 2, status: 'draft' as const, version: 1,
  publishedAt: null, closedAt: null,
  createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
};

function requisition(status: 'draft' | 'pending_approval' | 'approved' | 'rejected' = 'draft') {
  const terminalOrPending = status !== 'draft';
  return {
    ...draftRequisition,
    status,
    approvalInstanceId: terminalOrPending ? APPROVAL_ID : null,
    version: terminalOrPending ? (status === 'pending_approval' ? 2 : 3) : 1,
  };
}

function fixture(options?: {
  readonly requisitionStatus?: 'draft' | 'pending_approval' | 'approved' | 'rejected';
  readonly approvalStatus?: 'draft' | 'running' | 'approved' | 'rejected';
  readonly actorDepartments?: readonly string[];
  readonly actorScopes?: readonly string[];
}) {
  const execute = vi.fn().mockImplementation(
    async (
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(SESSION),
  );
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorId: 'actor-001', tenantId: 'tenant-001', actorType: 'user' as const,
      roleCodes: [], scopes: options?.actorScopes ?? ['erp:recruitment:requisition:sync_approval'],
      departmentIds: options?.actorDepartments ?? ['department-001'], traceId: 'trace-001',
    },
  };
  const context = {
    getRequired: vi.fn().mockReturnValue(trusted),
    getTenantRequired: vi.fn().mockReturnValue(trusted.tenant),
    getActorRequired: vi.fn().mockReturnValue(trusted.actor),
  };
  const approvals = {
    createInstance: vi.fn().mockResolvedValue({
      instance: { id: APPROVAL_ID, status: 'draft', version: 1 },
    }),
    submitInstance: vi.fn().mockResolvedValue({
      instance: { id: APPROVAL_ID, status: 'running', version: 2 },
    }),
    getInstanceStatusForRecruitment: vi.fn().mockResolvedValue({
      id: APPROVAL_ID,
      status: options?.approvalStatus ?? 'approved',
      templateCode: 'recruitment_hc', templateRevision: 1, riskLevel: 'R2', version: 3,
      submittedAt: '2026-07-21T00:01:00.000Z', completedAt: '2026-07-21T00:02:00.000Z',
    }),
  };
  const departments = {
    findById: vi.fn().mockResolvedValue({
      id: 'department-001', tenantId: 'tenant-001', status: 'active',
    }),
  };
  const jobLevels = {
    findById: vi.fn().mockResolvedValue({ id: 'job-level-001', tenantId: 'tenant-001' }),
  };
  const requisitions = {
    findById: vi.fn().mockResolvedValue(requisition(options?.requisitionStatus)),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const positions = {
    findById: vi.fn().mockResolvedValue(draftPosition),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new RecruitmentManagementService(
    { execute } as unknown as IdempotencyService,
    context as unknown as TenantContextService,
    approvals as unknown as ApprovalApplicationService,
    departments as unknown as DepartmentRepository,
    jobLevels as unknown as JobLevelRepository,
    requisitions as unknown as RecruitmentRequisitionRepository,
    positions as unknown as RecruitmentPositionRepository,
    outbox as unknown as RecruitmentOutboxWriter,
  );
  return {
    service, execute, context, approvals, departments, jobLevels, requisitions, positions, outbox,
  };
}

describe('RecruitmentManagementService', () => {
  it('创建 HC 时验证 ERP 有效部门并与 Outbox 同事务', async () => {
    const store = fixture();
    const input = {
      departmentId: 'department-001', positionTitle: '小红书经纪人',
      headcount: 2, justification: '业务增长需要补充招聘人数',
    };
    const result = await store.service.createRequisition('requisition-key-001', input);
    expect(store.execute).toHaveBeenCalledWith(
      'recruitment.requisition.create', 'requisition-key-001', input, expect.any(Function),
    );
    expect(store.departments.findById).toHaveBeenCalledWith('department-001', SESSION);
    expect(store.requisitions.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-001', createdBy: 'actor-001', status: 'draft',
    }), SESSION);
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.requisition.created', aggregateType: 'recruitment.requisition',
    }), SESSION);
    expect(result.requisition).not.toHaveProperty('justification');
  });

  it('提交 HC 用派生幂等键创建并提交审批，再原子绑定精确引用', async () => {
    const store = fixture();
    const result = await store.service.submitRequisition(
      REQUISITION_ID, 1, 'requisition-submit-key-001',
    );
    expect(store.approvals.createInstance).toHaveBeenCalledWith(
      expect.stringMatching(/^recruitment:[A-Za-z0-9_-]{43}$/),
      expect.objectContaining({
        templateCode: 'recruitment_hc',
      }),
    );
    const approvalRequest = store.approvals.createInstance.mock.calls[0]?.[1] as unknown as {
      readonly formData: { readonly requisition_id: string; readonly headcount: number };
    };
    expect(approvalRequest.formData).toMatchObject({ requisition_id: REQUISITION_ID, headcount: 2 });
    const createKey = store.approvals.createInstance.mock.calls[0]?.[0] as unknown;
    const submitKey = store.approvals.submitInstance.mock.calls[0]?.[2] as unknown;
    expect(submitKey).toMatch(/^recruitment:[A-Za-z0-9_-]{43}$/);
    expect(submitKey).not.toBe(createKey);
    expect(store.requisitions.replace).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending_approval', approvalInstanceId: APPROVAL_ID, version: 2,
    }), 1, SESSION);
    expect(result.requisition).toMatchObject({ status: 'pending_approval', version: 2 });
  });

  it('审批未终结时失败关闭，不接受客户端自报结果', async () => {
    const store = fixture({ requisitionStatus: 'pending_approval', approvalStatus: 'running' });
    await expect(store.service.syncRequisitionApproval(
      REQUISITION_ID, 2, 'requisition-sync-key-001',
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_APPROVAL_NOT_TERMINAL' } });
    expect(store.requisitions.replace).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it('从 Approval 专用接口取得终态后原子更新 HC 与 Outbox', async () => {
    const store = fixture({ requisitionStatus: 'pending_approval', approvalStatus: 'approved' });
    const result = await store.service.syncRequisitionApproval(
      REQUISITION_ID, 2, 'requisition-sync-key-002',
    );
    expect(store.approvals.getInstanceStatusForRecruitment).toHaveBeenCalledWith(APPROVAL_ID);
    expect(store.requisitions.replace).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved', approvalInstanceId: APPROVAL_ID, version: 3,
    }), 2, SESSION);
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.requisition.approved', version: 3,
    }), SESSION);
    expect(result.requisition).toMatchObject({ status: 'approved', version: 3 });
  });

  it('已批准 HC 才能按 ERP 职级创建唯一业务职位', async () => {
    const denied = fixture({ requisitionStatus: 'pending_approval' });
    await expect(denied.service.createPosition(
      REQUISITION_ID, 2, 'position-create-key-001',
      { jobLevelId: 'job-level-001', location: '上海' },
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_REQUISITION_NOT_APPROVED' } });
    const store = fixture({ requisitionStatus: 'approved' });
    const result = await store.service.createPosition(
      REQUISITION_ID, 3, 'position-create-key-002',
      { jobLevelId: 'job-level-001', location: '上海' },
    );
    expect(store.jobLevels.findById).toHaveBeenCalledWith('job-level-001', SESSION);
    expect(store.positions.insert).toHaveBeenCalledWith(expect.objectContaining({
      requisitionId: REQUISITION_ID, title: draftRequisition.positionTitle,
      departmentId: 'department-001', headcount: 2, status: 'draft',
    }), SESSION);
    expect(result.position).toMatchObject({ status: 'draft', version: 1 });
  });

  it('开放职位复用 HC 审批证据并原子发布事件', async () => {
    const store = fixture({ requisitionStatus: 'approved' });
    const result = await store.service.transitionPosition(
      POSITION_ID, 1, 'position-transition-key-001', 'open',
    );
    expect(store.positions.replace).toHaveBeenCalledWith(expect.objectContaining({
      status: 'open', version: 2,
    }), 1, SESSION);
    const replaced = store.positions.replace.mock.calls[0]?.[0] as unknown as {
      readonly publishedAt: unknown;
    };
    expect(replaced.publishedAt).toEqual(expect.any(String));
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.position.status_changed', version: 2,
    }), SESSION);
    expect(result.position).toMatchObject({ status: 'open', version: 2 });
  });

  it('读取强制部门数据范围，只有 read_all 可跨部门', async () => {
    const denied = fixture({ actorDepartments: ['department-002'], actorScopes: [] });
    await expect(denied.service.getRequisition(REQUISITION_ID))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_MANAGEMENT_READ_DENIED' } });
    const allowed = fixture({
      actorDepartments: ['department-002'],
      actorScopes: ['erp:recruitment:management:read_all'],
    });
    await expect(allowed.service.getPosition(POSITION_ID))
      .resolves.toMatchObject({ id: POSITION_ID });
  });

  it('写入同时强制部门数据范围，只有 write_all 可跨部门', async () => {
    const denied = fixture({ actorDepartments: ['department-002'], actorScopes: [] });
    await expect(denied.service.createRequisition('requisition-key-002', {
      departmentId: 'department-001', positionTitle: '小红书经纪人',
      headcount: 2, justification: '业务增长需要补充招聘人数',
    })).rejects.toMatchObject({ response: { code: 'RECRUITMENT_MANAGEMENT_WRITE_DENIED' } });
    expect(denied.requisitions.insert).not.toHaveBeenCalled();
    const allowed = fixture({
      actorDepartments: ['department-002'],
      actorScopes: ['erp:recruitment:management:write_all'],
    });
    await expect(allowed.service.createRequisition('requisition-key-003', {
      departmentId: 'department-001', positionTitle: '小红书经纪人',
      headcount: 2, justification: '业务增长需要补充招聘人数',
    })).resolves.toHaveProperty('requisition');
  });
});
