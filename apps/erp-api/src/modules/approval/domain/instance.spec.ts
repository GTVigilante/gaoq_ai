import { describe, expect, it } from 'vitest';

import {
  addApprovalSigner,
  archiveApprovalInstance,
  createApprovalInstanceDraft,
  createApprovalInstanceDraftFromMigration,
  currentApprovalNode,
  decideApprovalInstance,
  submitApprovalInstance,
  transferApprovalTask,
  updateApprovalInstanceDraft,
  withdrawApprovalInstance,
  type ApprovalInstance,
} from './instance.js';
import {
  createApprovalTemplateDraft,
  publishApprovalTemplate,
  retireApprovalTemplate,
  type ApprovalTemplate,
  type ApprovalTemplateDefinition,
} from './template.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const LATER = new Date('2026-07-21T01:00:00.000Z');

function definition(): ApprovalTemplateDefinition {
  return {
    fields: [
      { key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' },
    ],
    nodes: [
      {
        id: 'manager', name: '经理会签', type: 'approval', approvalMode: 'all',
        resolver: { type: 'employees', employeeIds: ['manager-001', 'manager-002'] },
      },
      {
        id: 'copy', name: '知会财务', type: 'copy',
        resolver: { type: 'roles', roleCodes: ['FINANCE_VIEWER'], scope: 'tenant' },
      },
      {
        id: 'finance', name: '财务或签', type: 'approval', approvalMode: 'any',
        resolver: { type: 'roles', roleCodes: ['FINANCE_APPROVER'], scope: 'tenant' },
        condition: { op: 'gte', field: 'amount', value: 100_00 },
      },
    ],
  };
}

function publishedTemplate(riskLevel: 'R1' | 'R2' = 'R1'): ApprovalTemplate {
  const draft = createApprovalTemplateDraft({
    id: `template-${riskLevel}`, tenantId: 'tenant-001', code: `EXPENSE_${riskLevel}`,
    name: '费用审批', riskLevel, definition: definition(), actorId: 'editor-001',
  }, NOW);
  return publishApprovalTemplate(draft, {
    tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
  }, NOW);
}

function instance(riskLevel: 'R1' | 'R2' = 'R1', amount = 200_00): ApprovalInstance {
  return createApprovalInstanceDraft({
    id: 'instance-001', tenantId: 'tenant-001', title: '差旅费用', initiatorId: 'employee-001',
    template: publishedTemplate(riskLevel), formData: { amount },
  }, NOW);
}

function submit(draft = instance()): ApprovalInstance {
  return submitApprovalInstance(draft, {
    tenantId: 'tenant-001', expectedVersion: draft.version, actorId: 'employee-001',
    resolvedNodes: [
      { nodeId: 'manager', actorIds: ['manager-001', 'manager-002'] },
      { nodeId: 'copy', actorIds: ['finance-viewer-001'] },
      { nodeId: 'finance', actorIds: ['finance-001', 'finance-002'] },
    ],
  }, LATER).instance;
}

function decide(
  running: ApprovalInstance,
  principalApproverId: string,
  outcome: 'approved' | 'rejected' = 'approved',
  actorId = principalApproverId,
  delegationVerified = false,
): ApprovalInstance {
  return decideApprovalInstance(running, {
    tenantId: 'tenant-001', expectedVersion: running.version, actorId, principalApproverId,
    delegationVerified, outcome,
  }, LATER).instance;
}

describe('审批实例提交与快照', () => {
  it('迁移可按历史时点引用现已退役模板，但拒绝生命周期之外的实例', () => {
    const published = publishedTemplate();
    const retired = retireApprovalTemplate(published, {
      tenantId: 'tenant-001', expectedVersion: published.version, actorId: 'publisher-001',
    }, LATER);
    const migrated = createApprovalInstanceDraftFromMigration({
      id: 'instance-migrated-001', tenantId: 'tenant-001', title: '历史活动审批',
      initiatorId: 'employee-001', template: retired, formData: { amount: 200_00 },
      createdAt: '2026-07-21T00:30:00.000Z',
    });
    expect(migrated).toMatchObject({
      status: 'draft', createdAt: '2026-07-21T00:30:00.000Z', version: 1,
    });
    expect(() => createApprovalInstanceDraftFromMigration({
      id: 'instance-migrated-002', tenantId: 'tenant-001', title: '越界历史审批',
      initiatorId: 'employee-001', template: retired, formData: { amount: 200_00 },
      createdAt: '2026-07-21T02:00:00.000Z',
    })).toThrowError(expect.objectContaining({
      code: 'APPROVAL_MIGRATION_INSTANCE_TEMPLATE_LIFECYCLE_INVALID',
    }));
  });

  it('创建草稿即固定模板和表单快照，提交后固定条件命中节点及审批人', () => {
    const draft = instance();
    const running = submit(draft);
    expect(running).toMatchObject({
      status: 'running', currentNodeIndex: 0, version: 2,
      formDataHash: draft.formDataHash,
    });
    expect(running.resolvedNodes.map((node) => node.id)).toEqual(['manager', 'copy', 'finance']);
    expect(Object.isFrozen(running.resolvedNodes[0]?.actorIds)).toBe(true);
  });

  it('条件未命中节点不可伪造，漏传解析结果也被拒绝', () => {
    const lowAmount = instance('R1', 50_00);
    expect(() => submitApprovalInstance(lowAmount, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'employee-001',
      resolvedNodes: [
        { nodeId: 'manager', actorIds: ['manager-001'] },
        { nodeId: 'copy', actorIds: ['finance-viewer-001'] },
        { nodeId: 'finance', actorIds: ['finance-001'] },
      ],
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_RESOLUTION_MISMATCH' }));
  });

  it('抄送无人不阻断业务流程，审批节点无人则失败关闭', () => {
    const draft = instance();
    const running = submitApprovalInstance(draft, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'employee-001',
      resolvedNodes: [
        { nodeId: 'manager', actorIds: ['manager-001'] },
        { nodeId: 'copy', actorIds: [] },
        { nodeId: 'finance', actorIds: ['finance-001'] },
      ],
    }, LATER).instance;
    expect(running.resolvedNodes[1]?.actorIds).toEqual([]);
    expect(() => submitApprovalInstance(draft, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'employee-001',
      resolvedNodes: [
        { nodeId: 'manager', actorIds: [] },
        { nodeId: 'copy', actorIds: [] },
        { nodeId: 'finance', actorIds: ['finance-001'] },
      ],
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_RESOLUTION_INVALID' }));
  });

  it('R2 在解析、转交和加签时均禁止发起人自批', () => {
    const draft = instance('R2');
    expect(() => submitApprovalInstance(draft, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'employee-001',
      resolvedNodes: [
        { nodeId: 'manager', actorIds: ['employee-001'] },
        { nodeId: 'copy', actorIds: ['finance-viewer-001'] },
        { nodeId: 'finance', actorIds: ['finance-001'] },
      ],
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_R2_SELF_APPROVAL_DENIED' }));
  });

  it('草稿只有发起人可改且并发版本、租户均强制校验', () => {
    const draft = instance();
    expect(() => updateApprovalInstanceDraft(draft, {
      tenantId: 'tenant-002', expectedVersion: 1, actorId: 'employee-001',
      title: '越权', formData: { amount: 1 },
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_TENANT_MISMATCH' }));
    expect(() => updateApprovalInstanceDraft(draft, {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'employee-001',
      title: '旧版本', formData: { amount: 1 },
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_VERSION_CONFLICT' }));
    expect(() => updateApprovalInstanceDraft(draft, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'employee-002',
      title: '冒用发起人', formData: { amount: 1 },
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_DRAFT_UPDATE_DENIED' }));
  });
});

describe('会签、或签与任务变更', () => {
  it('会签全员通过后跳过抄送进入或签，或签一人通过即整体通过', () => {
    const firstApproved = decide(submit(), 'manager-001');
    expect(currentApprovalNode(firstApproved)?.id).toBe('manager');
    const managerPassed = decide(firstApproved, 'manager-002');
    expect(currentApprovalNode(managerPassed)?.id).toBe('finance');
    const rejectedByOne = decide(managerPassed, 'finance-001', 'rejected');
    expect(rejectedByOne.status).toBe('running');
    const approved = decide(rejectedByOne, 'finance-002');
    expect(approved).toMatchObject({ status: 'approved', currentNodeIndex: null });
    expect(approved.completedAt).not.toBeNull();
  });

  it('会签任一拒绝立即拒绝；同一主体不能重复决策', () => {
    const rejected = decide(submit(), 'manager-001', 'rejected');
    expect(rejected.status).toBe('rejected');

    const once = decide(submit(), 'manager-001');
    expect(() => decide(once, 'manager-001')).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_ALREADY_DECIDED' }),
    );
  });

  it('代理审批必须先由应用层验证有效委托，动作保留实际人与主体人', () => {
    const running = submit();
    expect(() => decide(running, 'manager-001', 'approved', 'delegate-001')).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_DELEGATION_REQUIRED' }),
    );
    const result = decideApprovalInstance(running, {
      tenantId: 'tenant-001', expectedVersion: running.version,
      actorId: 'delegate-001', principalApproverId: 'manager-001',
      delegationVerified: true, outcome: 'approved',
    }, LATER);
    expect(result.instance.resolvedNodes[0]?.decisions[0]).toMatchObject({
      decidedBy: 'delegate-001', principalApproverId: 'manager-001', delegated: true,
    });
    expect(result.action).toMatchObject({ actorId: 'delegate-001', delegated: true });
  });

  it('转交替换未决主体且防重复；加签仅授权的当前会签节点允许', () => {
    const running = submit();
    const transferred = transferApprovalTask(running, {
      tenantId: 'tenant-001', expectedVersion: running.version, actorId: 'manager-001',
      fromApproverId: 'manager-001', toApproverId: 'manager-003', delegationVerified: false,
    }, LATER).instance;
    expect(currentApprovalNode(transferred)?.actorIds).toEqual(['manager-003', 'manager-002']);
    expect(() => transferApprovalTask(transferred, {
      tenantId: 'tenant-001', expectedVersion: transferred.version, actorId: 'manager-003',
      fromApproverId: 'manager-003', toApproverId: 'manager-002', delegationVerified: false,
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_TRANSFER_DUPLICATE' }));

    expect(() => addApprovalSigner(running, {
      tenantId: 'tenant-001', expectedVersion: running.version, actorId: 'manager-001',
      approverId: 'manager-003', authorizationVerified: false,
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_ADD_SIGNER_DENIED' }));
    const added = addApprovalSigner(running, {
      tenantId: 'tenant-001', expectedVersion: running.version, actorId: 'manager-001',
      approverId: 'manager-003', authorizationVerified: true,
    }, LATER).instance;
    expect(currentApprovalNode(added)?.actorIds).toContain('manager-003');
  });
});

describe('撤回、归档与终态', () => {
  it('只有发起人可从草稿或运行态撤回，授权主体可归档终态', () => {
    expect(() => withdrawApprovalInstance(submit(), {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'employee-002',
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_WITHDRAW_DENIED' }));
    const withdrawn = withdrawApprovalInstance(submit(), {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'employee-001',
    }, LATER).instance;
    expect(withdrawn.status).toBe('withdrawn');
    expect(() => archiveApprovalInstance(withdrawn, {
      tenantId: 'tenant-001', expectedVersion: withdrawn.version,
      actorId: 'records-001', authorizationVerified: false,
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_ARCHIVE_DENIED' }));
    const archived = archiveApprovalInstance(withdrawn, {
      tenantId: 'tenant-001', expectedVersion: withdrawn.version,
      actorId: 'records-001', authorizationVerified: true,
    }, LATER).instance;
    expect(archived).toMatchObject({ status: 'archived', currentNodeIndex: null });
    expect(() => withdrawApprovalInstance(archived, {
      tenantId: 'tenant-001', expectedVersion: archived.version, actorId: 'employee-001',
    }, LATER)).toThrowError(expect.objectContaining({ code: 'APPROVAL_WITHDRAW_DENIED' }));
  });
});
