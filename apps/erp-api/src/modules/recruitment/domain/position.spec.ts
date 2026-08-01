import { describe, expect, it } from 'vitest';

import {
  createRecruitmentPosition,
  restoreRecruitmentPositionFromMigration,
  transitionRecruitmentPosition,
} from './position.js';

const NOW = new Date('2026-07-21T08:00:00.000Z');

function position() {
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

describe('RecruitmentPosition', () => {
  it('HC 审批通过前禁止开放职位', () => {
    expect(() => transitionRecruitmentPosition(position(), {
      tenantId: 'tenant-001', expectedVersion: 1, targetStatus: 'open',
      requisitionApproved: false,
    }, NOW)).toThrow('HC 审批通过前不能开放职位');
  });

  it('支持开放、暂停、恢复和关闭的单向终态', () => {
    const opened = transitionRecruitmentPosition(position(), {
      tenantId: 'tenant-001', expectedVersion: 1, targetStatus: 'open',
      requisitionApproved: true,
    }, new Date('2026-07-22T08:00:00.000Z'));
    const paused = transitionRecruitmentPosition(opened, {
      tenantId: 'tenant-001', expectedVersion: 2, targetStatus: 'paused',
      requisitionApproved: true,
    }, new Date('2026-07-23T08:00:00.000Z'));
    const reopened = transitionRecruitmentPosition(paused, {
      tenantId: 'tenant-001', expectedVersion: 3, targetStatus: 'open',
      requisitionApproved: true,
    }, new Date('2026-07-24T08:00:00.000Z'));
    const closed = transitionRecruitmentPosition(reopened, {
      tenantId: 'tenant-001', expectedVersion: 4, targetStatus: 'closed',
      requisitionApproved: true,
    }, new Date('2026-07-25T08:00:00.000Z'));
    expect(closed).toMatchObject({ status: 'closed', version: 5 });
    expect(closed.publishedAt).toBe(opened.publishedAt);
    expect(() => transitionRecruitmentPosition(closed, {
      tenantId: 'tenant-001', expectedVersion: 5, targetStatus: 'open',
      requisitionApproved: true,
    }, NOW)).toThrow('职位状态迁移无效');
  });

  it('迁移恢复职位生命周期且拒绝伪造发布时间', () => {
    const migrated = restoreRecruitmentPositionFromMigration({
      ...position(),
      status: 'open',
      version: 2,
      publishedAt: '2026-07-22T08:00:00.000Z',
      createdAt: '2026-07-21T08:00:00.000Z',
      updatedAt: '2026-07-22T08:00:00.000Z',
    });
    expect(migrated).toMatchObject({ status: 'open', version: 2 });
    expect(() => restoreRecruitmentPositionFromMigration({
      ...migrated,
      publishedAt: null,
    })).toThrow('状态、版本或生命周期时间不一致');
  });
});
