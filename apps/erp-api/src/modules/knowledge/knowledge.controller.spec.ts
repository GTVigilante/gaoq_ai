import { BadRequestException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type {
  CourseSummary,
  KnowledgeApplicationService,
  TrainingAssignmentSummary,
} from './application/knowledge-application.service.js';
import { KnowledgeController } from './knowledge.controller.js';

const ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const ONBOARDING_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const KEY = 'knowledge-write-001';

const COURSE: CourseSummary = Object.freeze({
  id: ID,
  courseCode: 'SECURITY',
  revision: 1,
  title: '信息安全',
  examRequired: true,
  passingScoreBps: 8_000,
  questionMode: 'objective',
  timeLimitMinutes: 60,
  maxAttempts: 3,
  gradingPolicyVersion: 'objective-auto-v1',
  passingRule: 'score_threshold',
  gradingSlaMinutes: 5,
  manualReviewSlaMinutes: 1_440,
  manualReviewRequired: false,
  status: 'draft',
  version: 1,
});

const ASSIGNMENT: TrainingAssignmentSummary = Object.freeze({
  id: ID,
  onboardingInstanceId: ONBOARDING_ID,
  courseVersionId: ID,
  mandatory: true,
  examRequired: true,
  dueDate: '2026-08-31',
  status: 'assigned',
  progressBps: 0,
  version: 1,
});

const COURSE_INPUT = {
  courseCode: 'SECURITY',
  revision: 1,
  title: '信息安全',
  contentRef: ID,
};

const ASSIGNMENT_INPUT = {
  courseVersionId: ID,
  mandatory: true,
  dueDate: '2026-08-31',
};

const PROGRESS_INPUT = {
  source: 'lms',
  sourceEventId: ID,
  progressBps: 5_000,
  occurredAt: '2026-07-28T00:00:00.000Z',
};

function fixture() {
  const service = {
    createCourse: vi.fn().mockResolvedValue({ course: COURSE }),
    publishCourse: vi.fn().mockResolvedValue({
      course: { ...COURSE, status: 'published', version: 2 },
    }),
    retireCourse: vi.fn().mockResolvedValue({
      course: { ...COURSE, status: 'retired', version: 3 },
    }),
    getCourse: vi.fn().mockResolvedValue(COURSE),
    searchMyKnowledge: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    assignCourse: vi.fn().mockResolvedValue({ assignment: ASSIGNMENT }),
    listOnboardingAssignments: vi.fn().mockResolvedValue({ items: [ASSIGNMENT] }),
    listMyAssignments: vi.fn().mockResolvedValue({ items: [] }),
    getAssignment: vi.fn().mockResolvedValue(ASSIGNMENT),
    recordProgressForIntegration: vi.fn().mockResolvedValue({
      assignment: { ...ASSIGNMENT, progressBps: 5_000, version: 2 },
    }),
    completeAssignment: vi.fn().mockResolvedValue({
      assignment: { ...ASSIGNMENT, status: 'completed', progressBps: 10_000, version: 3 },
    }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new KnowledgeController(
    service as unknown as KnowledgeApplicationService,
    audit as unknown as AuditService,
  );
  return {
    controller,
    service,
    audit,
    response: { setHeader: vi.fn() },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KnowledgeController', () => {
  it('每个入口声明精确 Scope，且不暴露评分写接口', () => {
    expect(scope('createCourse')).toEqual(['erp:knowledge:course:create']);
    expect(scope('publishCourse')).toEqual(['erp:knowledge:course:publish']);
    expect(scope('retireCourse')).toEqual(['erp:knowledge:course:publish']);
    expect(scope('getCourse')).toEqual(['erp:knowledge:course:read']);
    expect(scope('searchMyKnowledge')).toEqual(['erp:knowledge:search']);
    expect(scope('assignCourse')).toEqual(['erp:knowledge:assignment:create']);
    expect(scope('listAssignments')).toEqual(['erp:knowledge:assignment:read']);
    expect(scope('listMyAssignments')).toEqual(['erp:knowledge:assignment:read']);
    expect(scope('getAssignment')).toEqual(['erp:knowledge:assignment:read']);
    expect(scope('recordProgress')).toEqual(['erp:integration:knowledge:progress']);
    expect(scope('completeAssignment')).toEqual(['erp:knowledge:assignment:complete']);
    expect(Object.getOwnPropertyDescriptor(
      KnowledgeController.prototype,
      'gradeExam',
    )).toBeUndefined();
  });

  it('课程创建、发布和下架统一校验写契约、回传 ETag 并记录提交后审计', async () => {
    const store = fixture();

    await expect(store.controller.createCourse(
      KEY,
      COURSE_INPUT,
      store.response as never,
    )).resolves.toEqual({ course: COURSE });
    await expect(store.controller.publishCourse(
      ID,
      '"1"',
      KEY,
      store.response as never,
    )).resolves.toMatchObject({ course: { status: 'published', version: 2 } });
    await expect(store.controller.retireCourse(
      ID,
      '"2"',
      KEY,
      store.response as never,
    )).resolves.toMatchObject({ course: { status: 'retired', version: 3 } });

    expect(store.service.createCourse).toHaveBeenCalledWith(KEY, COURSE_INPUT);
    expect(store.service.publishCourse).toHaveBeenCalledWith(ID, 1, KEY);
    expect(store.service.retireCourse).toHaveBeenCalledWith(ID, 2, KEY);
    expect(store.response.setHeader.mock.calls).toEqual([
      ['ETag', '"1"'],
      ['ETag', '"2"'],
      ['ETag', '"3"'],
    ]);
    expect(store.audit.record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'knowledge.course.create',
    }));
    expect(store.audit.record).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'knowledge.course.publish',
    }));
    expect(store.audit.record).toHaveBeenNthCalledWith(3, expect.objectContaining({
      resourceType: 'knowledge_course',
      resourceId: ID,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: { status: 'retired', version: 3 },
    }));
  });

  it('任务分配、进度和完成统一使用强版本并记录最小审计元数据', async () => {
    const store = fixture();

    await expect(store.controller.assignCourse(
      ONBOARDING_ID,
      KEY,
      ASSIGNMENT_INPUT,
      store.response as never,
    )).resolves.toEqual({ assignment: ASSIGNMENT });
    await expect(store.controller.recordProgress(
      ID,
      '"1"',
      KEY,
      PROGRESS_INPUT,
      store.response as never,
    )).resolves.toMatchObject({ assignment: { progressBps: 5_000, version: 2 } });
    await expect(store.controller.completeAssignment(
      ID,
      '"2"',
      KEY,
      { passedExamAttemptId: ID },
      store.response as never,
    )).resolves.toMatchObject({ assignment: { status: 'completed', version: 3 } });

    expect(store.service.assignCourse).toHaveBeenCalledWith(
      ONBOARDING_ID,
      KEY,
      ASSIGNMENT_INPUT,
    );
    expect(store.service.recordProgressForIntegration).toHaveBeenCalledWith(
      ID,
      1,
      KEY,
      PROGRESS_INPUT,
    );
    expect(store.service.completeAssignment).toHaveBeenCalledWith(ID, 2, KEY, ID);
    expect(store.audit.record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'knowledge.assignment.create',
      riskLevel: 'R1',
      metadata: {
        onboardingInstanceId: ONBOARDING_ID,
        status: 'assigned',
        version: 1,
      },
    }));
    expect(store.audit.record).toHaveBeenNthCalledWith(3, expect.objectContaining({
      action: 'knowledge.assignment.complete',
      riskLevel: 'R2',
      metadata: {
        onboardingInstanceId: ONBOARDING_ID,
        status: 'completed',
        version: 3,
      },
    }));
  });

  it('课程与任务读取复用应用服务并输出对应版本 ETag', async () => {
    const store = fixture();

    await expect(store.controller.getCourse(
      ID,
      store.response as never,
    )).resolves.toEqual(COURSE);
    await expect(store.controller.listAssignments(ONBOARDING_ID))
      .resolves.toEqual({ items: [ASSIGNMENT] });
    await expect(store.controller.getAssignment(
      ID,
      store.response as never,
    )).resolves.toEqual(ASSIGNMENT);

    expect(store.service.getCourse).toHaveBeenCalledWith(ID);
    expect(store.service.listOnboardingAssignments).toHaveBeenCalledWith(ONBOARDING_ID);
    expect(store.service.getAssignment).toHaveBeenCalledWith(ID);
    expect(store.response.setHeader.mock.calls).toEqual([
      ['ETag', '"1"'],
      ['ETag', '"1"'],
    ]);
  });

  it('本人任务目录复用应用服务并记录 R0 读取审计', async () => {
    const store = fixture();
    await expect(store.controller.listMyAssignments()).resolves.toEqual({ items: [] });
    expect(store.service.listMyAssignments).toHaveBeenCalledOnce();
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'knowledge.assignment.mine.read',
      resourceType: 'knowledge_training_assignment_list',
      resourceId: 'mine',
      riskLevel: 'R0',
      metadata: { count: 0 },
    }));
  });

  it('本人知识检索不把查询正文写入审计，并覆盖显式与默认分页口径', async () => {
    const store = fixture();
    await expect(store.controller.searchMyKnowledge({
      query: '信息安全',
      limit: 10,
    })).resolves.toEqual({ items: [], nextCursor: null });
    store.service.searchMyKnowledge.mockResolvedValueOnce({
      items: [{ course: COURSE }],
      nextCursor: 'a'.repeat(16),
    });
    await store.controller.searchMyKnowledge({ query: '安全制度' });

    expect(store.service.searchMyKnowledge).toHaveBeenNthCalledWith(1, {
      query: '信息安全',
      limit: 10,
    });
    expect(store.audit.record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'knowledge.search.read',
      metadata: { count: 0, limit: 10, hasNextPage: false },
    }));
    expect(store.audit.record).toHaveBeenNthCalledWith(2, expect.objectContaining({
      metadata: { count: 1, limit: 10, hasNextPage: true },
    }));
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toMatch(/信息安全|安全制度/u);
  });

  it('业务提交后的审计故障只告警，仍返回已提交结果和版本', async () => {
    const store = fixture();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store.audit.record.mockRejectedValueOnce(new Error('WORM 暂时不可用'));

    await expect(store.controller.createCourse(
      KEY,
      COURSE_INPUT,
      store.response as never,
    )).resolves.toEqual({ course: COURSE });

    expect(store.service.createCourse).toHaveBeenCalledOnce();
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"1"');
    expect(error).toHaveBeenCalledWith({
      code: 'KNOWLEDGE_AUDIT_AFTER_COMMIT_FAILED',
      action: 'knowledge.course.create',
      resourceType: 'knowledge_course',
      resourceId: ID,
      riskLevel: 'R2',
    });
  });

  it('读取审计失败保持失败关闭，不套用写入后的提交语义', async () => {
    const store = fixture();
    store.audit.record.mockRejectedValueOnce(new Error('审计不可用'));
    await expect(store.controller.listMyAssignments()).rejects.toThrow('审计不可用');
  });

  it('非法资源标识、幂等键与强版本均在调用应用服务前拒绝', async () => {
    const store = fixture();

    await expect(store.controller.getCourse(
      'not-an-id',
      store.response as never,
    )).rejects.toMatchObject({ response: { code: 'KNOWLEDGE_ID_INVALID' } });
    await expect(store.controller.createCourse(
      undefined,
      COURSE_INPUT,
      store.response as never,
    )).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    await expect(store.controller.assignCourse(
      ONBOARDING_ID,
      '',
      ASSIGNMENT_INPUT,
      store.response as never,
    )).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    await expect(store.controller.publishCourse(
      ID,
      undefined,
      KEY,
      store.response as never,
    )).rejects.toMatchObject({ response: { code: 'KNOWLEDGE_IF_MATCH_REQUIRED' } });
    await expect(store.controller.publishCourse(
      ID,
      '"9007199254740992"',
      KEY,
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.controller.completeAssignment(
      'not-an-id',
      '"2"',
      KEY,
      {},
      store.response as never,
    )).rejects.toMatchObject({ response: { code: 'KNOWLEDGE_ID_INVALID' } });

    expect(store.service.getCourse).not.toHaveBeenCalled();
    expect(store.service.createCourse).not.toHaveBeenCalled();
    expect(store.service.assignCourse).not.toHaveBeenCalled();
    expect(store.service.publishCourse).not.toHaveBeenCalled();
    expect(store.service.completeAssignment).not.toHaveBeenCalled();
  });
});

function scope(name: keyof KnowledgeController): unknown {
  const method = Object.getOwnPropertyDescriptor(
    KnowledgeController.prototype,
    name,
  )?.value as object;
  return Reflect.getMetadata(REQUIRED_SCOPES_KEY, method) as unknown;
}
