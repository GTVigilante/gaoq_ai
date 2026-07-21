import type { ClientSession, Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  createApprovalInstanceDraft,
  createApprovalTemplateDraft,
  decideApprovalInstance,
  publishApprovalTemplate,
  submitApprovalInstance,
  withdrawApprovalInstance,
  type ApprovalTemplateDefinition,
} from '../domain/index.js';
import type { ApprovalNotificationDocument } from './approval-notification.schema.js';
import { ApprovalNotificationWriter } from './approval-notification.writer.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const SESSION = {} as ClientSession;

function definition(): ApprovalTemplateDefinition {
  return {
    fields: [{ key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2' }],
    nodes: [{
      id: 'joint', name: '双人会签', type: 'approval', approvalMode: 'all',
      resolver: { type: 'employees', employeeIds: ['employee-a', 'employee-b'] },
    }],
  };
}

function draft() {
  const templateDraft = createApprovalTemplateDraft({
    id: 'template-001', tenantId: 'tenant-001', code: 'EXPENSE', name: '费用审批',
    riskLevel: 'R1', definition: definition(), actorId: 'editor-001',
  }, NOW);
  const template = publishApprovalTemplate(templateDraft, {
    tenantId: 'tenant-001', expectedVersion: 1, approverId: 'publisher-001',
  }, NOW);
  return createApprovalInstanceDraft({
    id: 'instance-001', tenantId: 'tenant-001', title: '不能进入通知记录的标题',
    initiatorId: 'initiator-001', template, formData: { amount: 120_00 },
  }, NOW);
}

function writer(tenantId = 'tenant-001') {
  const create = vi.fn().mockResolvedValue([]);
  const context = {
    getTenantRequired: () => ({ tenantId, source: 'access_token' as const }),
  } as unknown as TenantContextService;
  return {
    create,
    service: new ApprovalNotificationWriter(
      context,
      { create } as unknown as Model<ApprovalNotificationDocument>,
    ),
  };
}

describe('ApprovalNotificationWriter', () => {
  it('提交后在同一事务为每位当前审批人生成双通道意图', async () => {
    const submitted = submitApprovalInstance(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'initiator-001',
      resolvedNodes: [{ nodeId: 'joint', actorIds: ['approver-a', 'approver-b'] }],
    }, NOW);
    const target = writer();
    await expect(target.service.append(submitted.instance, submitted.action, SESSION)).resolves.toBe(4);
    const documents = target.create.mock.calls[0]?.[0] as readonly Record<string, unknown>[];
    expect(documents).toHaveLength(4);
    expect(new Set(documents.map((item) => item.channel))).toEqual(new Set(['dingtalk', 'feishu']));
    expect(new Set(documents.map((item) => item.recipientActorId)))
      .toEqual(new Set(['approver-a', 'approver-b']));
    expect(target.create).toHaveBeenCalledWith(documents, { session: SESSION });
    expect(JSON.stringify(documents)).not.toContain('不能进入通知记录的标题');
    expect(JSON.stringify(documents)).not.toContain('12000');
  });

  it('会签中已处理人员不会再次收到待办通知', async () => {
    const submitted = submitApprovalInstance(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'initiator-001',
      resolvedNodes: [{ nodeId: 'joint', actorIds: ['approver-a', 'approver-b'] }],
    }, NOW).instance;
    const decided = decideApprovalInstance(submitted, {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'approver-a',
      principalApproverId: 'approver-a', delegationVerified: true, outcome: 'approved',
    }, new Date('2026-07-21T00:01:00.000Z'));
    const target = writer();
    await expect(target.service.append(decided.instance, decided.action, SESSION)).resolves.toBe(2);
    const documents = target.create.mock.calls[0]?.[0] as readonly Record<string, unknown>[];
    expect(documents.every((item) => item.recipientActorId === 'approver-b')).toBe(true);
  });

  it('拒绝终态通知发起人且拒绝跨租户写入', async () => {
    const submitted = submitApprovalInstance(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'initiator-001',
      resolvedNodes: [{ nodeId: 'joint', actorIds: ['approver-a', 'approver-b'] }],
    }, NOW).instance;
    const rejected = decideApprovalInstance(submitted, {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'approver-a',
      principalApproverId: 'approver-a', delegationVerified: true, outcome: 'rejected',
    }, new Date('2026-07-21T00:01:00.000Z'));
    const target = writer();
    await target.service.append(rejected.instance, rejected.action, SESSION);
    const documents = target.create.mock.calls[0]?.[0] as readonly Record<string, unknown>[];
    expect(documents.every((item) => item.recipientActorId === 'initiator-001')).toBe(true);
    await expect(writer('tenant-other').service.append(rejected.instance, rejected.action, SESSION))
      .rejects.toThrow('拒绝跨租户聚合');
  });

  it('撤回运行中审批会通知被取消待办的审批人，不给发起人发送自操作通知', async () => {
    const submitted = submitApprovalInstance(draft(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'initiator-001',
      resolvedNodes: [{ nodeId: 'joint', actorIds: ['approver-a', 'approver-b'] }],
    }, NOW).instance;
    const withdrawn = withdrawApprovalInstance(submitted, {
      tenantId: 'tenant-001', expectedVersion: 2, actorId: 'initiator-001',
    }, new Date('2026-07-21T00:02:00.000Z'));
    const target = writer();
    await expect(target.service.append(withdrawn.instance, withdrawn.action, SESSION)).resolves.toBe(4);
    const documents = target.create.mock.calls[0]?.[0] as readonly Record<string, unknown>[];
    expect(new Set(documents.map((item) => item.recipientActorId)))
      .toEqual(new Set(['approver-a', 'approver-b']));
    expect(documents.some((item) => item.recipientActorId === 'initiator-001')).toBe(false);
  });
});
