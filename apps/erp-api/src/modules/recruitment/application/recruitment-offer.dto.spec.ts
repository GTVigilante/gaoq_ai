import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { CreateRecruitmentOfferDto } from './recruitment-offer.dto.js';

const INTERVIEW_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X1';

function validPayload(): Record<string, unknown> {
  return {
    completedInterviewId: INTERVIEW_ID,
    terms: {
      currency: 'CNY',
      monthlyBaseSalaryMinor: 3_000_000,
      salaryMonths: 13,
      annualVariableTargetMinor: 6_000_000,
      signingBonusMinor: 1_000_000,
      proposedStartDate: '2026-08-15',
      probationMonths: 3,
      employmentType: 'full_time',
      workLocation: '上海',
      benefitsSummary: '标准福利计划',
    },
    expiresAt: '2026-08-31T00:00:00.000Z',
    retentionExpiresAt: '2033-08-31T00:00:00.000Z',
  };
}

async function errors(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreateRecruitmentOfferDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('CreateRecruitmentOfferDto', () => {
  it('接受完整且有界的 Offer L4 条款', async () => {
    await expect(errors(validPayload())).resolves.toHaveLength(0);
  });

  it.each([
    ['completedInterviewId', INTERVIEW_ID.toLowerCase()],
    ['expiresAt', '2026-08-31'],
    ['expiresAt', '2026-08-31T00:00:00'],
    ['retentionExpiresAt', 'not-a-date'],
  ])('拒绝非法顶层字段 %s', async (field, value) => {
    const result = await errors({ ...validPayload(), [field]: value });
    expect(result.some((item) => item.property === field)).toBe(true);
  });

  it.each([
    ['currency', 'USD'],
    ['monthlyBaseSalaryMinor', 0],
    ['monthlyBaseSalaryMinor', 1.5],
    ['monthlyBaseSalaryMinor', Number.MAX_SAFE_INTEGER + 1],
    ['salaryMonths', 0],
    ['salaryMonths', 25],
    ['annualVariableTargetMinor', -1],
    ['signingBonusMinor', -1],
    ['proposedStartDate', '2026-02-31'],
    ['proposedStartDate', '2026-2-01'],
    ['probationMonths', -1],
    ['probationMonths', 13],
    ['employmentType', 'full time'],
    ['workLocation', ''],
    ['workLocation', '上'.repeat(257)],
    ['benefitsSummary', ''],
    ['benefitsSummary', '福'.repeat(4_097)],
  ])('拒绝非法 L4 条款 %s', async (field, value) => {
    const payload = validPayload();
    payload.terms = {
      ...(payload.terms as Record<string, unknown>),
      [field]: value,
    };
    const result = await errors(payload);
    const terms = result.find((item) => item.property === 'terms');
    expect(terms?.children?.some((item) => item.property === field)).toBe(true);
  });

  it('拒绝顶层与条款内未知字段，防止伪造租户、审批或证据', async () => {
    const payload: Record<string, unknown> = {
      ...validPayload(),
      tenantId: 'tenant-forged',
      sentEvidenceId: 'evidence-forged',
    };
    payload.terms = {
      ...(payload.terms as Record<string, unknown>),
      approvalInstanceId: 'approval-forged',
    };
    const result = await errors(payload);
    expect(result.map((item) => item.property)).toEqual(
      expect.arrayContaining(['tenantId', 'sentEvidenceId', 'terms']),
    );
    const terms = result.find((item) => item.property === 'terms');
    expect(terms?.children?.some((item) => item.property === 'approvalInstanceId')).toBe(true);
  });

  it.each([
    ['缺失', undefined],
    ['null', null],
    ['数组', []],
    ['字符串', 'terms'],
  ])('拒绝%s terms 对象', async (_name, terms) => {
    const result = await errors({ ...validPayload(), terms });
    expect(result.some((item) => item.property === 'terms')).toBe(true);
  });
});
