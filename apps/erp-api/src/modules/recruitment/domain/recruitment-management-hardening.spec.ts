import { describe, expect, it } from 'vitest';

import {
  applyRecruitmentApprovalOutcome,
  closeRecruitmentRequisition,
  createRecruitmentRequisition,
  restoreRecruitmentRequisitionFromMigration,
  submitRecruitmentRequisition,
  type RecruitmentRequisition,
} from './requisition.js';
import {
  createRecruitmentPosition,
  restoreRecruitmentPositionFromMigration,
  transitionRecruitmentPosition,
  type RecruitmentPosition,
} from './position.js';
import {
  assertRecruitmentCode,
  assertRecruitmentId,
  assertRecruitmentLabel,
  assertRecruitmentTenant,
  assertRecruitmentVersion,
  deepFreezeRecruitment,
  toRecruitmentIso,
} from './recruitment.validation.js';

const NOW = new Date('2026-07-29T00:00:00.000Z');

function draftRequisition() {
  return createRecruitmentRequisition({
    id: 'requisition-001',
    tenantId: 'tenant-001',
    departmentId: 'department-001',
    positionTitle: '小红书经纪人',
    headcount: 2,
    justification: '业务增长需要新增招聘人数',
    actorId: 'actor-001',
  }, NOW);
}

function pendingRequisition() {
  return submitRecruitmentRequisition(draftRequisition(), {
    tenantId: 'tenant-001',
    expectedVersion: 1,
    actorId: 'actor-001',
    approvalInstanceId: 'approval-001',
  }, NOW);
}

function draftPosition() {
  return createRecruitmentPosition({
    id: 'position-001',
    tenantId: 'tenant-001',
    requisitionId: 'requisition-001',
    title: '小红书经纪人',
    departmentId: 'department-001',
    jobLevelId: 'job-level-001',
    location: '上海',
    headcount: 2,
  }, NOW);
}

describe('HC 与职位领域运行时不变量', () => {
  it('应用服务与 MCP 绕过 REST DTO 时仍拒绝不足三字符的 HC 理由', () => {
    expect(() => createRecruitmentRequisition({
      ...draftRequisition(),
      justification: '理由',
      actorId: 'actor-001',
    }, NOW)).toThrow('3..4096');
    expect(() => restoreRecruitmentRequisitionFromMigration({
      ...draftRequisition(),
      justification: '理由',
    })).toThrow('3..4096');
  });

  it('HC 审批终态严格限制结果枚举与审批引用', () => {
    const pending = pendingRequisition();
    expect(() => applyRecruitmentApprovalOutcome(pending, {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      approvalInstanceId: 'approval invalid',
      outcome: 'approved',
      approvalVerified: true,
    }, NOW)).toThrow('标识白名单');
    expect(() => applyRecruitmentApprovalOutcome(pending, {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      approvalInstanceId: 'approval-001',
      outcome: 'cancelled' as 'approved',
      approvalVerified: true,
    }, NOW)).toThrow('approved 或 rejected');
  });

  it('HC 状态推进拒绝版本上溢、版本冲突和时间倒退', () => {
    const pending = pendingRequisition();
    expect(() => applyRecruitmentApprovalOutcome({
      ...pending,
      version: Number.MAX_SAFE_INTEGER,
    }, {
      tenantId: 'tenant-001',
      expectedVersion: Number.MAX_SAFE_INTEGER,
      approvalInstanceId: 'approval-001',
      outcome: 'approved',
      approvalVerified: true,
    }, NOW)).toThrow('安全整数上限');
    expect(() => applyRecruitmentApprovalOutcome(pending, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      approvalInstanceId: 'approval-001',
      outcome: 'approved',
      approvalVerified: true,
    }, NOW)).toThrow('版本冲突');
    expect(() => applyRecruitmentApprovalOutcome(pending, {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      approvalInstanceId: 'approval-001',
      outcome: 'approved',
      approvalVerified: true,
    }, new Date(NOW.getTime() - 1))).toThrow('不能早于');
  });

  it('HC 关闭沿用安全推进器且时间与租户失败关闭', () => {
    const approved = applyRecruitmentApprovalOutcome(pendingRequisition(), {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      approvalInstanceId: 'approval-001',
      outcome: 'approved',
      approvalVerified: true,
    }, NOW);
    expect(() => closeRecruitmentRequisition(approved, {
      tenantId: 'tenant-forged',
      expectedVersion: 3,
    }, NOW)).toThrow('租户不匹配');
    expect(() => closeRecruitmentRequisition(approved, {
      tenantId: 'tenant-001',
      expectedVersion: 3,
    }, new Date(NOW.getTime() - 1))).toThrow('不能早于');
  });

  it('HC 创建拒绝无效时间，迁移时间先做运行时类型判定', () => {
    expect(() => createRecruitmentRequisition({
      ...draftRequisition(),
      actorId: 'actor-001',
    }, 'invalid' as unknown as Date)).toThrow('时间无效');
    expect(() => restoreRecruitmentRequisitionFromMigration({
      ...draftRequisition(),
      createdAt: Symbol('createdAt') as unknown as string,
    })).toThrow('规范 UTC ISO 时间');
  });

  it('职位迁移严格限制当前状态和目标状态', () => {
    expect(() => transitionRecruitmentPosition({
      ...draftPosition(),
      status: 'invalid' as 'draft',
    }, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      targetStatus: 'open',
      requisitionApproved: true,
    }, NOW)).toThrow('当前状态无效');
    expect(() => transitionRecruitmentPosition(draftPosition(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      targetStatus: 'draft' as 'open',
      requisitionApproved: true,
    }, NOW)).toThrow('目标状态无效');
  });

  it('职位状态推进拒绝版本上溢、版本冲突和时间倒退', () => {
    expect(() => transitionRecruitmentPosition({
      ...draftPosition(),
      version: Number.MAX_SAFE_INTEGER,
    }, {
      tenantId: 'tenant-001',
      expectedVersion: Number.MAX_SAFE_INTEGER,
      targetStatus: 'closed',
      requisitionApproved: true,
    }, NOW)).toThrow('安全整数上限');
    expect(() => transitionRecruitmentPosition(draftPosition(), {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      targetStatus: 'closed',
      requisitionApproved: true,
    }, NOW)).toThrow('版本冲突');
    expect(() => transitionRecruitmentPosition(draftPosition(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      targetStatus: 'closed',
      requisitionApproved: true,
    }, new Date(NOW.getTime() - 1))).toThrow('不能早于');
  });

  it('职位迁移时间先做运行时类型判定并拒绝伪造状态', () => {
    expect(() => restoreRecruitmentPositionFromMigration({
      ...draftPosition(),
      createdAt: Symbol('createdAt') as unknown as string,
    })).toThrow('规范 UTC ISO 时间');
    expect(() => restoreRecruitmentPositionFromMigration({
      ...draftPosition(),
      status: 'invalid' as RecruitmentPosition['status'],
    })).toThrow('迁移状态无效');
  });

  it('职位创建和迁移均拒绝非法招聘人数', () => {
    expect(() => createRecruitmentPosition({
      ...draftPosition(),
      headcount: 0,
    }, NOW)).toThrow('1..10000');
    expect(() => restoreRecruitmentPositionFromMigration({
      ...draftPosition(),
      headcount: 10_001,
    })).toThrow('1..10000');
  });

  it.each([
    ['草稿携带发布时间', { publishedAt: '2026-07-29T00:00:00.000Z' }],
    ['开放缺少发布时间', { status: 'open', version: 2 }],
    ['暂停版本过低', {
      status: 'paused',
      version: 2,
      publishedAt: '2026-07-29T00:00:00.000Z',
    }],
    ['关闭缺少关闭时间', { status: 'closed', version: 2 }],
    ['更新早于创建', {
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    }],
    ['发布早于创建', {
      status: 'open',
      version: 2,
      publishedAt: '2026-07-28T00:00:00.000Z',
    }],
    ['关闭晚于更新', {
      status: 'closed',
      version: 2,
      closedAt: '2026-07-30T00:00:00.000Z',
    }],
    ['关闭早于发布', {
      status: 'closed',
      version: 3,
      publishedAt: '2026-07-29T00:00:00.000Z',
      closedAt: '2026-07-28T00:00:00.000Z',
    }],
  ] as const)('职位迁移拒绝%s', (_name, patch) => {
    expect(() => restoreRecruitmentPositionFromMigration({
      ...draftPosition(),
      ...patch,
    })).toThrow('状态、版本或生命周期时间不一致');
  });

  it('职位迁移拒绝非规范生命周期时间', () => {
    expect(() => restoreRecruitmentPositionFromMigration({
      ...draftPosition(),
      updatedAt: '2026-07-29T00:00:00Z',
    })).toThrow('规范 UTC ISO 时间');
  });

  it('HC 迁移拒绝非法状态并保持合法草稿不可变', () => {
    const restored = restoreRecruitmentRequisitionFromMigration({
      ...draftRequisition(),
    });
    expect(Object.isFrozen(restored)).toBe(true);
    expect(() => restoreRecruitmentRequisitionFromMigration({
      ...draftRequisition(),
      status: 'invalid' as RecruitmentRequisition['status'],
    })).toThrow('迁移状态无效');
  });
});

describe('招聘共享运行时校验', () => {
  it('标识和编码只接受显式字符串白名单', () => {
    expect(() => assertRecruitmentId('resource-001', 'resourceId')).not.toThrow();
    expect(() => assertRecruitmentId(1, 'resourceId')).toThrow('标识白名单');
    expect(() => assertRecruitmentId('resource invalid', 'resourceId')).toThrow('标识白名单');
    expect(() => assertRecruitmentCode('full_time', 'employmentType')).not.toThrow();
    expect(() => assertRecruitmentCode(null, 'employmentType')).toThrow('编码白名单');
    expect(() => assertRecruitmentCode('full:time', 'employmentType')).toThrow('编码白名单');
  });

  it('标签同时约束运行时类型、有效字符数和原始载荷长度', () => {
    expect(() => assertRecruitmentLabel(' 上海 ', 'location', 8)).not.toThrow();
    expect(() => assertRecruitmentLabel(1, 'location')).toThrow('长度必须');
    expect(() => assertRecruitmentLabel('   ', 'location')).toThrow('长度必须');
    expect(() => assertRecruitmentLabel('上海', 'location', 1)).toThrow('长度必须');
    expect(() => assertRecruitmentLabel('理由', 'justification', 16, 3)).toThrow('3..16');
  });

  it('版本、租户和时间均在运行时失败关闭', () => {
    expect(() => assertRecruitmentVersion(1)).not.toThrow();
    expect(() => assertRecruitmentVersion(1.5)).toThrow('正安全整数');
    expect(() => assertRecruitmentVersion(0)).toThrow('正安全整数');
    expect(() => assertRecruitmentTenant('tenant-001', 'tenant-001')).not.toThrow();
    expect(() => assertRecruitmentTenant('tenant-001', 'tenant-forged')).toThrow('租户不匹配');
    expect(toRecruitmentIso(NOW)).toBe('2026-07-29T00:00:00.000Z');
    expect(() => toRecruitmentIso(new Date('invalid'))).toThrow('时间无效');
  });

  it('深冻结递归保护嵌套控制事实并安全处理原始值', () => {
    const value = { nested: { status: 'draft' }, count: 1 };
    expect(deepFreezeRecruitment(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(deepFreezeRecruitment(null)).toBeNull();
    expect(deepFreezeRecruitment(1)).toBe(1);
    expect(deepFreezeRecruitment(value)).toBe(value);
  });
});
