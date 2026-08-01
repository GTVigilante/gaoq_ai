import { describe, expect, it } from 'vitest';

import {
  applyRecruitmentApprovalOutcome,
  closeRecruitmentRequisition,
  createRecruitmentRequisition,
  restoreRecruitmentRequisitionFromMigration,
  submitRecruitmentRequisition,
} from './requisition.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');

function requisition() {
  return createRecruitmentRequisition({
    id: 'requisition-001', tenantId: 'tenant-001', departmentId: 'department-001',
    positionTitle: '小红书经纪人', headcount: 2, justification: '业务增长需要新增招聘人数',
    actorId: 'actor-001',
  }, NOW);
}

describe('RecruitmentRequisition', () => {
  it('草稿只能由创建人绑定审批实例提交', () => {
    expect(() => submitRecruitmentRequisition(requisition(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-002',
      approvalInstanceId: 'approval-001',
    }, NOW)).toThrow('只有创建人');
    const pending = submitRecruitmentRequisition(requisition(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      approvalInstanceId: 'approval-001',
    }, NOW);
    expect(pending).toMatchObject({
      status: 'pending_approval', approvalInstanceId: 'approval-001', version: 2,
    });
  });

  it('客户端自报审批通过或错误审批引用均失败关闭', () => {
    const pending = submitRecruitmentRequisition(requisition(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      approvalInstanceId: 'approval-001',
    }, NOW);
    expect(() => applyRecruitmentApprovalOutcome(pending, {
      tenantId: 'tenant-001', expectedVersion: 2, approvalInstanceId: 'approval-001',
      outcome: 'approved', approvalVerified: false,
    }, NOW)).toThrow('缺少可信审批证据');
    expect(() => applyRecruitmentApprovalOutcome(pending, {
      tenantId: 'tenant-001', expectedVersion: 2, approvalInstanceId: 'approval-002',
      outcome: 'approved', approvalVerified: true,
    }, NOW)).toThrow('引用不匹配');
  });

  it('可信审批终态后才能关闭 HC', () => {
    const pending = submitRecruitmentRequisition(requisition(), {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      approvalInstanceId: 'approval-001',
    }, NOW);
    const approved = applyRecruitmentApprovalOutcome(pending, {
      tenantId: 'tenant-001', expectedVersion: 2, approvalInstanceId: 'approval-001',
      outcome: 'approved', approvalVerified: true,
    }, NOW);
    expect(closeRecruitmentRequisition(approved, {
      tenantId: 'tenant-001', expectedVersion: 3,
    }, NOW)).toMatchObject({ status: 'closed', version: 4 });
  });

  it('迁移按 HC 状态严格区分活动审批和终结历史引用', () => {
    const migrated = restoreRecruitmentRequisitionFromMigration({
      id: 'requisition-001', tenantId: 'tenant-001', departmentId: 'department-001',
      positionTitle: '小红书经纪人', headcount: 2,
      justification: '历史 HC 需求证据已进入迁移账本', status: 'approved',
      approvalInstanceId: null, approvalHistoryId: 'approval-history-001', version: 3,
      createdBy: 'actor-001', createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    });
    expect(migrated).toMatchObject({
      status: 'approved', approvalInstanceId: null,
      approvalHistoryId: 'approval-history-001', version: 3,
    });
    expect(() => restoreRecruitmentRequisitionFromMigration({
      ...migrated,
      status: 'pending_approval',
      approvalInstanceId: null,
      approvalHistoryId: 'approval-history-001',
      version: 2,
    })).toThrow('状态、审批引用与版本不一致');
  });
});
