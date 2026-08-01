import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import {
  ScheduleRecruitmentInterviewDto,
  SubmitRecruitmentInterviewFeedbackDto,
} from './recruitment-interview.dto.js';

const schedulePayload = {
  roundNumber: 1,
  mode: 'video',
  startsAt: '2026-07-29T08:00:00.000Z',
  endsAt: '2026-07-29T09:00:00.000Z',
  timezone: 'Asia/Shanghai',
  interviewerIds: ['employee-001', 'employee-002'],
  location: 'https://meeting.example/protected',
};
const feedbackPayload = {
  recommendation: 'hire',
  score: 4,
  notes: '候选人的能力与岗位要求匹配',
};

async function errors(
  constructor: new () => object,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(constructor, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('RecruitmentInterviewDto', () => {
  it('接受规范排期与评价输入', async () => {
    await expect(errors(
      ScheduleRecruitmentInterviewDto,
      schedulePayload,
    )).resolves.toHaveLength(0);
    await expect(errors(
      SubmitRecruitmentInterviewFeedbackDto,
      feedbackPayload,
    )).resolves.toHaveLength(0);
  });

  it.each([
    ['roundNumber', 0],
    ['roundNumber', 101],
    ['roundNumber', 1.5],
    ['mode', 'hybrid'],
    ['startsAt', '2026-07-29T08:00:00Z'],
    ['startsAt', '2026-07-29T16:00:00.000+08:00'],
    ['startsAt', '2026-02-30T08:00:00.000Z'],
    ['endsAt', '2026-07-29 09:00:00.000Z'],
    ['timezone', 'CST'],
    ['timezone', 'Asia Shanghai'],
    ['interviewerIds', []],
    ['interviewerIds', Array.from({ length: 21 }, (_, index) => `employee-${index}`)],
    ['interviewerIds', ['employee-001', 'employee-001']],
    ['interviewerIds', ['employee valid', 'employee-002']],
    ['interviewerIds', 'employee-001'],
    ['location', ''],
    ['location', '   '],
    ['location', '地'.repeat(2_049)],
  ])('排期拒绝非法字段 %s', async (field, value) => {
    const result = await errors(ScheduleRecruitmentInterviewDto, {
      ...schedulePayload,
      [field]: value,
    });
    expect(result.some((item) => item.property === field)).toBe(true);
  });

  it.each([
    ['recommendation', 'maybe'],
    ['recommendation', 1],
    ['score', 0],
    ['score', 6],
    ['score', 1.5],
    ['notes', ''],
    ['notes', '   '],
    ['notes', '评'.repeat(8_193)],
  ])('评价拒绝非法字段 %s', async (field, value) => {
    const result = await errors(SubmitRecruitmentInterviewFeedbackDto, {
      ...feedbackPayload,
      [field]: value,
    });
    expect(result.some((item) => item.property === field)).toBe(true);
  });

  it.each([
    [ScheduleRecruitmentInterviewDto, {
      ...schedulePayload,
      tenantId: 'tenant-forged',
      candidateId: 'candidate-forged',
      status: 'completed',
    }],
    [SubmitRecruitmentInterviewFeedbackDto, {
      ...feedbackPayload,
      interviewerId: 'employee-forged',
      submittedAt: '2026-07-29T09:01:00.000Z',
    }],
  ] as const)('拒绝伪造租户、状态、主体或控制时间', async (
    constructor,
    payload,
  ) => {
    const result = await errors(constructor, payload);
    expect(result.some((item) => ![
      'roundNumber',
      'mode',
      'startsAt',
      'endsAt',
      'timezone',
      'interviewerIds',
      'location',
      'recommendation',
      'score',
      'notes',
    ].includes(item.property))).toBe(true);
  });
});
