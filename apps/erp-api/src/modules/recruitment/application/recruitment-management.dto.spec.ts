import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import {
  CreateRecruitmentPositionDto,
  CreateRecruitmentRequisitionDto,
  TransitionRecruitmentPositionDto,
} from './recruitment-management.dto.js';

const requisitionPayload = {
  departmentId: 'department-001',
  positionTitle: '小红书经纪人',
  headcount: 2,
  justification: '业务增长需要新增招聘人数',
};
const positionPayload = { jobLevelId: 'job-level-001', location: '上海' };

async function errors(
  constructor: new () => object,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(constructor, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('RecruitmentManagementDto', () => {
  it('接受完整且有界的 HC、职位和状态迁移输入', async () => {
    await expect(errors(
      CreateRecruitmentRequisitionDto,
      requisitionPayload,
    )).resolves.toHaveLength(0);
    await expect(errors(
      CreateRecruitmentPositionDto,
      positionPayload,
    )).resolves.toHaveLength(0);
    await expect(errors(
      TransitionRecruitmentPositionDto,
      { targetStatus: 'paused' },
    )).resolves.toHaveLength(0);
  });

  it.each([
    ['departmentId', 'department invalid'],
    ['departmentId', 'a'.repeat(129)],
    ['positionTitle', ''],
    ['positionTitle', '   '],
    ['positionTitle', '职'.repeat(129)],
    ['headcount', 0],
    ['headcount', 10_001],
    ['headcount', 1.5],
    ['justification', 'ab'],
    ['justification', '  a  b  '],
    ['justification', '   '],
    ['justification', '理'.repeat(4_097)],
  ])('HC 创建拒绝非法字段 %s', async (field, value) => {
    const result = await errors(CreateRecruitmentRequisitionDto, {
      ...requisitionPayload,
      [field]: value,
    });
    expect(result.some((item) => item.property === field)).toBe(true);
  });

  it.each([
    ['jobLevelId', 'job level invalid'],
    ['jobLevelId', 'a'.repeat(129)],
    ['location', ''],
    ['location', '  '],
    ['location', '地'.repeat(129)],
  ])('职位创建拒绝非法字段 %s', async (field, value) => {
    const result = await errors(CreateRecruitmentPositionDto, {
      ...positionPayload,
      [field]: value,
    });
    expect(result.some((item) => item.property === field)).toBe(true);
  });

  it.each(['draft', 'approved', 'invalid', 1, null])(
    '职位迁移拒绝非法目标状态 %s',
    async (targetStatus) => {
      const result = await errors(TransitionRecruitmentPositionDto, { targetStatus });
      expect(result.some((item) => item.property === 'targetStatus')).toBe(true);
    },
  );

  it.each([
    [CreateRecruitmentRequisitionDto, {
      ...requisitionPayload,
      tenantId: 'tenant-forged',
      approvalInstanceId: 'approval-forged',
    }],
    [CreateRecruitmentPositionDto, {
      ...positionPayload,
      requisitionApproved: true,
      publishedAt: '2026-07-29T00:00:00.000Z',
    }],
    [TransitionRecruitmentPositionDto, {
      targetStatus: 'open',
      approvalVerified: true,
    }],
  ] as const)('拒绝未知控制字段，防止伪造租户、审批或证据', async (
    constructor,
    payload,
  ) => {
    const result = await errors(constructor, payload);
    expect(result.some((item) => ![
      'departmentId',
      'positionTitle',
      'headcount',
      'justification',
      'jobLevelId',
      'location',
      'targetStatus',
    ].includes(item.property))).toBe(true);
  });
});
