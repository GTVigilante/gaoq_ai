import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  ApprovalActionRecordSchema,
  ApprovalDelegationRecordSchema,
  ApprovalInstanceRecordSchema,
  ApprovalTemplateRecordSchema,
  type ApprovalActionRecord,
  type ApprovalDelegationRecord,
  type ApprovalInstanceRecord,
  type ApprovalTemplateRecord,
} from './approval.schemas.js';

const mongoose = new Mongoose();
const TemplateModel = mongoose.model<ApprovalTemplateRecord>('SpecApprovalTemplate', ApprovalTemplateRecordSchema);
const InstanceModel = mongoose.model<ApprovalInstanceRecord>('SpecApprovalInstance', ApprovalInstanceRecordSchema);
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
  });

  it('动作日志拒绝不完整决策和非决策动作夹带决策字段', async () => {
    await valid(new ActionModel(action()));
    await invalid(new ActionModel({
      ...action(), actionType: 'instance.decided', nodeId: 'manager',
    }), '决策动作字段不完整');
    await invalid(new ActionModel({
      ...action(), principalApproverId: 'manager-001',
    }), '非决策动作不能包含决策字段');
  });

  it('委托禁止自委托、倒置有效期和无撤销人撤销', async () => {
    const delegation = {
      id: 'delegation-001', tenantId: 'tenant-001', principalApproverId: 'manager-001',
      delegateId: 'delegate-001', validFrom: NOW, validUntil: new Date(NOW.getTime() + 3_600_000),
      status: 'active', version: 1, createdBy: 'manager-001', revokedBy: null,
    };
    await valid(new DelegationModel(delegation));
    await invalid(new DelegationModel({ ...delegation, delegateId: 'manager-001' }), '不能相同');
    await invalid(new DelegationModel({ ...delegation, validUntil: NOW }), '必须晚于');
    await invalid(new DelegationModel({ ...delegation, status: 'revoked' }), '必须记录撤销人');
  });

  it('关键唯一与待办查询索引已声明', () => {
    const templateIndexes = ApprovalTemplateRecordSchema.indexes() as Array<[
      Record<string, unknown>, { name?: string },
    ]>;
    const instanceIndexes = ApprovalInstanceRecordSchema.indexes() as Array<[
      Record<string, unknown>, Record<string, unknown>,
    ]>;
    expect(templateIndexes.some(([keys, options]) =>
      keys.tenantId === 1 && keys.code === 1 && options.name === 'one_published_per_code')).toBe(true);
    expect(instanceIndexes.some(([keys]) =>
      keys.tenantId === 1 && keys.currentActorIds === 1 && keys.status === 1)).toBe(true);
  });
});
