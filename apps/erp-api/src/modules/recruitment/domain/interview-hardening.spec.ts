import { describe, expect, it } from 'vitest';

import {
  cancelRecruitmentInterview,
  completeRecruitmentInterview,
  createRecruitmentInterview,
  restoreRecruitmentInterviewFromMigration,
  submitRecruitmentInterviewFeedback,
  type RecruitmentInterview,
  type RecruitmentInterviewMigrationFeedback,
} from './interview.js';

const CREATED = new Date('2026-07-29T07:00:00.000Z');
const STARTS = new Date('2026-07-29T08:00:00.000Z');
const ENDS = new Date('2026-07-29T09:00:00.000Z');
const DURING = new Date('2026-07-29T08:30:00.000Z');
const AFTER = new Date('2026-07-29T09:05:00.000Z');
const MIGRATION_NOW = new Date('2026-07-30T00:00:00.000Z');

function scheduled(): RecruitmentInterview {
  return createRecruitmentInterview({
    id: 'interview-001',
    tenantId: 'tenant-001',
    applicationId: 'application-001',
    roundNumber: 1,
    mode: 'video',
    startsAt: STARTS,
    endsAt: ENDS,
    timezone: 'Asia/Shanghai',
    interviewerIds: ['employee-001', 'employee-002'],
    location: 'https://meeting.example/protected',
    actorId: 'actor-001',
  }, CREATED);
}

function feedback(
  interview: RecruitmentInterview,
  interviewerId = 'employee-001',
  now = DURING,
) {
  return submitRecruitmentInterviewFeedback(interview, {
    id: `feedback-${interviewerId}`,
    tenantId: 'tenant-001',
    expectedVersion: interview.version,
    interviewerId,
    recommendation: 'hire',
    score: 4,
    notes: '候选人的能力与岗位要求匹配',
  }, now);
}

const migrationFeedback: RecruitmentInterviewMigrationFeedback[] = [
  {
    id: 'feedback-001',
    interviewerId: 'employee-001',
    recommendation: 'hire',
    score: 4,
    notes: '岗位经验匹配',
    submittedAt: '2026-07-29T09:01:00.000Z',
  },
  {
    id: 'feedback-002',
    interviewerId: 'employee-002',
    recommendation: 'strong_hire',
    score: 5,
    notes: '综合能力优秀',
    submittedAt: '2026-07-29T09:02:00.000Z',
  },
];

function completedMigration(
  patch: Record<string, unknown> = {},
) {
  return {
    id: 'interview-003',
    tenantId: 'tenant-001',
    applicationId: 'application-001',
    roundNumber: 1,
    mode: 'onsite' as const,
    startsAt: '2026-07-29T08:00:00.000Z',
    endsAt: '2026-07-29T09:00:00.000Z',
    timezone: 'Asia/Shanghai',
    interviewerIds: ['employee-001', 'employee-002'],
    location: '上海总部 8F',
    createdBy: 'employee-hr',
    feedback: migrationFeedback,
    expectedStatus: 'completed' as const,
    expectedVersion: 4,
    completedAt: '2026-07-29T09:03:00.000Z',
    cancelledAt: null,
    createdAt: '2026-07-28T08:00:00.000Z',
    updatedAt: '2026-07-29T09:03:00.000Z',
    ...patch,
  };
}

describe('招聘面试领域安全边界', () => {
  it('创建支持真实多段 IANA 时区并深冻结敏感聚合', () => {
    const result = createRecruitmentInterview({
      ...scheduled(),
      timezone: 'America/Argentina/Buenos_Aires',
      actorId: 'actor-001',
      startsAt: STARTS,
      endsAt: ENDS,
    }, CREATED);
    expect(result.timezone).toBe('America/Argentina/Buenos_Aires');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.interviewerIds)).toBe(true);
  });

  it.each([
    ['无效当前时间', { now: 'invalid' as unknown as Date }],
    ['非 Date 开始时间', { startsAt: '2026-07-29' as unknown as Date }],
    ['无效结束时间', { endsAt: new Date('invalid') }],
    ['开始时间不在未来', { startsAt: CREATED }],
    ['结束早于开始', { endsAt: new Date('2026-07-29T07:59:59.999Z') }],
    ['时长超过十二小时', { endsAt: new Date('2026-07-29T20:00:00.001Z') }],
  ])('创建拒绝%s', (_name, patch) => {
    const values = patch as Record<string, unknown> & { readonly now?: Date };
    const { now = CREATED, ...inputPatch } = values;
    expect(() => createRecruitmentInterview({
      ...scheduled(),
      actorId: 'actor-001',
      startsAt: STARTS,
      endsAt: ENDS,
      ...inputPatch,
    }, now)).toThrow();
  });

  it.each([
    ['轮次非整数', { roundNumber: 1.5 }],
    ['轮次越界', { roundNumber: 101 }],
    ['未知方式', { mode: 'hybrid' }],
    ['面试官不是数组', { interviewerIds: null }],
    ['面试官为空', { interviewerIds: [] }],
    ['面试官重复', { interviewerIds: ['employee-001', 'employee-001'] }],
    ['面试官标识非法', { interviewerIds: ['employee invalid'] }],
    ['时区形态非法', { timezone: 'CST' }],
    ['时区不存在', { timezone: 'Asia/Not_A_Real_Zone' }],
    ['地点仅空白', { location: '   ' }],
  ])('创建拒绝%s', (_name, patch) => {
    expect(() => createRecruitmentInterview({
      ...scheduled(),
      actorId: 'actor-001',
      startsAt: STARTS,
      endsAt: ENDS,
      ...patch,
    } as Parameters<typeof createRecruitmentInterview>[0], CREATED)).toThrow();
  });

  it('评价只推进安全版本且不改变面试终态', () => {
    const result = feedback(scheduled());
    expect(result.interview).toMatchObject({
      status: 'scheduled',
      version: 2,
      updatedAt: DURING.toISOString(),
    });
    expect(result.feedback).toMatchObject({
      recommendation: 'hire',
      score: 4,
      submittedAt: DURING.toISOString(),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['非法评价标识', { id: 'feedback invalid' }],
    ['非法面试官标识', { interviewerId: 'employee invalid' }],
    ['未知建议', { recommendation: 'maybe' }],
    ['非整数评分', { score: 4.5 }],
    ['评分越界', { score: 6 }],
    ['空白评价', { notes: '   ' }],
  ])('评价拒绝%s', (_name, patch) => {
    expect(() => submitRecruitmentInterviewFeedback(scheduled(), {
      id: 'feedback-001',
      tenantId: 'tenant-001',
      expectedVersion: 1,
      interviewerId: 'employee-001',
      recommendation: 'hire',
      score: 4,
      notes: '评价有效',
      ...patch,
    } as Parameters<typeof submitRecruitmentInterviewFeedback>[1], DURING)).toThrow();
  });

  it('评价拒绝开始前、时间倒退、受损状态和版本上溢', () => {
    expect(() => feedback(
      scheduled(),
      'employee-001',
      new Date('2026-07-29T07:59:59.999Z'),
    )).toThrow('开始前');
    expect(() => feedback({
      ...scheduled(),
      updatedAt: '2026-07-29T08:45:00.000Z',
    })).toThrow('不能早于');
    expect(() => feedback({
      ...scheduled(),
      status: 'unknown' as RecruitmentInterview['status'],
    })).toThrow('状态无效');
    expect(() => feedback({
      ...scheduled(),
      version: Number.MAX_SAFE_INTEGER,
    })).toThrow('安全整数上限');
    expect(() => feedback({
      ...scheduled(),
      version: 0,
    })).toThrow('正安全整数');
  });

  it('只有全部唯一面试官证据齐备且已结束才可完成', () => {
    expect(() => completeRecruitmentInterview(scheduled(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      submittedInterviewerIds: ['employee-001', 'employee-002'],
    }, DURING)).toThrow('结束前');
    const completed = completeRecruitmentInterview(scheduled(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      submittedInterviewerIds: ['employee-001', 'employee-002'],
    }, AFTER);
    expect(completed).toMatchObject({
      status: 'completed',
      version: 2,
      completedAt: AFTER.toISOString(),
    });
  });

  it.each([
    ['非数组', null],
    ['缺失', ['employee-001']],
    ['重复', ['employee-001', 'employee-001', 'employee-002']],
    ['额外主体', ['employee-001', 'employee-002', 'employee-003']],
    ['非法标识', ['employee-001', 'employee invalid']],
  ])('完成拒绝%s的评价主体集合', (_name, submittedInterviewerIds) => {
    expect(() => completeRecruitmentInterview(scheduled(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      submittedInterviewerIds:
        submittedInterviewerIds as unknown as readonly string[],
    }, AFTER)).toThrow();
  });

  it('完成与取消共用版本上溢及单调时间保护', () => {
    expect(() => completeRecruitmentInterview({
      ...scheduled(),
      version: Number.MAX_SAFE_INTEGER,
    }, {
      tenantId: 'tenant-001',
      expectedVersion: Number.MAX_SAFE_INTEGER,
      submittedInterviewerIds: ['employee-001', 'employee-002'],
    }, AFTER)).toThrow('安全整数上限');
    expect(() => cancelRecruitmentInterview({
      ...scheduled(),
      updatedAt: '2026-07-29T08:00:00.000Z',
    }, {
      tenantId: 'tenant-001',
      expectedVersion: 1,
    }, new Date('2026-07-29T07:30:00.000Z'))).toThrow('不能早于');
    expect(cancelRecruitmentInterview(scheduled(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
    }, DURING)).toMatchObject({ status: 'cancelled', version: 2 });
  });

  it('迁移可恢复 completed、cancelled 与未过期 scheduled 三种闭包', () => {
    expect(restoreRecruitmentInterviewFromMigration(
      completedMigration(),
      MIGRATION_NOW,
    ).interview).toMatchObject({ status: 'completed', version: 4 });
    expect(restoreRecruitmentInterviewFromMigration(completedMigration({
      feedback: [],
      expectedStatus: 'cancelled',
      expectedVersion: 2,
      completedAt: null,
      cancelledAt: '2026-07-29T07:30:00.000Z',
      updatedAt: '2026-07-29T07:30:00.000Z',
    }), MIGRATION_NOW).interview).toMatchObject({ status: 'cancelled', version: 2 });
    expect(restoreRecruitmentInterviewFromMigration(completedMigration({
      startsAt: '2026-07-31T08:00:00.000Z',
      endsAt: '2026-07-31T09:00:00.000Z',
      feedback: [],
      expectedStatus: 'scheduled',
      expectedVersion: 1,
      completedAt: null,
      cancelledAt: null,
      createdAt: '2026-07-29T08:00:00.000Z',
      updatedAt: '2026-07-29T08:00:00.000Z',
    }), MIGRATION_NOW).interview).toMatchObject({ status: 'scheduled', version: 1 });
  });

  it.each([
    ['无效当前时间', {}, 'invalid' as unknown as Date],
    ['未知状态', { expectedStatus: 'unknown' }, MIGRATION_NOW],
    ['版本非法', { expectedVersion: 0 }, MIGRATION_NOW],
    ['面试官非数组', { interviewerIds: null }, MIGRATION_NOW],
    ['评价非数组', { feedback: null }, MIGRATION_NOW],
    ['非字符串时间', { createdAt: Symbol('createdAt') }, MIGRATION_NOW],
    ['非规范时间', { startsAt: '2026-07-29T08:00:00Z' }, MIGRATION_NOW],
  ])('迁移拒绝%s', (_name, patch, now) => {
    expect(() => restoreRecruitmentInterviewFromMigration(
      completedMigration(patch) as Parameters<
        typeof restoreRecruitmentInterviewFromMigration
      >[0],
      now,
    )).toThrow();
  });

  it.each([
    ['创建时间位于未来', { createdAt: '2026-07-31T00:00:00.000Z' }],
    ['创建晚于开始', { createdAt: '2026-07-29T08:30:00.000Z' }],
    ['结束不晚于开始', { endsAt: '2026-07-29T08:00:00.000Z' }],
    ['时长超过十二小时', { endsAt: '2026-07-29T20:00:00.001Z' }],
    ['待排期已过期', {
      feedback: [],
      expectedStatus: 'scheduled',
      expectedVersion: 1,
      completedAt: null,
      endsAt: '2026-07-29T23:00:00.000Z',
      updatedAt: '2026-07-28T08:00:00.000Z',
    }],
  ])('迁移拒绝%s', (_name, patch) => {
    expect(() => restoreRecruitmentInterviewFromMigration(
      completedMigration(patch),
      MIGRATION_NOW,
    )).toThrow('时间线');
  });

  it.each([
    ['非法轮次', { roundNumber: 0 }],
    ['未知方式', { mode: 'hybrid' }],
    ['重复面试官', { interviewerIds: ['employee-001', 'employee-001'] }],
    ['无效时区', { timezone: 'Asia/Not_A_Real_Zone' }],
    ['空白地点', { location: '   ' }],
    ['评价过多', { feedback: Array.from({ length: 21 }, () => migrationFeedback[0]) }],
    ['版本数量错配', { expectedVersion: 3 }],
  ])('迁移拒绝%s', (_name, patch) => {
    expect(() => restoreRecruitmentInterviewFromMigration(
      completedMigration(patch) as Parameters<
        typeof restoreRecruitmentInterviewFromMigration
      >[0],
      MIGRATION_NOW,
    )).toThrow();
  });

  it('迁移评价只接受精确普通数据对象', () => {
    const extra = { ...migrationFeedback[0], tenantId: 'tenant-forged' };
    const symbol = { ...migrationFeedback[0], [Symbol('secret')]: true };
    const accessor = { ...migrationFeedback[0] };
    Object.defineProperty(accessor, 'notes', {
      enumerable: true,
      get: () => 'getter-secret',
    });
    const custom = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      migrationFeedback[0],
    );
    const proxy = new Proxy({ ...migrationFeedback[0] }, {
      getPrototypeOf() {
        throw new Error('proxy trap');
      },
    });
    for (const value of [null, [], extra, symbol, accessor, custom, proxy]) {
      expect(() => restoreRecruitmentInterviewFromMigration(
        completedMigration({
          feedback: [value, migrationFeedback[1]],
        }) as Parameters<typeof restoreRecruitmentInterviewFromMigration>[0],
        MIGRATION_NOW,
      )).toThrow('精确普通数据对象');
    }
  });

  it.each([
    ['早于开始', { submittedAt: '2026-07-29T07:59:59.999Z' }],
    ['位于未来', { submittedAt: '2026-07-30T00:06:00.000Z' }],
  ])('迁移拒绝评价时间%s', (_name, feedbackPatch) => {
    expect(() => restoreRecruitmentInterviewFromMigration(completedMigration({
      feedback: [
        { ...migrationFeedback[0], ...feedbackPatch },
        migrationFeedback[1],
      ],
    }), MIGRATION_NOW)).toThrow('评价必须唯一、按时间排序且不得位于未来');
  });

  it('迁移拒绝评价乱序或同一面试官重复', () => {
    expect(() => restoreRecruitmentInterviewFromMigration(completedMigration({
      feedback: [
        { ...migrationFeedback[0], submittedAt: '2026-07-29T09:02:30.000Z' },
        { ...migrationFeedback[1], submittedAt: '2026-07-29T09:02:00.000Z' },
      ],
    }), MIGRATION_NOW)).toThrow('评价必须唯一');
    expect(() => restoreRecruitmentInterviewFromMigration(completedMigration({
      feedback: [
        migrationFeedback[0],
        { ...migrationFeedback[1], interviewerId: 'employee-001' },
      ],
    }), MIGRATION_NOW)).toThrow('评价必须唯一');
  });

  it.each([
    ['完成时间早于结束', { completedAt: '2026-07-29T08:59:59.999Z' }],
    ['完成同时存在取消时间', { cancelledAt: '2026-07-29T09:04:00.000Z' }],
    ['取消同时存在完成时间', {
      feedback: [],
      expectedStatus: 'cancelled',
      expectedVersion: 2,
      cancelledAt: '2026-07-29T09:04:00.000Z',
    }],
    ['排期持有终态时间', {
      feedback: [],
      expectedStatus: 'scheduled',
      expectedVersion: 1,
      startsAt: '2026-07-31T08:00:00.000Z',
      endsAt: '2026-07-31T09:00:00.000Z',
      completedAt: '2026-07-31T09:01:00.000Z',
      cancelledAt: null,
      createdAt: '2026-07-29T08:00:00.000Z',
      updatedAt: '2026-07-29T08:00:00.000Z',
    }],
    ['最终更新时间不一致', { updatedAt: '2026-07-29T09:04:00.000Z' }],
  ])('迁移拒绝%s', (_name, patch) => {
    expect(() => restoreRecruitmentInterviewFromMigration(
      completedMigration(patch) as Parameters<
        typeof restoreRecruitmentInterviewFromMigration
      >[0],
      MIGRATION_NOW,
    )).toThrow();
  });
});
