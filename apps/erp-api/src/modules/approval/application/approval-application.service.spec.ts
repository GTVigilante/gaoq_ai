import { ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import {
  createApprovalInstanceDraft,
  createApprovalTemplateDraft,
  publishApprovalTemplate,
  submitApprovalInstance,
  type ApprovalTemplateDefinition,
  type ApprovalInstance,
} from '../domain/index.js';
import type {
  ApprovalActionRepository,
  ApprovalDelegationRepository,
  ApprovalInstanceRepository,
  ApprovalTemplateRepository,
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

function template(code = 'EXPENSE') {
  const draft = createApprovalTemplateDraft({
    id: 'template-001', tenantId: 'tenant-001', code, name: '费用审批',
    riskLevel: 'R1', definition: definition(), actorId: 'editor-001',
  }, NOW);
  return publishApprovalTemplate(draft, {
    tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
  }, NOW);
}

function draftInstance(templateCode = 'EXPENSE') {
  return createApprovalInstanceDraft({
    id: 'instance-001', tenantId: 'tenant-001', title: '费用申请', initiatorId: 'actor-001',
    template: template(templateCode), formData: { amount: 123_45, remark: '仅财务可见' },
  }, NOW);
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
    profiles: { resolveActive: vi.fn().mockResolvedValue({ actorId: 'actor-001' }) },
    templates: {
      findPublishedByCode: vi.fn().mockResolvedValue(template()),
      findLatestByCode: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(template()),
      insert: vi.fn(),
      replace: vi.fn(),
    },
    instances: { findById: vi.fn(), insert: vi.fn(), replace: vi.fn(), findInbox: vi.fn() },
    actions: { append: vi.fn() },
    delegations: { isActive: vi.fn().mockResolvedValue(false) },
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
    deps.instances as unknown as ApprovalInstanceRepository,
    deps.actions as unknown as ApprovalActionRepository,
    deps.delegations as unknown as ApprovalDelegationRepository,
    deps.resolvers as unknown as ApprovalActorResolverService,
    deps.outbox as unknown as ApprovalOutboxWriter,
    deps.notifications as unknown as ApprovalNotificationWriter,
  );
}

describe('ApprovalApplicationService', () => {
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
    await expect(service(deps).decideInstance(
      'instance-001', 2, 'manager-001', 'approved', 'idempotency-key-003',
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.instances.replace).not.toHaveBeenCalled();
    expect(deps.actions.append).not.toHaveBeenCalled();
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
