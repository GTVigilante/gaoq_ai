import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  ApprovalActionRecordSchema,
  ApprovalDelegationRecordSchema,
  ApprovalInstanceRecordSchema,
  ApprovalLegacyHistoryRecordSchema,
  ApprovalTemplateRecordSchema,
  type ApprovalActionRecord,
  type ApprovalDelegationRecord,
  type ApprovalInstanceRecord,
  type ApprovalLegacyHistoryRecord,
  type ApprovalTemplateRecord,
} from './approval.schemas.js';

const mongoose = new Mongoose();
const TemplateModel = mongoose.model<ApprovalTemplateRecord>('SpecApprovalTemplate', ApprovalTemplateRecordSchema);
const InstanceModel = mongoose.model<ApprovalInstanceRecord>('SpecApprovalInstance', ApprovalInstanceRecordSchema);
const LegacyHistoryModel = mongoose.model<ApprovalLegacyHistoryRecord>(
  'SpecApprovalLegacyHistory',
  ApprovalLegacyHistoryRecordSchema,
);
const ActionModel = mongoose.model<ApprovalActionRecord>('SpecApprovalAction', ApprovalActionRecordSchema);
const DelegationModel = mongoose.model<ApprovalDelegationRecord>('SpecApprovalDelegation', ApprovalDelegationRecordSchema);

const NOW = new Date('2026-07-21T00:00:00.000Z');

async function valid(document: unknown): Promise<void> {
  await (document as { validate(): Promise<void> }).validate();
}

async function invalid(document: unknown, message: string): Promise<void> {
  await expect((document as { validate(): Promise<void> }).validate()).rejects.toThrowError(
    new RegExp(message),
  );
}

function template(): Record<string, unknown> {
  return {
    id: 'template-001', tenantId: 'tenant-001', code: 'EXPENSE', name: '费用审批',
    riskLevel: 'R2', revision: 1, status: 'draft', definitionJson: '{"fields":[],"nodes":[]}',
    definitionHash: 'a'.repeat(43), approvedBy: null, publishedAt: null, retiredAt: null,
    version: 1, createdBy: 'editor-001', updatedBy: 'editor-001',
  };
}

function instance(): Record<string, unknown> {
  return {
    id: 'instance-001', tenantId: 'tenant-001', title: '费用申请', initiatorId: 'employee-001',
    status: 'draft', templateId: 'template-001', templateCode: 'EXPENSE', templateRevision: 1,
    riskLevel: 'R2', templateSnapshotJson: '{"templateId":"template-001"}',
    formDataHash: 'b'.repeat(43), formDataKeyId: 'approval-key-001',
    formDataIv: 'a'.repeat(16), formDataCiphertext: 'c'.repeat(32), formDataAuthTag: 'd'.repeat(22),
    resolvedNodesJson: '{"nodes":[]}', currentNodeIndex: null, currentActorIds: [], version: 1,
    submittedAt: null, completedAt: null, archivedAt: null,
  };
}

function action(): Record<string, unknown> {
  return {
    actionId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6', tenantId: 'tenant-001',
    instanceId: 'instance-001', aggregateVersion: 2, actionType: 'instance.submitted',
    actorId: 'employee-001', principalApproverId: null, nodeId: null, outcome: null,
    resultingStatus: null, delegated: false, fromApproverId: null, toApproverId: null,
    addedApproverId: null, canceledApproverIds: [], occurredAt: NOW,
  };
}

describe('审批持久化 Schema', () => {
  it('模板状态与发布字段保持一致', async () => {
    await valid(new TemplateModel(template()));
    await invalid(new TemplateModel({ ...template(), status: 'published' }), '必须包含审批人');
    await valid(new TemplateModel({
      ...template(), status: 'published', approvedBy: 'publisher-001', publishedAt: NOW,
    }));
    await invalid(new TemplateModel({
      ...template(), approvedBy: 'publisher-001', publishedAt: NOW,
    }), '草稿模板不能包含发布审批信息');
    await invalid(new TemplateModel({
      ...template(), status: 'published', approvedBy: 'publisher-001',
      publishedAt: NOW, retiredAt: NOW,
    }), '未退役模板不能包含退役时间');
    await invalid(new TemplateModel({
      ...template(), status: 'retired', approvedBy: 'publisher-001', publishedAt: NOW,
    }), '退役模板必须包含退役时间');
    await valid(new TemplateModel({
      ...template(), status: 'retired', approvedBy: 'publisher-001',
      publishedAt: NOW, retiredAt: NOW,
    }));
  });

  it('实例只接受密文字段并校验运行态/终态不变量', async () => {
    await valid(new InstanceModel(instance()));
    expect(ApprovalInstanceRecordSchema.path('formData')).toBeUndefined();
    await invalid(new InstanceModel({
      ...instance(), status: 'running', submittedAt: NOW, currentNodeIndex: 0, currentActorIds: [],
    }), '当前节点字段不完整');
    await valid(new InstanceModel({
      ...instance(), status: 'running', submittedAt: NOW, currentNodeIndex: 0,
      currentActorIds: ['manager-001'], version: 2,
    }));
    await invalid(new InstanceModel({
      ...instance(), status: 'approved', submittedAt: NOW, completedAt: NOW,
      currentActorIds: ['manager-001'],
    }), '终态不能保留当前待办');
    await invalid(new InstanceModel({
      ...instance(), currentNodeIndex: 0,
    }), '草稿审批不能包含运行态字段');
    await invalid(new InstanceModel({
      ...instance(), status: 'withdrawn',
    }), '业务终态必须包含完成时间');
    await invalid(new InstanceModel({
      ...instance(), status: 'approved', completedAt: NOW,
    }), '通过或拒绝必须包含提交时间');
    await invalid(new InstanceModel({
      ...instance(), status: 'archived', completedAt: NOW,
    }), '归档审批必须包含归档时间');
    await valid(new InstanceModel({
      ...instance(), status: 'withdrawn', completedAt: NOW,
    }));
  });

  it('旧审批历史只接受最小不可变字段与迁移账本证据引用', async () => {
    const history = {
      id: 'history-001', tenantId: 'tenant-001', templateId: 'template-001',
      templateCode: 'EXPENSE', templateRevision: 1,
      initiatorEmployeeId: 'employee-001', outcome: 'approved', completedAt: NOW,
      archivedAt: null,
      migrationEvidenceRef:
        'erp://data-migrations/runs/01J8ZQK7V0A2M4N6P8R0T2W4F1/attachments/history-file-001',
      evidenceChecksum: 'a'.repeat(43), version: 1,
    };
    await valid(new LegacyHistoryModel(history));
    await invalid(new LegacyHistoryModel({
      ...history, migrationEvidenceRef: 'worm://history-file-001',
    }), 'migrationEvidenceRef');
    await invalid(new LegacyHistoryModel({
      ...history, archivedAt: new Date('2026-07-20T00:00:00.000Z'),
    }), '归档时间不能早于完成时间');
    expect(ApprovalLegacyHistoryRecordSchema.path('formData')).toBeUndefined();
    expect(ApprovalLegacyHistoryRecordSchema.path('title')).toBeUndefined();
  });

  it('动作日志拒绝不完整决策和非决策动作夹带决策字段', async () => {
    await valid(new ActionModel(action()));
    await invalid(new ActionModel({
      ...action(), actionType: 'instance.decided', nodeId: 'manager',
    }), '决策动作字段不完整');
    await invalid(new ActionModel({
      ...action(), principalApproverId: 'manager-001',
    }), '非决策动作不能包含决策字段');
    const decided = {
      ...action(), actionType: 'instance.decided', nodeId: 'manager',
      principalApproverId: 'manager-001', outcome: 'approved',
      resultingStatus: 'approved',
    };
    await valid(new ActionModel(decided));
    for (const field of ['nodeId', 'principalApproverId', 'outcome', 'resultingStatus']) {
      await invalid(new ActionModel({ ...decided, [field]: null }), '决策动作字段不完整');
    }
    await invalid(new ActionModel({ ...action(), outcome: 'approved' }),
      '非决策动作不能包含决策字段');
    await invalid(new ActionModel({ ...action(), delegated: true }),
      '非决策动作不能包含决策字段');
    for (const field of ['nodeId', 'fromApproverId', 'toApproverId']) {
      await invalid(new ActionModel({
        ...action(), actionType: 'instance.approver_transferred',
        nodeId: 'manager', fromApproverId: 'manager-001', toApproverId: 'manager-002',
        [field]: null,
      }), '转交动作字段不完整');
    }
    await valid(new ActionModel({
      ...action(), actionType: 'instance.approver_transferred',
      nodeId: 'manager', fromApproverId: 'manager-001', toApproverId: 'manager-002',
    }));
    for (const field of ['nodeId', 'addedApproverId']) {
      await invalid(new ActionModel({
        ...action(), actionType: 'instance.approver_added',
        nodeId: 'manager', addedApproverId: 'manager-003', [field]: null,
      }), '加签动作字段不完整');
    }
    await invalid(new ActionModel({
      ...action(), canceledApproverIds: ['manager-001'],
    }), '非撤回动作不能包含取消审批人');
    await valid(new ActionModel({
      ...action(), actionType: 'instance.withdrawn', canceledApproverIds: ['manager-001'],
    }));
  });

  it('委托禁止自委托、倒置有效期和无撤销人撤销', async () => {
    const delegation = {
      id: 'delegation-001', tenantId: 'tenant-001', principalApproverId: 'manager-001',
      delegateId: 'delegate-001', validFrom: NOW, validUntil: new Date(NOW.getTime() + 3_600_000),
      coverageDays: ['2026-07-21'], status: 'active', version: 1,
      createdBy: 'manager-001', revokedBy: null,
    };
    await valid(new DelegationModel(delegation));
    await invalid(new DelegationModel({ ...delegation, delegateId: 'manager-001' }), '不能相同');
    await invalid(new DelegationModel({ ...delegation, validUntil: NOW }), '必须晚于');
    await invalid(new DelegationModel({ ...delegation, coverageDays: ['2026-07-22'] }), '覆盖日槽无效');
    await invalid(new DelegationModel({ ...delegation, status: 'revoked' }), '必须记录撤销人');
    await invalid(new DelegationModel({
      ...delegation, revokedBy: 'manager-001',
    }), '有效委托不能包含撤销人');
    await valid(new DelegationModel({
      ...delegation, status: 'revoked', revokedBy: 'manager-001',
    }));
  });

  it('关键唯一与待办查询索引已声明', () => {
    const templateIndexes = ApprovalTemplateRecordSchema.indexes() as Array<[
      Record<string, unknown>, { name?: string },
    ]>;
    const instanceIndexes = ApprovalInstanceRecordSchema.indexes() as Array<[
      Record<string, unknown>, Record<string, unknown>,
    ]>;
    const delegationIndexes = ApprovalDelegationRecordSchema.indexes() as Array<[
      Record<string, unknown>, Record<string, unknown>,
    ]>;
    const legacyHistoryIndexes = ApprovalLegacyHistoryRecordSchema.indexes() as Array<[
      Record<string, unknown>, Record<string, unknown>,
    ]>;
    expect(templateIndexes.some(([keys, options]) =>
      keys.tenantId === 1 && keys.code === 1 && options.name === 'one_published_per_code')).toBe(true);
    expect(instanceIndexes.some(([keys]) =>
      keys.tenantId === 1 && keys.currentActorIds === 1 && keys.status === 1)).toBe(true);
    expect(delegationIndexes.some(([keys, options]) =>
      keys.tenantId === 1 && keys.principalApproverId === 1 && keys.coverageDays === 1 &&
      options.unique === true &&
      (options.partialFilterExpression as Record<string, unknown> | undefined)?.status === 'active'
    )).toBe(true);
    expect(legacyHistoryIndexes.some(([keys, options]) =>
      keys.tenantId === 1 && keys.migrationEvidenceRef === 1 && options.unique === true
    )).toBe(true);
  });
});
