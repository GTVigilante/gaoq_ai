import { ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import {
  createApprovalDelegation,
  createApprovalInstanceDraft,
  createNextApprovalTemplateRevision,
  createApprovalTemplateDraft,
  decideApprovalInstance,
  publishApprovalTemplate,
  submitApprovalInstance,
  type ApprovalTemplateDefinition,
  type ApprovalInstance,
} from '../domain/index.js';
import {
  ApprovalWriteConflictError,
  type ApprovalActionRepository,
  type ApprovalDelegationRepository,
  type ApprovalInstanceRepository,
  type ApprovalLegacyHistoryRepository,
  type ApprovalTemplateRepository,
} from '../persistence/approval.repositories.js';
import type { ApprovalOutboxWriter } from '../persistence/approval-outbox.writer.js';
import type { ApprovalActorResolverService } from './approval-actor-resolver.service.js';
import { ApprovalApplicationService } from './approval-application.service.js';
import type { ApprovalNotificationWriter } from '../notification/approval-notification.writer.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const SESSION = {} as ClientSession;

function definition(): ApprovalTemplateDefinition {
  return {
    fields: [
      { key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' },
      { key: 'remark', label: '私密说明', type: 'text', required: false, sensitivity: 'L3' },
    ],
    nodes: [{
      id: 'manager', name: '经理审批', type: 'approval', approvalMode: 'all',
      resolver: { type: 'employees', employeeIds: ['employee-manager'] },
    }],
  };
}

function template(code = 'EXPENSE', riskLevel: 'R1' | 'R2' = 'R1') {
  const draft = createApprovalTemplateDraft({
    id: 'template-001', tenantId: 'tenant-001', code, name: '费用审批',
    riskLevel, definition: definition(), actorId: 'editor-001',
  }, NOW);
  return publishApprovalTemplate(draft, {
    tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
  }, NOW);
}

function draftInstance(templateCode = 'EXPENSE', riskLevel: 'R1' | 'R2' = 'R1') {
  return createApprovalInstanceDraft({
    id: 'instance-001', tenantId: 'tenant-001', title: '费用申请', initiatorId: 'actor-001',
    template: template(templateCode, riskLevel), formData: { amount: 123_45, remark: '仅财务可见' },
  }, NOW);
}

function runningInstance(templateCode = 'EXPENSE', riskLevel: 'R1' | 'R2' = 'R1') {
  return submitApprovalInstance(draftInstance(templateCode, riskLevel), {
    tenantId: 'tenant-001',
    expectedVersion: 1,
    actorId: 'actor-001',
    resolvedNodes: [{ nodeId: 'manager', actorIds: ['manager-001'] }],
  }, NOW).instance;
}

function treasuryApprovedInstance(
  overrides: Readonly<Record<string, unknown>> = {},
): ApprovalInstance {
  const completedAt = '2026-07-20T00:00:00.000Z';
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4T1',
    status: 'approved',
    completedAt,
    formDataHash: 't'.repeat(43),
    templateSnapshot: { templateCode: 'treasury_bank_account_attestation' },
    formData: {
      owner_type: 'employee',
      owner_id: 'employee-001',
      account_name: '张三',
      account: '6222000000000001',
      clearing_code: 'CNAPS001',
      currency: 'CNY',
    },
    resolvedNodes: [{
      decisions: [{
        decidedBy: 'finance-001',
        principalApproverId: 'finance-001',
        outcome: 'approved',
        decidedAt: completedAt,
        delegated: false,
      }],
    }],
    ...overrides,
  } as unknown as ApprovalInstance;
}

function payrollAdjustmentApprovedInstance(
  overrides: Readonly<Record<string, unknown>> = {},
): ApprovalInstance {
  const completedAt = '2026-07-31T11:00:00.000Z';
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4A4',
    status: 'approved',
    completedAt,
    formDataHash: 'd'.repeat(43),
    templateSnapshot: { templateCode: 'payroll_adjustment_approval' },
    formData: {
      adjustment_id: '01J8ZQK7V0A2M4N6P8R0T2W4D1',
      adjustment_hash: 'a'.repeat(43),
      period: '2026-07',
      adjustment_type: 'supplement',
      reason_code: 'RETROACTIVE_SALARY_CHANGE',
    },
    resolvedNodes: [{ decisions: [{
      decidedBy: 'finance-002',
      principalApproverId: 'finance-002',
      outcome: 'approved',
      decidedAt: completedAt,
      delegated: false,
    }] }],
    ...overrides,
  } as unknown as ApprovalInstance;
}

function trustedContext(scopes: readonly string[] = [], actorId = 'actor-001'): TenantContextService {
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'access_token' as const },
    actor: {
      actorType: 'user' as const,
      actorId,
      tenantId: 'tenant-001',
      roleCodes: [],
      scopes,
      departmentIds: ['department-001'],
      traceId: 'trace-001',
    },
  };
  return {
    getRequired: () => trusted,
    getTenantRequired: () => trusted.tenant,
    getActorRequired: () => trusted.actor,
  } as unknown as TenantContextService;
}

function opWorkerContext(scopes: readonly string[] = ['erp:approval:op:ingest']): TenantContextService {
  const trusted = {
    tenant: { tenantId: 'tenant-001', source: 'service_identity' as const },
    actor: {
      actorType: 'system_job' as const,
      actorId: 'system:op-approval-bridge', tenantId: 'tenant-001',
      roleCodes: ['INTEGRATION_WORKER'], scopes, departmentIds: [], traceId: 'trace-op-001',
    },
  };
  return {
    getRequired: () => trusted,
    getTenantRequired: () => trusted.tenant,
    getActorRequired: () => trusted.actor,
  } as unknown as TenantContextService;
}

function idempotency(): IdempotencyService {
  return {
    execute: async <T extends Record<string, unknown>>(
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (session: ClientSession) => Promise<T>,
    ): Promise<T> => handler(SESSION),
  } as IdempotencyService;
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    profiles: {
      resolveActive: vi.fn((_: string, actorId: string) => Promise.resolve({
        actorId,
        employeeId: actorId.replace(/^actor-/u, ''),
      })),
      findActorIdByEmployee: vi.fn((_: string, employeeId: string) =>
        Promise.resolve(`actor-${employeeId}`)),
    },
    templates: {
      findPublishedByCode: vi.fn().mockResolvedValue(template()),
      findPublished: vi.fn().mockResolvedValue([template()]),
      findLatestByCode: vi.fn().mockResolvedValue(null),
      findByCodeAndRevision: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(template()),
      insert: vi.fn(),
      replace: vi.fn(),
    },
    legacyHistories: {
      findByEvidenceRef: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(null),
      insert: vi.fn(),
    },
    instances: { findById: vi.fn(), insert: vi.fn(), replace: vi.fn(), findInbox: vi.fn() },
    actions: { append: vi.fn(), findTimeline: vi.fn().mockResolvedValue([]) },
    delegations: {
      isActive: vi.fn().mockResolvedValue(false),
      findMine: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      hasOverlap: vi.fn().mockResolvedValue(false),
      insert: vi.fn(),
      replace: vi.fn(),
    },
    resolvers: {
      resolve: vi.fn().mockResolvedValue([{ nodeId: 'manager', actorIds: ['manager-001'] }]),
    },
    outbox: { append: vi.fn() },
    notifications: { append: vi.fn() },
    ...overrides,
  };
}

function service(
  deps: ReturnType<typeof dependencies>,
  context: TenantContextService = trustedContext(),
): ApprovalApplicationService {
  return new ApprovalApplicationService(
    idempotency(),
    context,
    deps.profiles as unknown as AccessProfileRepository,
    deps.templates as unknown as ApprovalTemplateRepository,
    deps.legacyHistories as unknown as ApprovalLegacyHistoryRepository,
    deps.instances as unknown as ApprovalInstanceRepository,
    deps.actions as unknown as ApprovalActionRepository,
    deps.delegations as unknown as ApprovalDelegationRepository,
    deps.resolvers as unknown as ApprovalActorResolverService,
    deps.outbox as unknown as ApprovalOutboxWriter,
    deps.notifications as unknown as ApprovalNotificationWriter,
  );
}

describe('ApprovalApplicationService', () => {
  it('考勤修订迁移只读取已通过专用历史的时间与证据摘要', async () => {
    const deps = dependencies({
      legacyHistories: {
        ...dependencies().legacyHistories,
        findById: vi.fn().mockResolvedValue({
          id: 'history-attendance-001', templateCode: 'attendance_correction',
          outcome: 'approved', completedAt: '2026-04-01T02:00:00.000Z',
          evidenceChecksum: 'h'.repeat(43), migrationEvidenceRef: '不得输出',
        }),
      },
    });
    const application = service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:attendance:migration:write']),
    );
    const result = await application.verifyAttendanceCorrectionMigrationReference(
      'history-attendance-001', SESSION,
    );
    expect(result).toEqual({
      id: 'history-attendance-001', completedAt: '2026-04-01T02:00:00.000Z',
      evidenceChecksum: 'h'.repeat(43),
    });
    expect(JSON.stringify(result)).not.toContain('不得输出');
  });

  it('考勤月结迁移只读取已通过重开历史的时间与证据摘要', async () => {
    const deps = dependencies({
      legacyHistories: {
        ...dependencies().legacyHistories,
        findById: vi.fn().mockResolvedValue({
          id: 'history-reopen-001', templateCode: 'attendance_month_reopen',
          outcome: 'approved', completedAt: '2026-04-03T00:00:00.000Z',
          evidenceChecksum: 'r'.repeat(43),
        }),
      },
    });
    const application = service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:attendance:migration:write']),
    );
    await expect(application.verifyAttendanceMonthReopenMigrationReference(
      'history-reopen-001', SESSION,
    )).resolves.toEqual({
      id: 'history-reopen-001', completedAt: '2026-04-03T00:00:00.000Z',
      evidenceChecksum: 'r'.repeat(43),
    });
  });

  it('薪资迁移只读取已通过专用历史的安全投影', async () => {
    const deps = dependencies({
      legacyHistories: {
        ...dependencies().legacyHistories,
        findById: vi.fn().mockResolvedValue({
          id: 'history-payroll-001', templateCode: 'payroll_compensation',
          outcome: 'approved', completedAt: '2026-01-01T00:00:00.000Z',
          evidenceChecksum: 'p'.repeat(43), migrationEvidenceRef: '不得输出',
        }),
      },
    });
    const application = service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:payroll:migration:write']),
    );
    const result = await application.verifyPayrollMigrationReference(
      'history-payroll-001', 'payroll_compensation', SESSION,
    );
    expect(result).toEqual({
      id: 'history-payroll-001', templateCode: 'payroll_compensation',
      completedAt: '2026-01-01T00:00:00.000Z', evidenceChecksum: 'p'.repeat(43),
    });
    expect(JSON.stringify(result)).not.toContain('不得输出');
  });

  it('资金迁移只读取已通过账户鉴证历史的安全投影', async () => {
    const deps = dependencies({
      legacyHistories: {
        ...dependencies().legacyHistories,
        findById: vi.fn().mockResolvedValue({
          id: 'history-treasury-001', templateCode: 'treasury_bank_account_attestation',
          outcome: 'approved', completedAt: '2026-01-02T00:00:00.000Z',
          evidenceChecksum: 't'.repeat(43), migrationEvidenceRef: '不得输出',
        }),
      },
    });
    const application = service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:treasury:migration:write']),
    );
    const result = await application.verifyTreasuryMigrationReference(
      'history-treasury-001', 'treasury_bank_account_attestation', SESSION,
    );
    expect(result).toEqual({
      id: 'history-treasury-001', templateCode: 'treasury_bank_account_attestation',
      completedAt: '2026-01-02T00:00:00.000Z', evidenceChecksum: 't'.repeat(43),
    });
    expect(JSON.stringify(result)).not.toContain('不得输出');
  });

  it('招聘迁移只能读取活动审批或终结历史的最小引用投影', async () => {
    const running = submitApprovalInstance(draftInstance('recruitment_hc'), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      resolvedNodes: [{ nodeId: 'manager', actorIds: ['manager-001'] }],
    }, NOW).instance;
    const deps = dependencies({
      instances: {
        ...dependencies().instances,
        findById: vi.fn().mockResolvedValue(running),
      },
      legacyHistories: {
        ...dependencies().legacyHistories,
        findById: vi.fn().mockResolvedValue({
          id: 'history-001', templateCode: 'recruitment_hc', outcome: 'approved',
        }),
      },
    });
    const application = service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:recruitment:migration:write']),
    );

    await expect(application.verifyRecruitmentMigrationReference(
      'approval_instance', running.id, SESSION,
    )).resolves.toEqual({
      id: running.id, type: 'approval_instance', templateCode: 'recruitment_hc', outcome: 'running',
    });
    await expect(application.verifyRecruitmentMigrationReference(
      'legacy_history', 'history-001', SESSION,
    )).resolves.toEqual({
      id: 'history-001', type: 'legacy_history', templateCode: 'recruitment_hc', outcome: 'approved',
    });
    expect(JSON.stringify(await application.verifyRecruitmentMigrationReference(
      'approval_instance', running.id, SESSION,
    ))).not.toContain('formData');
  });

  it('旧审批历史只写不可变索引和迁移事件，不重放通知', async () => {
    const deps = dependencies({
      templates: {
        ...dependencies().templates,
        findByCodeAndRevision: vi.fn().mockResolvedValue(template()),
      },
    });
    const result = await service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:approval:migration:write']),
    ).importLegacyHistoryFromMigration('migration-history-key', {
      templateId: 'template-001',
      templateCode: 'EXPENSE',
      templateRevision: 1,
      initiatorEmployeeId: 'employee-initiator',
      outcome: 'approved',
      completedAt: '2020-01-02T00:00:00.000Z',
      archivedAt: null,
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/legacy-history-001',
      evidenceChecksum: 'a'.repeat(43),
    });

    expect(result.history).toMatchObject({
      tenantId: 'tenant-001', initiatorEmployeeId: 'employee-initiator', version: 1,
    });
    expect(deps.legacyHistories.insert).toHaveBeenCalledOnce();
    expect(deps.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_history.migrated' }), SESSION,
    );
    expect(deps.notifications.append).not.toHaveBeenCalled();
  });

  it('旧审批历史拒绝来源映射模板与编码修订查询结果不一致', async () => {
    const deps = dependencies({
      templates: {
        ...dependencies().templates,
        findByCodeAndRevision: vi.fn().mockResolvedValue(template()),
      },
    });
    await expect(service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:approval:migration:write']),
    ).importLegacyHistoryFromMigration('migration-history-mismatch-key', {
      templateId: 'template-other', templateCode: 'EXPENSE', templateRevision: 1,
      initiatorEmployeeId: 'employee-initiator', outcome: 'approved',
      completedAt: '2020-01-02T00:00:00.000Z', archivedAt: null,
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/legacy-history-002',
      evidenceChecksum: 'b'.repeat(43),
    })).rejects.toMatchObject({
      response: { code: 'APPROVAL_MIGRATION_HISTORY_TEMPLATE_MISSING' },
    });
    expect(deps.legacyHistories.insert).not.toHaveBeenCalled();
  });

  it('活动审批按历史动作重放运行态并只发布迁移事件', async () => {
    const deps = dependencies();
    const result = await service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:approval:migration:write']),
    ).importActiveInstanceFromMigration('migration-active-key', {
      templateId: 'template-001', templateCode: 'EXPENSE', templateRevision: 1,
      title: '迁移中的费用审批', initiatorEmployeeId: 'employee-initiator',
      formData: { amount: 12_345 }, mappedFormReferenceFields: [],
      resolvedNodes: [{
        nodeId: 'manager',
        actorEmployeeIds: ['employee-manager-1', 'employee-manager-2'],
      }],
      actions: [{
        type: 'submitted', actorEmployeeId: 'employee-initiator',
        occurredAt: '2026-07-21T00:10:00.000Z',
      }, {
        type: 'decided', actorEmployeeId: 'employee-manager-1',
        principalApproverEmployeeId: 'employee-manager-1', outcome: 'approved',
        occurredAt: '2026-07-21T00:20:00.000Z',
      }],
      expectedStatus: 'running', expectedVersion: 3, expectedCurrentNodeId: 'manager',
      expectedPendingApproverEmployeeIds: ['employee-manager-2'],
      createdAt: '2026-07-21T00:05:00.000Z',
      submittedAt: '2026-07-21T00:10:00.000Z',
      updatedAt: '2026-07-21T00:20:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/active-evidence-001',
      evidenceChecksum: 'c'.repeat(43),
    });

    expect(result.instance).toMatchObject({
      status: 'running', version: 3, submittedAt: '2026-07-21T00:10:00.000Z',
    });
    expect(result.instance).not.toHaveProperty('formData');
    expect(deps.instances.insert).toHaveBeenCalledOnce();
    expect(deps.actions.append).toHaveBeenCalledTimes(2);
    const migratedEvent = deps.outbox.append.mock.calls[0]?.[0] as unknown as {
      type: string; payload: { actionCount: number; evidenceChecksum: string };
    };
    expect(migratedEvent).toMatchObject({
      type: 'approval_instance.migrated',
      payload: { actionCount: 2, evidenceChecksum: 'c'.repeat(43) },
    });
    expect(deps.outbox.append.mock.calls[0]?.[1]).toBe(SESSION);
    expect(deps.notifications.append).not.toHaveBeenCalled();
  });

  it('活动审批表单含文件引用时失败关闭', async () => {
    const fileDraft = createApprovalTemplateDraft({
      id: 'template-file', tenantId: 'tenant-001', code: 'FILE_FLOW', name: '文件审批',
      riskLevel: 'R1', actorId: 'editor-001', definition: {
        fields: [{
          key: 'files', label: '附件', type: 'file_reference', required: true, sensitivity: 'L3',
        }],
        nodes: [{
          id: 'manager', name: '经理审批', type: 'approval', approvalMode: 'all',
          resolver: { type: 'initiator_manager' },
        }],
      },
    }, NOW);
    const fileTemplate = publishApprovalTemplate(fileDraft, {
      tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
    }, NOW);
    const deps = dependencies({
      templates: { ...dependencies().templates, findById: vi.fn().mockResolvedValue(fileTemplate) },
    });
    await expect(service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:approval:migration:write']),
    ).importActiveInstanceFromMigration('migration-active-file-key', {
      templateId: 'template-file', templateCode: 'FILE_FLOW', templateRevision: 1,
      title: '带文件审批', initiatorEmployeeId: 'employee-initiator',
      formData: { files: ['source-file-001'] }, mappedFormReferenceFields: [],
      resolvedNodes: [], actions: [], expectedStatus: 'draft', expectedVersion: 1,
      expectedCurrentNodeId: null, expectedPendingApproverEmployeeIds: [],
      createdAt: '2026-07-21T00:05:00.000Z', submittedAt: null,
      updatedAt: '2026-07-21T00:05:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/active-evidence-002',
      evidenceChecksum: 'd'.repeat(43),
    })).rejects.toMatchObject({
      response: { code: 'APPROVAL_MIGRATION_ACTIVE_FILE_UNSUPPORTED' },
    });
    expect(deps.instances.insert).not.toHaveBeenCalled();
  });

  it('活动草稿所有者身份停用时拒绝迁移', async () => {
    const base = dependencies();
    const deps = dependencies({
      profiles: { ...base.profiles, resolveActive: vi.fn().mockResolvedValue(null) },
    });
    await expect(service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:approval:migration:write']),
    ).importActiveInstanceFromMigration('migration-active-inactive-key', {
      templateId: 'template-001', templateCode: 'EXPENSE', templateRevision: 1,
      title: '停用员工草稿', initiatorEmployeeId: 'employee-inactive',
      formData: { amount: 100 }, mappedFormReferenceFields: [], resolvedNodes: [], actions: [],
      expectedStatus: 'draft', expectedVersion: 1, expectedCurrentNodeId: null,
      expectedPendingApproverEmployeeIds: [], createdAt: '2026-07-21T00:05:00.000Z',
      submittedAt: null, updatedAt: '2026-07-21T00:05:00.000Z',
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/active-evidence-003',
      evidenceChecksum: 'e'.repeat(43),
    })).rejects.toMatchObject({
      response: { code: 'APPROVAL_MIGRATION_ACTIVE_ACTOR_INACTIVE' },
    });
    expect(deps.instances.insert).not.toHaveBeenCalled();
  });

  it('迁移服务按员工身份映射连续恢复模板版本且不重放通知', async () => {
    const deps = dependencies();
    const result = await service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:approval:migration:write']),
    ).importTemplateFromMigration('migration-template-key', {
      code: 'LEGACY_EXPENSE', name: '历史费用审批', riskLevel: 'R2', revision: 1,
      status: 'published', definition: definition(),
      createdByEmployeeId: 'employee-editor', updatedByEmployeeId: 'employee-approver',
      approvedByEmployeeId: 'employee-approver',
      publishedAt: '2020-01-02T00:00:00.000Z', retiredAt: null,
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z',
    });

    expect(result.template).toMatchObject({
      code: 'LEGACY_EXPENSE', revision: 1, status: 'published',
      createdBy: 'actor-employee-editor', approvedBy: 'actor-employee-approver',
    });
    expect(deps.templates.insert).toHaveBeenCalledWith(result.template, SESSION);
    expect(deps.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_template.migrated' }), SESSION,
    );
    expect(deps.notifications.append).not.toHaveBeenCalled();
  });

  it('审批模板迁移拒绝修订号断层和普通用户执行', async () => {
    const deps = dependencies();
    deps.templates.findLatestByCode.mockResolvedValue(template());
    const input = {
      code: 'EXPENSE', name: '历史费用审批', riskLevel: 'R1' as const, revision: 3,
      status: 'draft' as const, definition: definition(),
      createdByEmployeeId: 'employee-editor', updatedByEmployeeId: 'employee-editor',
      approvedByEmployeeId: null, publishedAt: null, retiredAt: null,
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    };
    await expect(service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:approval:migration:write']),
    ).importTemplateFromMigration('migration-template-gap', input)).rejects.toMatchObject({
      response: { code: 'APPROVAL_MIGRATION_TEMPLATE_REVISION_GAP' },
    });
    await expect(service(deps).importTemplateFromMigration(
      'migration-template-user', input,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.templates.insert).not.toHaveBeenCalled();
  });

  it('已发布模板目录只返回表单字段，不泄漏审批节点、审批人或租户', async () => {
    const deps = dependencies();
    const result = await service(deps).listPublishedTemplateForms();
    expect(result).toEqual([expect.objectContaining({
      code: 'EXPENSE', name: '费用审批', revision: 1, riskLevel: 'R1',
      fields: definition().fields,
    })]);
    expect(JSON.stringify(result)).not.toContain('tenant-001');
    expect(JSON.stringify(result)).not.toContain('employee-manager');
    expect(JSON.stringify(result)).not.toContain('resolver');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('本人创建委托时验证有效主体、禁止重叠并同事务写事件', async () => {
    const deps = dependencies();
    const validFrom = new Date(Date.now() + 60_000).toISOString();
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const result = await service(
      deps,
      trustedContext(['erp:approval:delegation:write'], 'manager-001'),
    ).createDelegation('delegation-create-key', {
      delegateId: 'manager-002', validFrom, validUntil,
    });
    expect(result.delegation).toMatchObject({
      principalApproverId: 'manager-001', delegateId: 'manager-002', status: 'active', version: 1,
    });
    expect(JSON.stringify(result)).not.toContain('tenant-001');
    expect(deps.profiles.resolveActive).toHaveBeenCalledTimes(2);
    expect(deps.delegations.insert).toHaveBeenCalledOnce();
    expect(deps.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_delegation.created' }), SESSION,
    );

    deps.delegations.hasOverlap.mockResolvedValue(true);
    await expect(service(
      deps,
      trustedContext(['erp:approval:delegation:write'], 'manager-001'),
    ).createDelegation('delegation-overlap-key', {
      delegateId: 'manager-003', validFrom, validUntil,
    })).rejects.toMatchObject({ response: { code: 'APPROVAL_DELEGATION_OVERLAP' } });
  });

  it('本人按强版本撤销委托并返回最小投影', async () => {
    const deps = dependencies();
    deps.delegations.findById.mockResolvedValue({
      id: 'delegation-001', tenantId: 'tenant-001', principalApproverId: 'manager-001',
      delegateId: 'manager-002', validFrom: '2026-07-22T00:00:00.000Z',
      validUntil: '2026-08-01T00:00:00.000Z', status: 'active', version: 1,
      createdBy: 'manager-001', revokedBy: null,
      createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
    });
    const result = await service(
      deps,
      trustedContext(['erp:approval:delegation:write'], 'manager-001'),
    ).revokeDelegation('delegation-001', 1, 'delegation-revoke-key');
    expect(result.delegation).toMatchObject({ status: 'revoked', version: 2 });
    expect(result.delegation).not.toHaveProperty('tenantId');
    expect(deps.delegations.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'revoked', revokedBy: 'manager-001' }), 1, SESSION,
    );
    expect(deps.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_delegation.revoked' }), SESSION,
    );
  });

  it('时间线先复用实例读取授权，再返回不含表单正文的动作投影', async () => {
    const timeline = [{
      actionId: '01K00000000000000000000000', aggregateVersion: 1,
      actionType: 'instance.submitted', actorId: 'actor-001', principalApproverId: null,
      nodeId: null, outcome: null, resultingStatus: null, delegated: false,
      fromApproverId: null, toApproverId: null, addedApproverId: null,
      canceledApproverIds: [], occurredAt: NOW.toISOString(),
    }] as const;
    const deps = dependencies({
      instances: { findById: vi.fn().mockResolvedValue(draftInstance()) },
      actions: { append: vi.fn(), findTimeline: vi.fn().mockResolvedValue(timeline) },
    });
    await expect(service(deps).getTimeline('instance-001')).resolves.toEqual(timeline);
    expect(deps.actions.findTimeline).toHaveBeenCalledWith('instance-001');

    const denied = service(deps, trustedContext([], 'unrelated-actor'));
    await expect(denied.getTimeline('instance-001')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('OP Worker 只能以 ERP 员工主体和 ERP 路由模板原子创建并提交审批', async () => {
    const deps = dependencies({
      profiles: {
        findActorIdByEmployee: vi.fn().mockResolvedValue('actor-op-001'),
        resolveActive: vi.fn().mockResolvedValue({
          actorId: 'actor-op-001', employeeId: 'employee-op-001',
        }),
      },
    });
    const result = await service(deps, opWorkerContext()).createAndSubmitFromOp(
      'opapp:test-001', {
        instanceId: '01K00000000000000000000001',
        templateCode: 'EXPENSE', title: 'OP 费用申请',
        formData: { amount: 123_45 }, initiatorEmployeeId: 'employee-op-001',
        sourceDocumentType: 'expense_claim', sourceDocumentId: 'expense-001',
      },
    );
    expect(result.instance).toMatchObject({ status: 'running' });
    expect(deps.instances.insert).toHaveBeenCalledWith(
      expect.objectContaining({ initiatorId: 'actor-op-001', status: 'running' }), SESSION,
    );
    expect(deps.actions.append).toHaveBeenCalledOnce();
    expect(deps.outbox.append).toHaveBeenCalledTimes(2);
    expect(deps.notifications.append).toHaveBeenCalledOnce();
  });

  it('普通用户即使伪造 OP Scope 也不能调用 OP 审批接入方法', async () => {
    const deps = dependencies();
    await expect(service(
      deps, trustedContext(['erp:approval:op:ingest']),
    ).createAndSubmitFromOp('opapp:test-002', {
      instanceId: '01K00000000000000000000002',
      templateCode: 'EXPENSE', title: '越权申请', formData: { amount: 100 },
      initiatorEmployeeId: 'employee-001', sourceDocumentType: 'expense_claim',
      sourceDocumentId: 'expense-002',
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.instances.insert).not.toHaveBeenCalled();
  });

  it('招聘集成只能用专用 Scope 读取状态摘要', async () => {
    const deps = dependencies();
    const instance = draftInstance('recruitment_hc');
    deps.instances.findById.mockResolvedValue(instance);
    await expect(service(deps).getInstanceStatusForRecruitment(instance.id))
      .rejects.toBeInstanceOf(ForbiddenException);
    const result = await service(
      deps,
      trustedContext(['erp:recruitment:requisition:sync_approval']),
    ).getInstanceStatusForRecruitment(instance.id);
    expect(result).toMatchObject({
      id: instance.id, status: 'draft', templateCode: 'recruitment_hc',
    });
    expect(result).not.toHaveProperty('formData');
    expect(result).not.toHaveProperty('title');
  });

  it('招聘集成拒绝读取非 HC 审批，即使调用者拥有专用 Scope', async () => {
    const deps = dependencies();
    deps.instances.findById.mockResolvedValue(draftInstance());
    await expect(service(
      deps,
      trustedContext(['erp:recruitment:requisition:sync_approval']),
    ).getInstanceStatusForRecruitment('instance-001')).rejects.toMatchObject({
      response: { code: 'APPROVAL_INTEGRATION_TEMPLATE_DENIED' },
    });
  });

  it('Offer 集成使用独立 Scope 和模板白名单且不返回 L4 表单', async () => {
    const deps = dependencies();
    const instance = draftInstance('recruitment_offer');
    deps.instances.findById.mockResolvedValue(instance);
    await expect(service(
      deps,
      trustedContext(['erp:recruitment:requisition:sync_approval']),
    ).getInstanceStatusForRecruitmentOffer(instance.id)).rejects.toMatchObject({
      response: { code: 'APPROVAL_OFFER_INTEGRATION_STATUS_DENIED' },
    });
    const result = await service(
      deps,
      trustedContext(['erp:recruitment:offer:sync_approval']),
    ).getInstanceStatusForRecruitmentOffer(instance.id);
    expect(result).toMatchObject({
      id: instance.id, status: 'draft', templateCode: 'recruitment_offer',
    });
    expect(result).not.toHaveProperty('formData');
    expect(result).not.toHaveProperty('title');
  });

  it('Care 集成使用独立 Scope 和离职模板白名单且不返回审批正文', async () => {
    const deps = dependencies();
    const instance = draftInstance('care_offboarding');
    deps.instances.findById.mockResolvedValue(instance);
    await expect(service(
      deps,
      trustedContext(['erp:recruitment:offer:sync_approval']),
    ).getInstanceStatusForCare(instance.id)).rejects.toMatchObject({
      response: { code: 'APPROVAL_CARE_INTEGRATION_STATUS_DENIED' },
    });
    const result = await service(
      deps, trustedContext(['erp:care:approval:sync']),
    ).getInstanceStatusForCare(instance.id);
    expect(result).toMatchObject({ id: instance.id, templateCode: 'care_offboarding' });
    expect(result).not.toHaveProperty('formData');
    expect(result).not.toHaveProperty('title');
  });

  it('考勤修订只输出与批准正文哈希绑定的强类型决定，非法字段失败关闭', async () => {
    const deps = dependencies();
    const approved = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', status: 'approved',
      completedAt: '2026-04-02T00:00:00.000Z', formDataHash: 'a'.repeat(43),
      templateSnapshot: { templateCode: 'attendance_correction' },
      formData: {
        source_fact_id: '01J8ZQK7V0A2M4N6P8R0T2W4F1', employee_id: 'employee-001',
        business_date: '2026-04-01', worked_minutes: 420, leave_minutes: 60,
        overtime_minutes: 0, absent_minutes: 0, reason_code: 'MISSED_BREAK',
      },
    } as unknown as ApprovalInstance;
    deps.instances.findById.mockResolvedValue(approved);
    const attendance = service(deps, trustedContext(['erp:attendance:approval:sync']));
    await expect(attendance.getAttendanceCorrectionDecision(approved.id)).resolves.toEqual({
      id: approved.id, completedAt: approved.completedAt,
      sourceFactId: '01J8ZQK7V0A2M4N6P8R0T2W4F1', employeeId: 'employee-001',
      businessDate: '2026-04-01', replacementImpact: {
        workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'MISSED_BREAK', formDataHash: 'a'.repeat(43),
    });
    deps.instances.findById.mockResolvedValue({
      ...approved, formData: { ...approved.formData, worked_minutes: 420.5 },
    });
    await expect(attendance.getAttendanceCorrectionDecision(approved.id)).rejects.toMatchObject({
      response: { code: 'APPROVAL_ATTENDANCE_FORM_INVALID' },
    });
  });

  it('月结重开决定绑定员工、月份和前序快照，不返回审批其他字段', async () => {
    const deps = dependencies();
    const approved = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A2', status: 'approved',
      completedAt: '2026-05-02T00:00:00.000Z', formDataHash: 'b'.repeat(43),
      templateSnapshot: { templateCode: 'attendance_month_reopen' },
      formData: {
        employee_id: 'employee-001', month: '2026-04',
        previous_snapshot_id: '01J8ZQK7V0A2M4N6P8R0T2W4S1', reason_code: 'LATE_SOURCE',
      },
    } as unknown as ApprovalInstance;
    deps.instances.findById.mockResolvedValue(approved);
    const result = await service(
      deps, trustedContext(['erp:attendance:approval:sync']),
    ).getAttendanceMonthReopenDecision(approved.id);
    expect(result).toEqual({
      id: approved.id, completedAt: approved.completedAt, employeeId: 'employee-001',
      month: '2026-04', previousSnapshotId: '01J8ZQK7V0A2M4N6P8R0T2W4S1',
      formDataHash: 'b'.repeat(43),
    });
    expect(result).not.toHaveProperty('reasonCode');
  });

  it('工资审批终态只输出运行摘要绑定和最终决策人', async () => {
    const deps = dependencies();
    const completedAt = '2026-07-31T10:00:00.000Z';
    const approved = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A3', status: 'approved', completedAt,
      formDataHash: 'c'.repeat(43), templateSnapshot: { templateCode: 'payroll_period_approval' },
      formData: {
        period_id: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
        run_id: '01J8ZQK7V0A2M4N6P8R0T2W4P2',
        input_snapshot_hash: 'a'.repeat(43), result_hash: 'b'.repeat(43),
      },
      resolvedNodes: [{ decisions: [{
        decidedBy: 'finance-001', principalApproverId: 'finance-001',
        outcome: 'approved', decidedAt: completedAt, delegated: false,
      }] }],
    } as unknown as ApprovalInstance;
    deps.instances.findById.mockResolvedValue(approved);
    const result = await service(
      deps, trustedContext(['erp:payroll:approval:sync']),
    ).getPayrollPeriodDecision(approved.id);
    expect(result).toEqual({
      id: approved.id, outcome: 'approved', decidedBy: 'finance-001', completedAt,
      periodId: '01J8ZQK7V0A2M4N6P8R0T2W4P1', runId: '01J8ZQK7V0A2M4N6P8R0T2W4P2',
      inputSnapshotHash: 'a'.repeat(43), resultHash: 'b'.repeat(43),
      formDataHash: 'c'.repeat(43),
    });
  });

  it('资金账户审批只输出专用表单绑定和最终通过人，并复用调用方事务', async () => {
    const deps = dependencies();
    const approved = treasuryApprovedInstance();
    deps.instances.findById.mockResolvedValue(approved);
    const result = await service(
      deps,
      trustedContext(['erp:treasury:account:attest']),
    ).getTreasuryBankAccountDecision(approved.id, SESSION);
    expect(result).toEqual({
      id: approved.id,
      completedAt: approved.completedAt,
      approvedBy: 'finance-001',
      ownerType: 'employee',
      ownerId: 'employee-001',
      accountName: '张三',
      account: '6222000000000001',
      clearingCode: 'CNAPS001',
      currency: 'CNY',
      formDataHash: 't'.repeat(43),
    });
    expect(deps.instances.findById).toHaveBeenCalledWith(
      approved.id,
      SESSION,
    );
    expect(result).not.toHaveProperty('resolvedNodes');
  });

  it('资金账户审批读取对 Scope、模板、通过终态和最终决定失败关闭', async () => {
    await expect(service(dependencies()).getTreasuryBankAccountDecision(
      'instance-001',
      SESSION,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_TREASURY_INTEGRATION_STATUS_DENIED' },
    });

    const templateDeps = dependencies();
    templateDeps.instances.findById.mockResolvedValue(treasuryApprovedInstance({
      templateSnapshot: { templateCode: 'EXPENSE' },
    }));
    await expect(service(
      templateDeps,
      trustedContext(['erp:treasury:account:attest']),
    ).getTreasuryBankAccountDecision(
      'instance-001',
      SESSION,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_TREASURY_INTEGRATION_TEMPLATE_DENIED' },
    });

    const stateDeps = dependencies();
    stateDeps.instances.findById.mockResolvedValue(treasuryApprovedInstance({
      status: 'running',
      completedAt: null,
    }));
    await expect(service(
      stateDeps,
      trustedContext(['erp:treasury:account:attest']),
    ).getTreasuryBankAccountDecision(
      'instance-001',
      SESSION,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_TREASURY_DECISION_INCOMPLETE' },
    });

    const decisionDeps = dependencies();
    decisionDeps.instances.findById.mockResolvedValue(treasuryApprovedInstance({
      resolvedNodes: [{ decisions: [{
        decidedBy: 'finance-001',
        principalApproverId: 'finance-001',
        outcome: 'approved',
        decidedAt: '2026-07-19T00:00:00.000Z',
        delegated: false,
      }] }],
    }));
    await expect(service(
      decisionDeps,
      trustedContext(['erp:treasury:account:attest']),
    ).getTreasuryBankAccountDecision(
      'instance-001',
      SESSION,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_TREASURY_DECISION_INVALID' },
    });
  });

  it.each([
    ['owner_type', 'supplier'],
    ['owner_id', '/invalid'],
    ['account_name', '张三\u0000'],
    ['account', '1234'],
    ['clearing_code', 'cnaps001'],
    ['currency', 'USD'],
  ] as const)('资金账户审批拒绝非法或缺失的 %s 字段', async (field, value) => {
    const deps = dependencies();
    const approved = treasuryApprovedInstance();
    deps.instances.findById.mockResolvedValue(treasuryApprovedInstance({
      formData: { ...approved.formData, [field]: value },
    }));
    await expect(service(
      deps,
      trustedContext(['erp:treasury:account:attest']),
    ).getTreasuryBankAccountDecision(
      approved.id,
      SESSION,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_TREASURY_FORM_INVALID' },
    });
  });

  it('工资调整审批终态只输出固定控制摘要，不输出员工或金额', async () => {
    const deps = dependencies();
    const approved = payrollAdjustmentApprovedInstance();
    deps.instances.findById.mockResolvedValue(approved);
    const result = await service(
      deps, trustedContext(['erp:payroll:adjustment:approval:sync']),
    ).getPayrollAdjustmentDecision(approved.id);
    expect(result).toEqual({
      id: approved.id,
      outcome: 'approved',
      decidedBy: 'finance-002',
      completedAt: approved.completedAt,
      adjustmentId: '01J8ZQK7V0A2M4N6P8R0T2W4D1',
      adjustmentHash: 'a'.repeat(43),
      period: '2026-07',
      adjustmentType: 'supplement',
      reasonCode: 'RETROACTIVE_SALARY_CHANGE',
      formDataHash: 'd'.repeat(43),
    });
    expect(JSON.stringify(result)).not.toMatch(/employee|amount|payable|receivable/u);
  });

  it('工资调整审批同步对 Scope、模板、终态和决策链逐项失败关闭', async () => {
    const id = payrollAdjustmentApprovedInstance().id;
    const denied = dependencies();
    denied.instances.findById.mockResolvedValue(payrollAdjustmentApprovedInstance());
    await expect(service(denied).getPayrollAdjustmentDecision(id))
      .rejects.toMatchObject({
        response: { code: 'APPROVAL_PAYROLL_ADJUSTMENT_STATUS_DENIED' },
      });

    const cases = [
      [
        payrollAdjustmentApprovedInstance({
          templateSnapshot: { templateCode: 'payroll_period_approval' },
        }),
        'APPROVAL_PAYROLL_ADJUSTMENT_TEMPLATE_DENIED',
      ],
      [
        payrollAdjustmentApprovedInstance({ status: 'running', completedAt: null }),
        'APPROVAL_PAYROLL_ADJUSTMENT_INCOMPLETE',
      ],
      [
        payrollAdjustmentApprovedInstance({ status: 'approved', completedAt: null }),
        'APPROVAL_PAYROLL_ADJUSTMENT_INCOMPLETE',
      ],
      [
        payrollAdjustmentApprovedInstance({ resolvedNodes: [{ decisions: [] }] }),
        'APPROVAL_PAYROLL_ADJUSTMENT_DECISION_INVALID',
      ],
      [
        payrollAdjustmentApprovedInstance({
          resolvedNodes: [{ decisions: [{
            decidedBy: 'finance-002',
            principalApproverId: 'finance-002',
            outcome: 'approved',
            decidedAt: '2026-07-31T10:59:59.000Z',
            delegated: false,
          }] }],
        }),
        'APPROVAL_PAYROLL_ADJUSTMENT_DECISION_INVALID',
      ],
    ] as const;

    for (const [instance, code] of cases) {
      const deps = dependencies();
      deps.instances.findById.mockResolvedValue(instance);
      await expect(service(
        deps,
        trustedContext(['erp:payroll:adjustment:approval:sync']),
      ).getPayrollAdjustmentDecision(id)).rejects.toMatchObject({
        response: { code },
      });
    }
  });

  it('工资调整拒绝终态取最后一项可信决策并校验全部固定表单字段', async () => {
    const rejected = payrollAdjustmentApprovedInstance({
      status: 'rejected',
      completedAt: '2026-07-31T12:00:00.000Z',
      formData: {
        ...payrollAdjustmentApprovedInstance().formData,
        adjustment_type: 'reversal',
      },
      resolvedNodes: [
        { decisions: [{
          decidedBy: 'finance-001',
          principalApproverId: 'finance-001',
          outcome: 'rejected',
          decidedAt: '2026-07-31T11:00:00.000Z',
          delegated: false,
        }] },
        { decisions: [{
          decidedBy: 'finance-003',
          principalApproverId: 'finance-003',
          outcome: 'rejected',
          decidedAt: '2026-07-31T12:00:00.000Z',
          delegated: false,
        }] },
      ],
    });
    const deps = dependencies();
    deps.instances.findById.mockResolvedValue(rejected);
    await expect(service(
      deps,
      trustedContext(['erp:payroll:adjustment:approval:sync']),
    ).getPayrollAdjustmentDecision(rejected.id)).resolves.toMatchObject({
      outcome: 'rejected',
      decidedBy: 'finance-003',
      adjustmentType: 'reversal',
    });

    for (const [field, value] of [
      ['adjustment_id', 'invalid'],
      ['adjustment_hash', 'short'],
      ['period', '2026-13'],
      ['adjustment_type', 'other'],
      ['reason_code', 'lowercase'],
    ] as const) {
      const invalid = payrollAdjustmentApprovedInstance({
        formData: {
          ...payrollAdjustmentApprovedInstance().formData,
          [field]: value,
        },
      });
      const invalidDeps = dependencies();
      invalidDeps.instances.findById.mockResolvedValue(invalid);
      await expect(service(
        invalidDeps,
        trustedContext(['erp:payroll:adjustment:approval:sync']),
      ).getPayrollAdjustmentDecision(invalid.id)).rejects.toMatchObject({
        response: { code: 'APPROVAL_PAYROLL_FORM_INVALID' },
      });
    }
  });

  it('创建实例只返回脱敏摘要，聚合与事件共用幂等事务', async () => {
    const deps = dependencies();
    const result = await service(deps).createInstance('idempotency-key-001', {
      templateCode: 'EXPENSE', title: '费用申请', formData: { amount: 123_45 },
    });
    expect(result.instance).toMatchObject({
      status: 'draft', templateCode: 'EXPENSE', templateRevision: 1, riskLevel: 'R1', version: 1,
    });
    expect(result.instance).not.toHaveProperty('formData');
    expect(deps.instances.insert).toHaveBeenCalledWith(expect.objectContaining({
      formData: { amount: 123_45 },
    }), SESSION);
    expect(deps.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'approval_instance.draft_created',
    }), SESSION);
    expect(JSON.stringify(deps.outbox.append.mock.calls[0]?.[0])).not.toContain('费用申请');
  });

  it('提交在一个事务中更新聚合、追加动作和 Outbox', async () => {
    const deps = dependencies();
    deps.instances.findById.mockResolvedValue(draftInstance());
    const result = await service(deps).submitInstance('instance-001', 1, 'idempotency-key-002');
    expect(result.instance).toMatchObject({ status: 'running', version: 2 });
    expect(deps.instances.replace).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }), 1, SESSION);
    expect(deps.actions.append).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 }),
      expect.objectContaining({ type: 'instance.submitted' }),
      SESSION,
    );
    expect(deps.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_instance.submitted' }), SESSION,
    );
    expect(deps.notifications.append).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 }),
      expect.objectContaining({ type: 'instance.submitted' }),
      SESSION,
    );
  });

  it('未验证委托不能以他人主体审批', async () => {
    const deps = dependencies();
    const running = submitApprovalInstance(draftInstance(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      resolvedNodes: [{ nodeId: 'manager', actorIds: ['manager-001'] }],
    }, NOW).instance;
    deps.instances.findById.mockResolvedValue(running);
    await expect(service(deps).decideConfirmedInstance(
      'instance-001', 2, 'manager-001', 'approved', 'idempotency-key-003',
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.instances.replace).not.toHaveBeenCalled();
    expect(deps.actions.append).not.toHaveBeenCalled();
  });

  it('普通 REST 语义对 R2 决策、转交和加签全部失败关闭', async () => {
    const deps = dependencies();
    const running = submitApprovalInstance(draftInstance('EXPENSE_R2', 'R2'), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      resolvedNodes: [{ nodeId: 'manager', actorIds: ['manager-001'] }],
    }, NOW).instance;
    deps.instances.findById.mockResolvedValue(running);
    const approvals = service(
      deps,
      trustedContext(['erp:approval:task:add_signer'], 'manager-001'),
    );
    await expect(approvals.decideInteractiveInstance(
      'instance-001', 2, 'manager-001', 'approved', 'interactive-r2-decision',
    )).rejects.toMatchObject({ response: { code: 'APPROVAL_R2_STRONG_AUTH_REQUIRED' } });
    await expect(approvals.transferTask(
      'instance-001', 2, 'manager-001', 'manager-002', 'interactive-r2-transfer',
    )).rejects.toMatchObject({ response: { code: 'APPROVAL_R2_STRONG_AUTH_REQUIRED' } });
    await expect(approvals.addSigner(
      'instance-001', 2, 'manager-002', 'interactive-r2-add-signer',
    )).rejects.toMatchObject({ response: { code: 'APPROVAL_R2_STRONG_AUTH_REQUIRED' } });
    expect(deps.instances.replace).not.toHaveBeenCalled();
    expect(deps.actions.append).not.toHaveBeenCalled();

    await expect(approvals.decideConfirmedInstance(
      'instance-001', 2, 'manager-001', 'approved', 'confirmed-r2-decision',
    )).resolves.toMatchObject({ instance: { status: 'approved', version: 3 } });
    expect(deps.instances.replace).toHaveBeenCalledOnce();
    expect(deps.actions.append).toHaveBeenCalledOnce();
  });

  it('模板创建支持首版和连续修订并同步写入 Outbox', async () => {
    const firstDeps = dependencies();
    const first = await service(firstDeps).createTemplate('template-create-001', {
      code: 'EXPENSE',
      name: '费用审批',
      riskLevel: 'R1',
      definition: definition(),
    });
    expect(first.template).toMatchObject({ code: 'EXPENSE', revision: 1, status: 'draft' });
    expect(firstDeps.templates.insert).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1 }),
      SESSION,
    );
    expect(firstDeps.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_template.draft_created' }),
      SESSION,
    );

    const nextDeps = dependencies();
    nextDeps.templates.findLatestByCode.mockResolvedValue(template());
    const next = await service(nextDeps).createTemplate('template-create-002', {
      code: 'EXPENSE',
      name: '费用审批第二版',
      riskLevel: 'R2',
      definition: definition(),
    });
    expect(next.template).toMatchObject({ code: 'EXPENSE', revision: 2, status: 'draft' });
  });

  it('发布新模板时原子退役旧发布版本并生成两条事件', async () => {
    const previous = template();
    const current = createNextApprovalTemplateRevision(previous, {
      id: 'template-002',
      tenantId: 'tenant-001',
      name: '费用审批第二版',
      riskLevel: 'R2',
      definition: definition(),
      actorId: 'editor-002',
    }, NOW);
    const deps = dependencies();
    deps.templates.findById.mockResolvedValue(current);
    deps.templates.findPublishedByCode.mockResolvedValue(previous);

    const result = await service(deps).publishTemplate(
      current.id,
      current.version,
      'template-publish-001',
    );
    expect(result.template).toMatchObject({ id: current.id, status: 'published', revision: 2 });
    expect(deps.templates.replace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: previous.id, status: 'retired' }),
      previous.version,
      SESSION,
    );
    expect(deps.templates.replace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: current.id, status: 'published' }),
      current.version,
      SESSION,
    );
    expect(deps.outbox.append).toHaveBeenCalledTimes(2);
  });

  it('委托目录、创建和撤销均要求专用权限并返回最小投影', async () => {
    const current = createApprovalDelegation({
      id: 'delegation-001',
      tenantId: 'tenant-001',
      principalApproverId: 'actor-001',
      delegateId: 'actor-002',
      validFrom: NOW.toISOString(),
      validUntil: '2026-08-01T00:00:00.000Z',
      actorId: 'actor-001',
    }, NOW);
    const deps = dependencies();
    deps.delegations.findMine.mockResolvedValue([current]);
    deps.delegations.findById.mockResolvedValue(current);
    const approvals = service(
      deps,
      trustedContext([
        'erp:approval:delegation:read',
        'erp:approval:delegation:write',
      ]),
    );

    await expect(approvals.listMyDelegations()).resolves.toEqual([
      expect.objectContaining({
        id: current.id,
        principalApproverId: 'actor-001',
        delegateId: 'actor-002',
      }),
    ]);
    const validFrom = new Date(Date.now() + 60_000).toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();
    await expect(approvals.createDelegation('delegation-create-001', {
      delegateId: 'actor-002',
      validFrom,
      validUntil,
    })).resolves.toMatchObject({
      delegation: { status: 'active', delegateId: 'actor-002' },
    });
    await expect(approvals.revokeDelegation(
      current.id,
      current.version,
      'delegation-revoke-001',
    )).resolves.toMatchObject({
      delegation: { status: 'revoked', version: 2 },
    });
    expect(deps.delegations.insert).toHaveBeenCalledOnce();
    expect(deps.delegations.replace).toHaveBeenCalledOnce();
    expect(deps.outbox.append).toHaveBeenCalledTimes(2);
  });

  it('委托创建拒绝时间重叠，撤销拒绝不存在记录', async () => {
    const overlapDeps = dependencies();
    overlapDeps.delegations.hasOverlap.mockResolvedValue(true);
    overlapDeps.delegations.findById.mockResolvedValue(null);
    const approvals = service(
      overlapDeps,
      trustedContext(['erp:approval:delegation:write']),
    );
    await expect(approvals.createDelegation('delegation-overlap-001', {
      delegateId: 'actor-002',
      validFrom: new Date(Date.now() + 60_000).toISOString(),
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    })).rejects.toMatchObject({
      response: { code: 'APPROVAL_DELEGATION_OVERLAP' },
    });
    await expect(approvals.revokeDelegation(
      'missing',
      1,
      'delegation-revoke-missing',
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_DELEGATION_NOT_FOUND' },
    });
  });

  it('R1 转交、加签、撤回和归档复用同一事务转换出口', async () => {
    const transferDeps = dependencies();
    transferDeps.instances.findById.mockResolvedValue(runningInstance());
    const transferred = await service(
      transferDeps,
      trustedContext([], 'manager-001'),
    ).transferTask('instance-001', 2, 'manager-001', 'manager-002', 'transfer-001');
    expect(transferred.instance).toMatchObject({ status: 'running', version: 3 });

    const signerDeps = dependencies();
    signerDeps.instances.findById.mockResolvedValue(runningInstance());
    const signed = await service(
      signerDeps,
      trustedContext(['erp:approval:task:add_signer'], 'manager-001'),
    ).addSigner('instance-001', 2, 'manager-002', 'add-signer-001');
    expect(signed.instance).toMatchObject({ status: 'running', version: 3 });

    const withdrawDeps = dependencies();
    withdrawDeps.instances.findById.mockResolvedValue(runningInstance());
    const withdrawn = await service(withdrawDeps).withdrawInstance(
      'instance-001',
      2,
      'withdraw-001',
    );
    expect(withdrawn.instance).toMatchObject({ status: 'withdrawn', version: 3 });

    const running = runningInstance();
    const approved = decideApprovalInstance(running, {
      tenantId: 'tenant-001',
      expectedVersion: running.version,
      actorId: 'manager-001',
      principalApproverId: 'manager-001',
      delegationVerified: false,
      outcome: 'approved',
    }, NOW).instance;
    const archiveDeps = dependencies();
    archiveDeps.instances.findById.mockResolvedValue(approved);
    const archived = await service(
      archiveDeps,
      trustedContext(['erp:approval:instance:archive'], 'admin-001'),
    ).archiveInstance('instance-001', approved.version, 'archive-001');
    expect(archived.instance).toMatchObject({ status: 'archived', version: 4 });

    for (const deps of [transferDeps, signerDeps, withdrawDeps, archiveDeps]) {
      expect(deps.instances.replace).toHaveBeenCalledOnce();
      expect(deps.actions.append).toHaveBeenCalledOnce();
      expect(deps.outbox.append).toHaveBeenCalledOnce();
      expect(deps.notifications.append).toHaveBeenCalledOnce();
    }
  });

  it('收件箱只返回实例摘要且不暴露正文', async () => {
    const deps = dependencies();
    deps.instances.findInbox.mockResolvedValue([runningInstance()]);
    const result = await service(deps, trustedContext([], 'manager-001')).getInbox();
    expect(result).toEqual([
      expect.objectContaining({ status: 'running', templateCode: 'EXPENSE' }),
    ]);
    expect(result[0]).not.toHaveProperty('formData');
    expect(deps.instances.findInbox).toHaveBeenCalledWith('manager-001');
  });

  it('迁移引用校验对缺失、类型错配和未通过历史全部失败关闭', async () => {
    const attendanceDeps = dependencies();
    const attendance = service(
      attendanceDeps,
      opWorkerContext(['erp:migration:execute', 'erp:attendance:migration:write']),
    );
    for (const record of [
      null,
      { templateCode: 'other', outcome: 'approved' },
      { templateCode: 'attendance_correction', outcome: 'rejected' },
    ]) {
      attendanceDeps.legacyHistories.findById.mockResolvedValueOnce(record);
      await expect(attendance.verifyAttendanceCorrectionMigrationReference(
        'history-invalid',
        SESSION,
      )).rejects.toMatchObject({
        response: { code: 'APPROVAL_MIGRATION_ATTENDANCE_CORRECTION_REFERENCE_INVALID' },
      });
    }
    for (const record of [
      null,
      { templateCode: 'other', outcome: 'approved' },
      { templateCode: 'attendance_month_reopen', outcome: 'rejected' },
    ]) {
      attendanceDeps.legacyHistories.findById.mockResolvedValueOnce(record);
      await expect(attendance.verifyAttendanceMonthReopenMigrationReference(
        'history-invalid',
        SESSION,
      )).rejects.toMatchObject({
        response: { code: 'APPROVAL_MIGRATION_ATTENDANCE_REOPEN_REFERENCE_INVALID' },
      });
    }

    const payrollDeps = dependencies();
    const payroll = service(
      payrollDeps,
      opWorkerContext(['erp:migration:execute', 'erp:payroll:migration:write']),
    );
    for (const record of [
      null,
      { templateCode: 'other', outcome: 'approved' },
      { templateCode: 'payroll_compensation', outcome: 'rejected' },
    ]) {
      payrollDeps.legacyHistories.findById.mockResolvedValueOnce(record);
      await expect(payroll.verifyPayrollMigrationReference(
        'history-invalid',
        'payroll_compensation',
        SESSION,
      )).rejects.toMatchObject({
        response: { code: 'APPROVAL_MIGRATION_PAYROLL_REFERENCE_INVALID' },
      });
    }

    const treasuryDeps = dependencies();
    const treasury = service(
      treasuryDeps,
      opWorkerContext(['erp:migration:execute', 'erp:treasury:migration:write']),
    );
    for (const record of [
      null,
      { templateCode: 'other', outcome: 'approved' },
      { templateCode: 'treasury_bank_account_attestation', outcome: 'rejected' },
    ]) {
      treasuryDeps.legacyHistories.findById.mockResolvedValueOnce(record);
      await expect(treasury.verifyTreasuryMigrationReference(
        'history-invalid',
        'treasury_bank_account_attestation',
        SESSION,
      )).rejects.toMatchObject({
        response: { code: 'APPROVAL_MIGRATION_TREASURY_REFERENCE_INVALID' },
      });
    }
  });

  it('招聘迁移引用拒绝缺失、非运行实例和缺失终结历史', async () => {
    const deps = dependencies();
    deps.instances.findById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(draftInstance('recruitment_hc'));
    deps.legacyHistories.findById.mockResolvedValue(null);
    const approvals = service(
      deps,
      opWorkerContext(['erp:migration:execute', 'erp:recruitment:migration:write']),
    );
    await expect(approvals.verifyRecruitmentMigrationReference(
      'approval_instance',
      'missing',
      SESSION,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_MIGRATION_RECRUITMENT_REFERENCE_INVALID' },
    });
    await expect(approvals.verifyRecruitmentMigrationReference(
      'approval_instance',
      'draft',
      SESSION,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_MIGRATION_RECRUITMENT_REFERENCE_INVALID' },
    });
    await expect(approvals.verifyRecruitmentMigrationReference(
      'legacy_history',
      'missing',
      SESSION,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_MIGRATION_RECRUITMENT_REFERENCE_INVALID' },
    });
  });

  it('所有迁移只读校验均拒绝普通用户主体', async () => {
    const calls = [
      () => service(dependencies()).verifyRecruitmentMigrationReference(
        'legacy_history',
        'history-001',
        SESSION,
      ),
      () => service(dependencies()).verifyAttendanceCorrectionMigrationReference(
        'history-001',
        SESSION,
      ),
      () => service(dependencies()).verifyPayrollMigrationReference(
        'history-001',
        'payroll_compensation',
        SESSION,
      ),
      () => service(dependencies()).verifyTreasuryMigrationReference(
        'history-001',
        'treasury_bank_account_attestation',
        SESSION,
      ),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('创建审批与 OP 接入对缺失模板、身份和非法实例标识失败关闭', async () => {
    const createDeps = dependencies();
    createDeps.templates.findPublishedByCode.mockResolvedValue(null);
    await expect(service(createDeps).createInstance('create-missing-template', {
      templateCode: 'MISSING',
      title: '缺失模板',
      formData: { amount: 100 },
    })).rejects.toMatchObject({
      response: { code: 'APPROVAL_TEMPLATE_NOT_FOUND' },
    });

    const baseInput = {
      instanceId: '01K00000000000000000000009',
      templateCode: 'EXPENSE',
      title: 'OP 费用申请',
      formData: { amount: 100 },
      initiatorEmployeeId: 'employee-op-001',
      sourceDocumentType: 'expense_claim',
      sourceDocumentId: 'expense-009',
    };
    await expect(service(dependencies(), opWorkerContext()).createAndSubmitFromOp(
      'op-invalid-id',
      { ...baseInput, instanceId: 'invalid' },
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_OP_INSTANCE_ID_INVALID' },
    });

    const missingActor = dependencies();
    missingActor.profiles.findActorIdByEmployee.mockResolvedValue(null as never);
    await expect(service(missingActor, opWorkerContext()).createAndSubmitFromOp(
      'op-missing-actor',
      baseInput,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_OP_INITIATOR_NOT_FOUND' },
    });

    const inactive = dependencies();
    inactive.profiles.resolveActive.mockResolvedValue(null as never);
    await expect(service(inactive, opWorkerContext()).createAndSubmitFromOp(
      'op-inactive-actor',
      baseInput,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_OP_INITIATOR_INACTIVE' },
    });

    const missingTemplate = dependencies();
    missingTemplate.templates.findPublishedByCode.mockResolvedValue(null);
    await expect(service(missingTemplate, opWorkerContext()).createAndSubmitFromOp(
      'op-missing-template',
      baseInput,
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_TEMPLATE_NOT_FOUND' },
    });
  });

  it('资源缺失、停用主体和权限不足均返回稳定错误码', async () => {
    const missingTemplate = dependencies();
    missingTemplate.templates.findById.mockResolvedValue(null);
    await expect(service(missingTemplate).publishTemplate(
      'missing',
      1,
      'publish-missing',
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_TEMPLATE_NOT_FOUND' },
    });

    const missingInstance = dependencies();
    missingInstance.instances.findById.mockResolvedValue(null);
    await expect(service(missingInstance).submitInstance(
      'missing',
      1,
      'submit-missing',
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_INSTANCE_NOT_FOUND' },
    });

    const inactive = dependencies();
    inactive.profiles.resolveActive.mockResolvedValue(null as never);
    await expect(service(inactive).createInstance('create-inactive', {
      templateCode: 'EXPENSE',
      title: '停用主体',
      formData: { amount: 100 },
    })).rejects.toMatchObject({
      response: { code: 'APPROVAL_ACTOR_INACTIVE' },
    });
    await expect(service(dependencies()).listMyDelegations())
      .rejects.toMatchObject({ response: { code: 'APPROVAL_SCOPE_DENIED' } });
  });

  it('仓储版本冲突、唯一冲突和领域版本冲突映射为稳定冲突响应', async () => {
    const versionConflict = dependencies();
    versionConflict.templates.insert.mockRejectedValue(new ApprovalWriteConflictError());
    await expect(service(versionConflict).createTemplate('template-version-conflict', {
      code: 'EXPENSE',
      name: '费用审批',
      riskLevel: 'R1',
      definition: definition(),
    })).rejects.toMatchObject({
      response: { code: 'APPROVAL_VERSION_CONFLICT' },
    });

    const uniqueConflict = dependencies();
    uniqueConflict.templates.insert.mockRejectedValue({ code: 11000 });
    await expect(service(uniqueConflict).createTemplate('template-unique-conflict', {
      code: 'EXPENSE',
      name: '费用审批',
      riskLevel: 'R1',
      definition: definition(),
    })).rejects.toMatchObject({
      response: { code: 'APPROVAL_UNIQUE_CONFLICT' },
    });

    await expect(service(dependencies()).publishTemplate(
      'template-001',
      999,
      'template-domain-version-conflict',
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_VERSION_CONFLICT' },
    });
  });

  it('模板和旧历史迁移对同证据幂等返回，对内容变化拒绝覆盖', async () => {
    const templateInput = {
      code: 'LEGACY_EXPENSE',
      name: '历史费用审批',
      riskLevel: 'R2' as const,
      revision: 1,
      status: 'published' as const,
      definition: definition(),
      createdByEmployeeId: 'employee-editor',
      updatedByEmployeeId: 'employee-approver',
      approvedByEmployeeId: 'employee-approver',
      publishedAt: '2020-01-02T00:00:00.000Z',
      retiredAt: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-02T00:00:00.000Z',
    };
    const templateDeps = dependencies();
    const templateService = service(
      templateDeps,
      opWorkerContext(['erp:migration:execute', 'erp:approval:migration:write']),
    );
    const firstTemplate = await templateService.importTemplateFromMigration(
      'migration-template-first',
      templateInput,
    );
    templateDeps.templates.findByCodeAndRevision.mockResolvedValue(firstTemplate.template);
    await expect(templateService.importTemplateFromMigration(
      'migration-template-replay',
      templateInput,
    )).resolves.toEqual(firstTemplate);
    await expect(templateService.importTemplateFromMigration(
      'migration-template-conflict',
      { ...templateInput, name: '篡改名称' },
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_MIGRATION_TEMPLATE_IMMUTABLE' },
    });

    const historyInput = {
      templateId: 'template-001',
      templateCode: 'EXPENSE',
      templateRevision: 1,
      initiatorEmployeeId: 'employee-initiator',
      outcome: 'approved' as const,
      completedAt: '2020-01-02T00:00:00.000Z',
      archivedAt: null,
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/history-idempotent',
      evidenceChecksum: 'z'.repeat(43),
    };
    const historyDeps = dependencies();
    historyDeps.templates.findByCodeAndRevision.mockResolvedValue(template());
    const historyService = service(
      historyDeps,
      opWorkerContext(['erp:migration:execute', 'erp:approval:migration:write']),
    );
    const firstHistory = await historyService.importLegacyHistoryFromMigration(
      'migration-history-first',
      historyInput,
    );
    historyDeps.legacyHistories.findByEvidenceRef.mockResolvedValue(firstHistory.history);
    await expect(historyService.importLegacyHistoryFromMigration(
      'migration-history-replay',
      historyInput,
    )).resolves.toEqual(firstHistory);
    await expect(historyService.importLegacyHistoryFromMigration(
      'migration-history-conflict',
      { ...historyInput, outcome: 'rejected' },
    )).rejects.toMatchObject({
      response: { code: 'APPROVAL_MIGRATION_HISTORY_IMMUTABLE' },
    });
  });

  it('Offer、Care、考勤和工资集成对 Scope、模板与终态错配失败关闭', async () => {
    const offerDeps = dependencies();
    offerDeps.instances.findById.mockResolvedValue(draftInstance());
    await expect(service(
      offerDeps,
      trustedContext(['erp:recruitment:offer:sync_approval']),
    ).getInstanceStatusForRecruitmentOffer('instance-001')).rejects.toMatchObject({
      response: { code: 'APPROVAL_OFFER_INTEGRATION_TEMPLATE_DENIED' },
    });

    const careDeps = dependencies();
    careDeps.instances.findById.mockResolvedValue(draftInstance());
    await expect(service(
      careDeps,
      trustedContext(['erp:care:approval:sync']),
    ).getInstanceStatusForCare('instance-001')).rejects.toMatchObject({
      response: { code: 'APPROVAL_CARE_INTEGRATION_TEMPLATE_DENIED' },
    });

    await expect(service(dependencies()).getPayrollPeriodDecision('instance-001'))
      .rejects.toMatchObject({
        response: { code: 'APPROVAL_PAYROLL_INTEGRATION_STATUS_DENIED' },
      });
    const payrollTemplateDeps = dependencies();
    payrollTemplateDeps.instances.findById.mockResolvedValue(draftInstance());
    await expect(service(
      payrollTemplateDeps,
      trustedContext(['erp:payroll:approval:sync']),
    ).getPayrollPeriodDecision('instance-001')).rejects.toMatchObject({
      response: { code: 'APPROVAL_PAYROLL_INTEGRATION_TEMPLATE_DENIED' },
    });
    const payrollStateDeps = dependencies();
    payrollStateDeps.instances.findById.mockResolvedValue(
      draftInstance('payroll_period_approval'),
    );
    await expect(service(
      payrollStateDeps,
      trustedContext(['erp:payroll:approval:sync']),
    ).getPayrollPeriodDecision('instance-001')).rejects.toMatchObject({
      response: { code: 'APPROVAL_PAYROLL_DECISION_INCOMPLETE' },
    });

    await expect(service(dependencies()).getAttendanceCorrectionDecision('instance-001'))
      .rejects.toMatchObject({
        response: { code: 'APPROVAL_ATTENDANCE_INTEGRATION_STATUS_DENIED' },
      });
    const attendanceTemplateDeps = dependencies();
    attendanceTemplateDeps.instances.findById.mockResolvedValue(draftInstance());
    await expect(service(
      attendanceTemplateDeps,
      trustedContext(['erp:attendance:approval:sync']),
    ).getAttendanceCorrectionDecision('instance-001')).rejects.toMatchObject({
      response: { code: 'APPROVAL_ATTENDANCE_INTEGRATION_TEMPLATE_DENIED' },
    });
    const attendanceStateDeps = dependencies();
    attendanceStateDeps.instances.findById.mockResolvedValue(
      draftInstance('attendance_correction'),
    );
    await expect(service(
      attendanceStateDeps,
      trustedContext(['erp:attendance:approval:sync']),
    ).getAttendanceCorrectionDecision('instance-001')).rejects.toMatchObject({
      response: { code: 'APPROVAL_ATTENDANCE_DECISION_INCOMPLETE' },
    });
  });

  it('普通审批人读取时 L3/L4 字段脱敏，L1/L2 保留', async () => {
    const deps = dependencies();
    const running = submitApprovalInstance(draftInstance(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      resolvedNodes: [{ nodeId: 'manager', actorIds: ['manager-001'] }],
    }, NOW).instance;
    deps.instances.findById.mockResolvedValue(running);
    const view = await service(deps, trustedContext([], 'manager-001')).getInstance('instance-001');
    expect(view.formData).toEqual({ amount: 123_45, remark: { redacted: true } });
    expect(view).not.toHaveProperty('templateSnapshot');
    expect(view).not.toHaveProperty('resolvedNodes');
  });
});
