import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import type {
  DepartmentRepository,
  JobLevelRepository,
} from '../../org/persistence/org.repositories.js';
import {
  RecruitmentDomainError,
  type RecruitmentPosition,
  type RecruitmentRequisition,
} from '../domain/index.js';
import type { RecruitmentOutboxWriter } from '../persistence/recruitment-outbox.writer.js';
import {
  RecruitmentWriteConflictError,
  type RecruitmentPositionRepository,
  type RecruitmentRequisitionRepository,
} from '../persistence/recruitment.repositories.js';
import {
  type ImportRecruitmentPositionFromMigrationInput,
  type ImportRecruitmentRequisitionFromMigrationInput,
  RecruitmentManagementService,
} from './recruitment-management.service.js';

const REQUISITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y9';
const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y8';
const APPROVAL_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const SESSION = { id: 'session' } as unknown as ClientSession;

type RequisitionStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'closed';

type ApprovalStatus = 'draft' | 'running' | 'approved' | 'rejected';

type ActorType = 'user' | 'service' | 'system_job';

interface FixtureOptions {
  readonly requisitionStatus?: RequisitionStatus;
  readonly approvalStatus?: ApprovalStatus;
  readonly actorType?: ActorType;
  readonly actorDepartments?: readonly string[];
  readonly actorScopes?: readonly string[];
}

interface MigrationOverrides {
  readonly requisition?: Partial<ImportRecruitmentRequisitionFromMigrationInput>;
  readonly position?: Partial<ImportRecruitmentPositionFromMigrationInput>;
}

const MIGRATION_SCOPES = [
  'erp:migration:execute',
  'erp:recruitment:migration:write',
] as const;

const ACTIVE_DEPARTMENT = {
  id: 'department-001',
  tenantId: 'tenant-001',
  name: '内容商业化中心',
  status: 'active',
} as const;

const JOB_LEVEL = {
  id: 'job-level-001',
  tenantId: 'tenant-001',
} as const;

const PORTAL_POSITION = {
  id: POSITION_ID,
  tenantId: 'tenant-001',
  requisitionId: REQUISITION_ID,
  title: '小红书经纪人',
  departmentId: 'department-001',
  jobLevelId: 'job-level-001',
  location: '上海',
  headcount: 2,
  status: 'open',
  version: 2,
  publishedAt: '2026-07-21T00:00:00.000Z',
  closedAt: null,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
} as const;

const MIGRATED_REQUISITION_INPUT = {
  targetId: null,
  departmentId: 'department-001',
  positionTitle: '小红书经纪人',
  headcount: 2,
  justification: '历史 HC 需求证据已进入迁移账本',
  status: 'approved',
  approvalReferenceType: 'legacy_history',
  approvalReferenceId: APPROVAL_ID,
  version: 3,
  createdByEmployeeId: 'employee-001',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
} as const satisfies ImportRecruitmentRequisitionFromMigrationInput;

const MIGRATED_POSITION_INPUT = {
  targetId: null,
  requisitionId: REQUISITION_ID,
  departmentId: 'department-001',
  jobLevelId: 'job-level-001',
  title: '小红书经纪人',
  location: '上海',
  headcount: 2,
  status: 'open',
  version: 2,
  publishedAt: '2026-07-21T00:00:00.000Z',
  closedAt: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
} as const satisfies ImportRecruitmentPositionFromMigrationInput;

function migrationInput(overrides: MigrationOverrides = {}) {
  return {
    requisition: {
      ...MIGRATED_REQUISITION_INPUT,
      ...overrides.requisition,
    },
    position: {
      ...MIGRATED_POSITION_INPUT,
      ...overrides.position,
    },
  };
}

function migratedRequisition(
  overrides: Partial<RecruitmentRequisition> = {},
): RecruitmentRequisition {
  return {
    id: REQUISITION_ID,
    tenantId: 'tenant-001',
    departmentId: 'department-001',
    positionTitle: '小红书经纪人',
    headcount: 2,
    justification: '历史 HC 需求证据已进入迁移账本',
    status: 'approved' as const,
    approvalInstanceId: null,
    approvalHistoryId: APPROVAL_ID,
    version: 3,
    createdBy: 'actor-001',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function migratedPosition(
  overrides: Partial<RecruitmentPosition> = {},
): RecruitmentPosition {
  return {
    ...PORTAL_POSITION,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function migrationFixture(options: FixtureOptions = {}) {
  const store = fixture({
    actorType: 'service',
    actorScopes: MIGRATION_SCOPES,
    ...options,
  });
  store.approvals.verifyRecruitmentMigrationReference.mockResolvedValue({
    id: APPROVAL_ID,
    type: 'legacy_history',
    templateCode: 'recruitment_hc',
    outcome: 'approved',
  });
  return store;
}

function expectCode(code: string) {
  return {
    asymmetricMatch(value: unknown): boolean {
      if (typeof value !== 'object' || value === null) return false;
      const response = (value as { response?: unknown }).response;
      return typeof response === 'object' && response !== null &&
        (response as { code?: unknown }).code === code;
    },
    toString: () => `业务错误码 ${code}`,
    getExpectedType: () => 'object',
  };
}

function duplicateKeyError(): Error & { code: number } {
  return Object.assign(new Error('duplicate key'), { code: 11_000 });
}

type DomainFailureCase = {
  readonly error: RecruitmentDomainError;
  readonly expectedCode: string;
  readonly expectedStatus: 'forbidden' | 'conflict' | 'bad_request';
};

const DOMAIN_FAILURE_CASES: readonly DomainFailureCase[] = [
  {
    error: new RecruitmentDomainError(
      'RECRUITMENT_TENANT_MISMATCH',
      '租户不匹配',
    ),
    expectedCode: 'RECRUITMENT_TENANT_MISMATCH',
    expectedStatus: 'forbidden',
  },
  {
    error: new RecruitmentDomainError(
      'RECRUITMENT_OPERATION_DENIED',
      '操作拒绝',
    ),
    expectedCode: 'RECRUITMENT_OPERATION_DENIED',
    expectedStatus: 'forbidden',
  },
  {
    error: new RecruitmentDomainError(
      'RECRUITMENT_EVIDENCE_INVALID',
      '证据无效',
    ),
    expectedCode: 'RECRUITMENT_EVIDENCE_INVALID',
    expectedStatus: 'conflict',
  },
  {
    error: new RecruitmentDomainError(
      'RECRUITMENT_INPUT_INVALID',
      '输入无效',
    ),
    expectedCode: 'RECRUITMENT_INPUT_INVALID',
    expectedStatus: 'bad_request',
  },
];

type ReferenceFailure = {
  readonly name: string;
  readonly mutate: (store: ReturnType<typeof migrationFixture>) => void;
};

const POSITION_REFERENCE_FAILURES: readonly ReferenceFailure[] = [
  {
    name: 'HC 不存在',
    mutate: (store) => {
      store.requisitions.findById.mockResolvedValueOnce(null);
    },
  },
  {
    name: '部门不存在',
    mutate: (store) => {
      store.departments.findById.mockResolvedValueOnce(null);
    },
  },
  {
    name: '职级不存在',
    mutate: (store) => {
      store.jobLevels.findById.mockResolvedValueOnce(null);
    },
  },
  {
    name: '活动职位引用停用部门',
    mutate: (store) => {
      store.departments.findById.mockResolvedValueOnce({
        ...ACTIVE_DEPARTMENT,
        status: 'disabled',
      });
    },
  },
  {
    name: 'HC 部门不一致',
    mutate: (store) => {
      store.requisitions.findById.mockResolvedValueOnce({
        ...requisition('approved'),
        departmentId: 'department-002',
      });
    },
  },
  {
    name: 'HC 职位名称不一致',
    mutate: (store) => {
      store.requisitions.findById.mockResolvedValueOnce({
        ...requisition('approved'),
        positionTitle: '直播运营',
      });
    },
  },
  {
    name: 'HC 数量不一致',
    mutate: (store) => {
      store.requisitions.findById.mockResolvedValueOnce({
        ...requisition('approved'),
        headcount: 3,
      });
    },
  },
  {
    name: '活动职位引用未批准 HC',
    mutate: (store) => {
      store.requisitions.findById.mockResolvedValueOnce(requisition('pending_approval'));
    },
  },
];

type RuntimeFailure = {
  readonly name: string;
  readonly error: unknown;
  readonly expectedCode: string | null;
};

const RUNTIME_FAILURES: readonly RuntimeFailure[] = [
  {
    name: '仓储乐观锁冲突',
    error: new RecruitmentWriteConflictError(),
    expectedCode: 'RECRUITMENT_VERSION_CONFLICT',
  },
  {
    name: '租户内唯一键冲突',
    error: duplicateKeyError(),
    expectedCode: 'RECRUITMENT_UNIQUE_CONFLICT',
  },
  {
    name: '未知基础设施故障',
    error: new Error('DATABASE_UNAVAILABLE'),
    expectedCode: null,
  },
];

const draftRequisition = {
  id: REQUISITION_ID, tenantId: 'tenant-001', departmentId: 'department-001',
  positionTitle: '小红书经纪人', headcount: 2, justification: '业务增长需要补充招聘人数',
  status: 'draft' as const, approvalInstanceId: null, version: 1, createdBy: 'actor-001',
  approvalHistoryId: null,
  createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
};

const draftPosition = {
  id: POSITION_ID, tenantId: 'tenant-001', requisitionId: REQUISITION_ID,
  title: '小红书经纪人', departmentId: 'department-001', jobLevelId: 'job-level-001',
  location: '上海', headcount: 2, status: 'draft' as const, version: 1,
  publishedAt: null, closedAt: null,
  createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
};

function requisition(status: RequisitionStatus = 'draft') {
  const terminalOrPending = status !== 'draft';
  return {
    ...draftRequisition,
    status,
    approvalInstanceId: terminalOrPending ? APPROVAL_ID : null,
    version: terminalOrPending ? (status === 'pending_approval' ? 2 : 3) : 1,
  };
}

function fixture(options?: FixtureOptions) {
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
      actorId: 'actor-001', tenantId: 'tenant-001', actorType: options?.actorType ?? 'user',
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
    verifyRecruitmentMigrationReference: vi.fn().mockResolvedValue({
      id: APPROVAL_ID, type: 'approval_instance', templateCode: 'recruitment_hc',
      outcome: 'running',
    }),
  };
  const profiles = {
    findActorIdByEmployee: vi.fn().mockResolvedValue('actor-001'),
    resolveActive: vi.fn().mockResolvedValue({ actorId: 'actor-001', employeeId: 'employee-001' }),
  };
  const departments = {
    findById: vi.fn().mockResolvedValue(ACTIVE_DEPARTMENT),
    findAll: vi.fn().mockResolvedValue([ACTIVE_DEPARTMENT]),
  };
  const jobLevels = {
    findById: vi.fn().mockResolvedValue(JOB_LEVEL),
  };
  const requisitions = {
    findById: vi.fn().mockResolvedValue(requisition(options?.requisitionStatus)),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const positions = {
    findById: vi.fn().mockResolvedValue(draftPosition),
    findOpen: vi.fn().mockResolvedValue([PORTAL_POSITION]),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new RecruitmentManagementService(
    { execute } as unknown as IdempotencyService,
    context as unknown as TenantContextService,
    approvals as unknown as ApprovalApplicationService,
    profiles as unknown as AccessProfileRepository,
    departments as unknown as DepartmentRepository,
    jobLevels as unknown as JobLevelRepository,
    requisitions as unknown as RecruitmentRequisitionRepository,
    positions as unknown as RecruitmentPositionRepository,
    outbox as unknown as RecruitmentOutboxWriter,
  );
  return {
    service, execute, context, approvals, profiles, departments, jobLevels,
    requisitions, positions, outbox,
  };
}

describe('RecruitmentManagementService', () => {
  it('门户服务只返回开放职位的公开投影且不暴露内部引用', async () => {
    const store = fixture({
      actorType: 'service',
      actorScopes: ['erp:recruitment:portal:read'],
      actorDepartments: [],
    });
    const result = await store.service.listPortalPositions();
    expect(result).toEqual([{
      id: POSITION_ID,
      title: '小红书经纪人',
      department: '内容商业化中心',
      location: '上海',
      headcount: 2,
      publishedAt: '2026-07-21T00:00:00.000Z',
    }]);
    expect(JSON.stringify(result)).not.toMatch(/tenant|requisition|jobLevel|department-001/u);
  });

  it('门户职位投影拒绝人员令牌和缺失专用 Scope 的服务令牌', async () => {
    await expect(fixture({
      actorType: 'user',
      actorScopes: ['erp:recruitment:portal:read'],
    }).service.listPortalPositions()).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_PORTAL_SERVICE_REQUIRED' },
    });
    await expect(fixture({
      actorType: 'service',
      actorScopes: ['erp:recruitment:management:read_all'],
    }).service.listPortalPositions()).rejects.toMatchObject({
      response: { code: 'RECRUITMENT_PORTAL_SERVICE_REQUIRED' },
    });
  });

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

  it('招聘迁移仅允许服务身份，并把终结 HC 绑定到最小审批历史', async () => {
    const denied = fixture({ actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'] });
    await expect(denied.service.importRequisitionFromMigration('migration-key-denied', {
      targetId: null,
      departmentId: 'department-001',
      positionTitle: '小红书经纪人',
      headcount: 2,
      justification: '历史 HC 需求证据已进入迁移账本',
      status: 'approved',
      approvalReferenceType: 'legacy_history',
      approvalReferenceId: APPROVAL_ID,
      version: 3,
      createdByEmployeeId: 'employee-001',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    })).rejects.toMatchObject({ response: { code: 'RECRUITMENT_MIGRATION_WRITER_DENIED' } });

    const store = fixture({
      actorType: 'service',
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    store.approvals.verifyRecruitmentMigrationReference.mockResolvedValue({
      id: APPROVAL_ID, type: 'legacy_history', templateCode: 'recruitment_hc',
      outcome: 'approved',
    });
    const result = await store.service.importRequisitionFromMigration('migration-key-001', {
      targetId: null,
      departmentId: 'department-001',
      positionTitle: '小红书经纪人',
      headcount: 2,
      justification: '历史 HC 需求证据已进入迁移账本',
      status: 'approved',
      approvalReferenceType: 'legacy_history',
      approvalReferenceId: APPROVAL_ID,
      version: 3,
      createdByEmployeeId: 'employee-001',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    });
    expect(store.profiles.findActorIdByEmployee).toHaveBeenCalledWith(
      'tenant-001', 'employee-001', SESSION,
    );
    expect(store.requisitions.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved', approvalInstanceId: null, approvalHistoryId: APPROVAL_ID,
      createdBy: 'actor-001', version: 3,
    }), SESSION);
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.requisition.migrated',
    }), SESSION);
    expect(result.requisition).not.toHaveProperty('justification');
  });

  it('职位迁移复用已迁移 HC、部门与职级且只发迁移事件', async () => {
    const store = fixture({
      requisitionStatus: 'approved',
      actorType: 'system_job',
      actorScopes: ['erp:migration:execute', 'erp:recruitment:migration:write'],
    });
    const result = await store.service.importPositionFromMigration('migration-key-002', {
      targetId: null,
      requisitionId: REQUISITION_ID,
      departmentId: 'department-001',
      jobLevelId: 'job-level-001',
      title: '小红书经纪人',
      location: '上海',
      headcount: 2,
      status: 'open',
      version: 2,
      publishedAt: '2026-07-21T00:00:00.000Z',
      closedAt: null,
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    });
    expect(store.positions.insert).toHaveBeenCalledWith(expect.objectContaining({
      requisitionId: REQUISITION_ID, status: 'open', version: 2,
    }), SESSION);
    expect(store.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recruitment.position.migrated',
    }), SESSION);
    expect(result.position).toMatchObject({ status: 'open', version: 2 });
  });

  it('提交和审批同步都强制当前部门写范围', async () => {
    const submit = fixture({
      actorDepartments: ['department-002'],
      actorScopes: ['erp:recruitment:requisition:submit'],
    });
    await expect(submit.service.submitRequisition(
      REQUISITION_ID,
      1,
      'requisition-submit-denied',
    )).rejects.toEqual(expectCode('RECRUITMENT_MANAGEMENT_WRITE_DENIED'));
    expect(submit.approvals.createInstance).not.toHaveBeenCalled();

    const sync = fixture({
      requisitionStatus: 'pending_approval',
      actorDepartments: ['department-002'],
      actorScopes: ['erp:recruitment:requisition:sync_approval'],
    });
    await expect(sync.service.syncRequisitionApproval(
      REQUISITION_ID,
      2,
      'requisition-sync-denied',
    )).rejects.toEqual(expectCode('RECRUITMENT_MANAGEMENT_WRITE_DENIED'));
    expect(sync.approvals.getInstanceStatusForRecruitment).not.toHaveBeenCalled();
  });

  it('提交审批在事务内重读后再次校验部门范围', async () => {
    const store = fixture();
    const allowed = {
      actorId: 'actor-001',
      tenantId: 'tenant-001',
      actorType: 'user',
      roleCodes: [],
      scopes: [],
      departmentIds: ['department-001'],
      traceId: 'trace-001',
    };
    const denied = { ...allowed, departmentIds: ['department-002'] };
    store.context.getActorRequired
      .mockReturnValueOnce(allowed)
      .mockReturnValueOnce(allowed)
      .mockReturnValue(denied);

    await expect(store.service.submitRequisition(
      REQUISITION_ID,
      1,
      'requisition-submit-scope-changed',
    )).rejects.toEqual(expectCode('RECRUITMENT_MANAGEMENT_WRITE_DENIED'));
    expect(store.approvals.createInstance).toHaveBeenCalledTimes(1);
    expect(store.requisitions.replace).not.toHaveBeenCalled();
  });

  it('审批同步在事务内重读后再次校验部门范围', async () => {
    const store = fixture({ requisitionStatus: 'pending_approval' });
    const allowed = {
      actorId: 'actor-001',
      tenantId: 'tenant-001',
      actorType: 'user',
      roleCodes: [],
      scopes: [],
      departmentIds: ['department-001'],
      traceId: 'trace-001',
    };
    store.context.getActorRequired
      .mockReturnValueOnce(allowed)
      .mockReturnValue({ ...allowed, departmentIds: ['department-002'] });

    await expect(store.service.syncRequisitionApproval(
      REQUISITION_ID,
      2,
      'requisition-sync-scope-changed',
    )).rejects.toEqual(expectCode('RECRUITMENT_MANAGEMENT_WRITE_DENIED'));
    expect(store.approvals.getInstanceStatusForRecruitment).toHaveBeenCalledTimes(1);
    expect(store.requisitions.replace).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...ACTIVE_DEPARTMENT, status: 'disabled' },
  ])('活动 HC 迁移拒绝不存在或停用部门：%j', async (department) => {
    const store = migrationFixture();
    store.departments.findById.mockResolvedValueOnce(department);

    await expect(store.service.importRequisitionFromMigration(
      'migration-invalid-department',
      migrationInput().requisition,
    )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_DEPARTMENT_INVALID'));
    expect(store.requisitions.insert).not.toHaveBeenCalled();
  });

  it('草稿 HC 迁移要求活动创建人且不得绑定审批引用', async () => {
    const store = migrationFixture();
    const input = migrationInput({
      requisition: {
        status: 'draft',
        approvalReferenceType: null,
        approvalReferenceId: null,
        version: 1,
      },
    }).requisition;

    await expect(store.service.importRequisitionFromMigration(
      'migration-draft',
      input,
    )).resolves.toHaveProperty('requisition.status', 'draft');
    expect(store.profiles.resolveActive).toHaveBeenCalledWith(
      'tenant-001',
      'actor-001',
      SESSION,
    );
    expect(store.approvals.verifyRecruitmentMigrationReference).not.toHaveBeenCalled();
  });

  it('HC 迁移拒绝缺失的创建员工身份映射', async () => {
    const store = migrationFixture();
    store.profiles.findActorIdByEmployee.mockResolvedValueOnce(null);

    await expect(store.service.importRequisitionFromMigration(
      'migration-creator-missing',
      migrationInput().requisition,
    )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_CREATOR_IDENTITY_MISSING'));
  });

  it.each([
    null,
    { actorId: 'actor-001', employeeId: 'employee-other' },
  ])('活动 HC 迁移拒绝无效创建员工身份：%j', async (profile) => {
    const store = migrationFixture();
    store.profiles.resolveActive.mockResolvedValueOnce(profile);
    const input = migrationInput({
      requisition: {
        status: 'draft',
        approvalReferenceType: null,
        approvalReferenceId: null,
        version: 1,
      },
    }).requisition;

    await expect(store.service.importRequisitionFromMigration(
      'migration-creator-inactive',
      input,
    )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_CREATOR_IDENTITY_INACTIVE'));
  });

  it('草稿 HC 迁移拒绝携带审批引用', async () => {
    const store = migrationFixture();
    const input = migrationInput({
      requisition: {
        status: 'draft',
        approvalReferenceType: 'approval_instance',
        approvalReferenceId: APPROVAL_ID,
        version: 1,
      },
    }).requisition;

    await expect(store.service.importRequisitionFromMigration(
      'migration-draft-reference',
      input,
    )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_APPROVAL_REFERENCE_INVALID'));
  });

  it.each([
    { approvalReferenceType: 'legacy_history' as const, approvalReferenceId: APPROVAL_ID },
    { approvalReferenceType: 'approval_instance' as const, approvalReferenceId: null },
  ])('待审批 HC 迁移拒绝错误引用组合：%j', async (reference) => {
    const store = migrationFixture();
    const input = migrationInput({
      requisition: {
        status: 'pending_approval',
        version: 2,
        ...reference,
      },
    }).requisition;

    await expect(store.service.importRequisitionFromMigration(
      'migration-pending-reference-invalid',
      input,
    )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_APPROVAL_REFERENCE_INVALID'));
  });

  it('待审批 HC 迁移只接受同模板 running 审批实例', async () => {
    const store = migrationFixture();
    store.approvals.verifyRecruitmentMigrationReference.mockResolvedValueOnce({
      id: APPROVAL_ID,
      type: 'approval_instance',
      templateCode: 'recruitment_hc',
      outcome: 'running',
    });
    const input = migrationInput({
      requisition: {
        status: 'pending_approval',
        approvalReferenceType: 'approval_instance',
        approvalReferenceId: APPROVAL_ID,
        version: 2,
      },
    }).requisition;

    await expect(store.service.importRequisitionFromMigration(
      'migration-pending-valid',
      input,
    )).resolves.toMatchObject({
      requisition: {
        status: 'pending_approval',
        approvalInstanceId: APPROVAL_ID,
        approvalHistoryId: null,
      },
    });
  });

  it('拒绝的 HC 迁移只接受 rejected 历史审批证据', async () => {
    const store = migrationFixture();
    store.departments.findById.mockResolvedValueOnce({
      ...ACTIVE_DEPARTMENT,
      status: 'disabled',
    });
    store.approvals.verifyRecruitmentMigrationReference.mockResolvedValueOnce({
      id: APPROVAL_ID,
      type: 'legacy_history',
      templateCode: 'recruitment_hc',
      outcome: 'rejected',
    });
    const input = migrationInput({
      requisition: {
        status: 'rejected',
        approvalReferenceType: 'legacy_history',
        approvalReferenceId: APPROVAL_ID,
      },
    }).requisition;

    await expect(store.service.importRequisitionFromMigration(
      'migration-rejected-valid',
      input,
    )).resolves.toHaveProperty('requisition.status', 'rejected');
  });

  it.each([
    { id: '01J8ZQK7V0A2M4N6P8R0T2W4X1', templateCode: 'recruitment_hc', outcome: 'approved' },
    { id: APPROVAL_ID, templateCode: 'other_template', outcome: 'approved' },
    { id: APPROVAL_ID, templateCode: 'recruitment_hc', outcome: 'rejected' },
  ])('HC 迁移拒绝不一致审批证据：%j', async (reference) => {
    const store = migrationFixture();
    store.approvals.verifyRecruitmentMigrationReference.mockResolvedValueOnce({
      ...reference,
      type: 'legacy_history',
    });

    await expect(store.service.importRequisitionFromMigration(
      'migration-reference-mismatch',
      migrationInput().requisition,
    )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_APPROVAL_REFERENCE_INVALID'));
  });

  it('相同 HC 迁移快照可幂等重放且不追加事件', async () => {
    const store = migrationFixture();
    store.requisitions.findById.mockResolvedValueOnce(migratedRequisition());
    const input = migrationInput({
      requisition: { targetId: REQUISITION_ID },
    }).requisition;

    await expect(store.service.importRequisitionFromMigration(
      'migration-requisition-replay',
      input,
    )).resolves.toHaveProperty('requisition.id', REQUISITION_ID);
    expect(store.requisitions.insert).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it.each([
    null,
    migratedRequisition({ updatedAt: '2026-07-22T00:00:00.000Z' }),
  ])('HC 迁移目标缺失或快照不一致时拒绝覆盖：%j', async (existing) => {
    const store = migrationFixture();
    store.requisitions.findById.mockResolvedValueOnce(existing);
    const input = migrationInput({
      requisition: { targetId: REQUISITION_ID },
    }).requisition;

    await expect(store.service.importRequisitionFromMigration(
      'migration-requisition-conflict',
      input,
    )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_REQUISITION_IMMUTABLE'));
  });

  it.each(POSITION_REFERENCE_FAILURES)(
    '职位迁移拒绝无效主数据引用：$name',
    async ({ mutate }) => {
      const store = migrationFixture({ requisitionStatus: 'approved' });
      mutate(store);

      await expect(store.service.importPositionFromMigration(
        'migration-position-reference-invalid',
        migrationInput().position,
      )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_POSITION_REFERENCE_INVALID'));
      expect(store.positions.insert).not.toHaveBeenCalled();
    },
  );

  it('已关闭职位允许复用已关闭 HC 和停用部门历史引用', async () => {
    const store = migrationFixture({ requisitionStatus: 'closed' });
    store.departments.findById.mockResolvedValueOnce({
      ...ACTIVE_DEPARTMENT,
      status: 'disabled',
    });
    const input = migrationInput({
      position: {
        status: 'closed',
        version: 3,
        closedAt: '2026-07-21T00:00:00.000Z',
      },
    }).position;

    await expect(store.service.importPositionFromMigration(
      'migration-position-closed',
      input,
    )).resolves.toHaveProperty('position.status', 'closed');
  });

  it('已关闭职位拒绝引用非批准或非关闭 HC', async () => {
    const store = migrationFixture({ requisitionStatus: 'rejected' });
    const input = migrationInput({
      position: {
        status: 'closed',
        version: 3,
        closedAt: '2026-07-21T00:00:00.000Z',
      },
    }).position;

    await expect(store.service.importPositionFromMigration(
      'migration-position-closed-invalid',
      input,
    )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_POSITION_REFERENCE_INVALID'));
  });

  it('相同职位迁移快照可幂等重放且不追加事件', async () => {
    const store = migrationFixture({ requisitionStatus: 'approved' });
    store.positions.findById.mockResolvedValueOnce(migratedPosition());
    const input = migrationInput({
      position: { targetId: POSITION_ID },
    }).position;

    await expect(store.service.importPositionFromMigration(
      'migration-position-replay',
      input,
    )).resolves.toHaveProperty('position.id', POSITION_ID);
    expect(store.positions.insert).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it.each([
    null,
    migratedPosition({ location: '北京' }),
  ])('职位迁移目标缺失或快照不一致时拒绝覆盖：%j', async (existing) => {
    const store = migrationFixture({ requisitionStatus: 'approved' });
    store.positions.findById.mockResolvedValueOnce(existing);
    const input = migrationInput({
      position: { targetId: POSITION_ID },
    }).position;

    await expect(store.service.importPositionFromMigration(
      'migration-position-conflict',
      input,
    )).rejects.toEqual(expectCode('RECRUITMENT_MIGRATION_POSITION_IMMUTABLE'));
  });

  it.each([
    null,
    { ...ACTIVE_DEPARTMENT, status: 'disabled' },
  ])('创建 HC 拒绝不存在或停用部门：%j', async (department) => {
    const store = fixture();
    store.departments.findById.mockResolvedValueOnce(department);

    await expect(store.service.createRequisition('requisition-department-invalid', {
      departmentId: 'department-001',
      positionTitle: '小红书经纪人',
      headcount: 2,
      justification: '业务增长需要补充招聘人数',
    })).rejects.toEqual(expectCode('RECRUITMENT_DEPARTMENT_INACTIVE'));
  });

  it('待审批 HC 使用原审批实例恢复事务绑定，不重复创建审批', async () => {
    const store = fixture({ requisitionStatus: 'pending_approval' });

    await expect(store.service.submitRequisition(
      REQUISITION_ID,
      2,
      'requisition-submit-resume',
    )).resolves.toHaveProperty('requisition.approvalInstanceId', APPROVAL_ID);
    expect(store.approvals.createInstance).not.toHaveBeenCalled();
    expect(store.requisitions.replace).not.toHaveBeenCalled();
    expect(store.outbox.append).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'approved' as const, accepted: true },
    { status: 'draft' as const, accepted: false },
  ])('审批提交结果状态 $status 的处理符合失败关闭规则', async ({ status, accepted }) => {
    const store = fixture();
    store.approvals.submitInstance.mockResolvedValueOnce({
      instance: { id: APPROVAL_ID, status, version: 2 },
    });
    const result = store.service.submitRequisition(
      REQUISITION_ID,
      1,
      `requisition-submit-${status}`,
    );

    if (accepted) {
      await expect(result).resolves.toHaveProperty('requisition.status', 'pending_approval');
    } else {
      await expect(result).rejects.toEqual(expectCode('RECRUITMENT_APPROVAL_SUBMIT_INVALID'));
      expect(store.requisitions.replace).not.toHaveBeenCalled();
    }
  });

  it.each(['approved', 'rejected'] as const)(
    '已终态 HC 的审批同步保持幂等：%s',
    async (status) => {
      const store = fixture({ requisitionStatus: status });

      await expect(store.service.syncRequisitionApproval(
        REQUISITION_ID,
        3,
        `requisition-sync-${status}`,
      )).resolves.toHaveProperty('requisition.status', status);
      expect(store.approvals.getInstanceStatusForRecruitment).not.toHaveBeenCalled();
    },
  );

  it('已终态 HC 的审批同步仍强制精确版本', async () => {
    const store = fixture({ requisitionStatus: 'approved' });

    await expect(store.service.syncRequisitionApproval(
      REQUISITION_ID,
      2,
      'requisition-sync-version-conflict',
    )).rejects.toEqual(expectCode('RECRUITMENT_VERSION_CONFLICT'));
  });

  it.each([
    requisition('draft'),
    { ...requisition('pending_approval'), approvalInstanceId: null },
  ])('非待审批或缺失审批实例的 HC 禁止同步：%j', async (current) => {
    const store = fixture();
    store.requisitions.findById.mockResolvedValueOnce(current);

    await expect(store.service.syncRequisitionApproval(
      REQUISITION_ID,
      current.version,
      'requisition-sync-invalid-state',
    )).rejects.toEqual(expectCode('RECRUITMENT_APPROVAL_SYNC_INVALID'));
  });

  it('拒绝终态从 Approval 专用接口同步并原子记录事件', async () => {
    const store = fixture({
      requisitionStatus: 'pending_approval',
      approvalStatus: 'rejected',
    });

    await expect(store.service.syncRequisitionApproval(
      REQUISITION_ID,
      2,
      'requisition-sync-rejected',
    )).resolves.toHaveProperty('requisition.status', 'rejected');
    expect(store.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recruitment.requisition.rejected' }),
      SESSION,
    );
  });

  it('审批模板不是招聘 HC 时禁止同步', async () => {
    const store = fixture({ requisitionStatus: 'pending_approval' });
    store.approvals.getInstanceStatusForRecruitment.mockResolvedValueOnce({
      id: APPROVAL_ID,
      status: 'approved',
      templateCode: 'other_template',
      templateRevision: 1,
      riskLevel: 'R2',
      version: 3,
      submittedAt: '2026-07-21T00:01:00.000Z',
      completedAt: '2026-07-21T00:02:00.000Z',
    });

    await expect(store.service.syncRequisitionApproval(
      REQUISITION_ID,
      2,
      'requisition-sync-template-mismatch',
    )).rejects.toEqual(expectCode('RECRUITMENT_APPROVAL_TEMPLATE_MISMATCH'));
  });

  it('创建职位强制 HC 精确版本', async () => {
    const store = fixture({ requisitionStatus: 'approved' });

    await expect(store.service.createPosition(
      REQUISITION_ID,
      2,
      'position-version-conflict',
      { jobLevelId: 'job-level-001', location: '上海' },
    )).rejects.toEqual(expectCode('RECRUITMENT_VERSION_CONFLICT'));
  });

  it('创建职位拒绝不存在的 ERP 职级', async () => {
    const store = fixture({ requisitionStatus: 'approved' });
    store.jobLevels.findById.mockResolvedValueOnce(null);

    await expect(store.service.createPosition(
      REQUISITION_ID,
      3,
      'position-job-level-missing',
      { jobLevelId: 'job-level-001', location: '上海' },
    )).rejects.toEqual(expectCode('RECRUITMENT_JOB_LEVEL_NOT_FOUND'));
  });

  it.each([
    null,
    { ...ACTIVE_DEPARTMENT, status: 'disabled' },
  ])('创建职位拒绝不存在或停用部门：%j', async (department) => {
    const store = fixture({ requisitionStatus: 'approved' });
    store.departments.findById.mockResolvedValueOnce(department);

    await expect(store.service.createPosition(
      REQUISITION_ID,
      3,
      'position-department-invalid',
      { jobLevelId: 'job-level-001', location: '上海' },
    )).rejects.toEqual(expectCode('RECRUITMENT_DEPARTMENT_INACTIVE'));
  });

  it('不存在的 HC 与职位使用稳定 404 领域错误', async () => {
    const requisitionStore = fixture();
    requisitionStore.requisitions.findById.mockResolvedValueOnce(null);
    await expect(requisitionStore.service.getRequisition(REQUISITION_ID))
      .rejects.toEqual(expectCode('RECRUITMENT_REQUISITION_NOT_FOUND'));

    const positionStore = fixture();
    positionStore.positions.findById.mockResolvedValueOnce(null);
    await expect(positionStore.service.getPosition(POSITION_ID))
      .rejects.toEqual(expectCode('RECRUITMENT_POSITION_NOT_FOUND'));
  });

  it('门户过滤未发布职位、停用部门和无部门映射职位', async () => {
    const store = fixture({
      actorType: 'service',
      actorScopes: ['erp:recruitment:portal:read'],
      actorDepartments: [],
    });
    store.positions.findOpen.mockResolvedValueOnce([
      { ...PORTAL_POSITION, id: 'position-unpublished', publishedAt: null },
      { ...PORTAL_POSITION, id: 'position-disabled', departmentId: 'department-disabled' },
      { ...PORTAL_POSITION, id: 'position-missing', departmentId: 'department-missing' },
    ]);
    store.departments.findAll.mockResolvedValueOnce([
      ACTIVE_DEPARTMENT,
      {
        ...ACTIVE_DEPARTMENT,
        id: 'department-disabled',
        status: 'disabled',
      },
    ]);

    await expect(store.service.listPortalPositions()).resolves.toEqual([]);
  });

  it.each(RUNTIME_FAILURES)(
    '统一映射运行时故障：$name',
    async ({ error, expectedCode }) => {
      const store = fixture();
      store.requisitions.insert.mockRejectedValueOnce(error);
      const result = store.service.createRequisition('requisition-runtime-failure', {
        departmentId: 'department-001',
        positionTitle: '小红书经纪人',
        headcount: 2,
        justification: '业务增长需要补充招聘人数',
      });

      if (expectedCode === null) {
        await expect(result).rejects.toBe(error);
      } else {
        await expect(result).rejects.toEqual(expectCode(expectedCode));
      }
    },
  );

  it.each(DOMAIN_FAILURE_CASES)(
    '统一映射领域故障：$expectedStatus/$expectedCode',
    async ({ error, expectedCode }) => {
      const store = fixture();
      store.requisitions.insert.mockRejectedValueOnce(error);

      await expect(store.service.createRequisition('requisition-domain-failure', {
        departmentId: 'department-001',
        positionTitle: '小红书经纪人',
        headcount: 2,
        justification: '业务增长需要补充招聘人数',
      })).rejects.toEqual(expectCode(expectedCode));
    },
  );
});
