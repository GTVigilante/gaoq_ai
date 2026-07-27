import { BadRequestException, HttpStatus, Logger } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { KnowledgeExamRunService } from './application/knowledge-exam-run.service.js';
import { KnowledgeExamRunController } from './knowledge-exam-run.controller.js';

const ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';

function fixture() {
  const examRun = {
    id: ID,
    assignmentId: ID,
    courseVersionId: ID,
    attemptNumber: 1,
    questionMode: 'mixed' as const,
    gradingPolicyVersion: 'mixed-v2',
    passingRule: 'all_required_sections' as const,
    gradingSlaMinutes: 5,
    manualReviewSlaMinutes: 1_440,
    manualReviewRequired: true,
    status: 'starting' as const,
    startedAt: null,
    deadlineAt: null,
    submittedAt: null,
    submissionReason: null,
    timedOut: false,
    finalAttemptId: null,
    version: 1,
  };
  const service = {
    start: vi.fn().mockResolvedValue({ examRun }),
    submit: vi.fn().mockResolvedValue({
      examRun: { ...examRun, status: 'submitted', version: 3 },
    }),
    get: vi.fn().mockResolvedValue(examRun),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const response = { setHeader: vi.fn() };
  return {
    controller: new KnowledgeExamRunController(
      service as unknown as KnowledgeExamRunService,
      audit as unknown as AuditService,
    ),
    service,
    audit,
    response,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KnowledgeExamRunController', () => {
  it('只暴露精确开始、提交和本人读取 Scope，异步写接口返回 202', () => {
    expect(scope('start')).toEqual(['erp:knowledge:exam:start']);
    expect(scope('submit')).toEqual(['erp:knowledge:exam:submit']);
    expect(scope('get')).toEqual(['erp:knowledge:exam:read']);
    expect(httpCode('start')).toBe(HttpStatus.ACCEPTED);
    expect(httpCode('submit')).toBe(HttpStatus.ACCEPTED);
  });

  it('开始考试设置 ETag、轮询提示并记录不含题库引用的 R1 审计', async () => {
    const store = fixture();
    await store.controller.start(ID, 'exam-start-001', store.response as never);
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"1"');
    expect(store.response.setHeader).toHaveBeenCalledWith('Retry-After', '2');
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'knowledge.exam.run.start',
      riskLevel: 'R1',
      resourceId: ID,
    }));
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toMatch(
      /questionBank|submissionRef|evidence/iu,
    );
  });

  it('提交强制 ULID、强 If-Match 和幂等键', async () => {
    const store = fixture();
    await expect(store.controller.submit(
      ID,
      '2',
      'exam-submit-001',
      { submissionRef: ID },
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.controller.submit(
      'not-an-id',
      '"2"',
      'exam-submit-001',
      { submissionRef: ID },
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.controller.submit(
      ID,
      '"9007199254740992"',
      'exam-submit-001',
      { submissionRef: ID },
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.controller.submit(
      ID,
      '"2"',
      undefined,
      { submissionRef: ID },
      store.response as never,
    )).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
    await expect(store.controller.start(
      ID,
      undefined,
      store.response as never,
    )).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
    await expect(store.controller.get(
      'not-an-id',
      store.response as never,
    )).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_ID_INVALID' },
    });
    expect(store.service.submit).not.toHaveBeenCalled();
    expect(store.service.start).not.toHaveBeenCalled();
    expect(store.service.get).not.toHaveBeenCalled();
  });

  it('提交设置版本与轮询提示并记录最小 R2 审计', async () => {
    const store = fixture();
    const result = await store.controller.submit(
      ID,
      '"2"',
      'exam-submit-001',
      { submissionRef: ID },
      store.response as never,
    );

    expect(result.examRun).toMatchObject({ status: 'submitted', version: 3 });
    expect(store.service.submit).toHaveBeenCalledWith(
      ID,
      2,
      'exam-submit-001',
      ID,
    );
    expect(store.response.setHeader.mock.calls).toEqual([
      ['ETag', '"3"'],
      ['Retry-After', '2'],
    ]);
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'knowledge.exam.run.submit',
      resourceType: 'knowledge_exam_run',
      resourceId: ID,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        assignmentId: ID,
        attemptNumber: 1,
        status: 'submitted',
      },
    });
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toMatch(
      /submissionRef|questionBank|evidence/iu,
    );
  });

  it('本人读取设置 ETag 并保持 R0 审计失败关闭', async () => {
    const store = fixture();
    await expect(store.controller.get(
      ID,
      store.response as never,
    )).resolves.toMatchObject({ id: ID, version: 1 });
    expect(store.service.get).toHaveBeenCalledWith(ID);
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"1"');
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'knowledge.exam.run.read',
      resourceType: 'knowledge_exam_run',
      resourceId: ID,
      riskLevel: 'R0',
      outcome: 'success',
      metadata: { status: 'starting', version: 1 },
    });

    const failed = fixture();
    failed.audit.record.mockRejectedValueOnce(new Error('审计不可用'));
    await expect(failed.controller.get(
      ID,
      failed.response as never,
    )).rejects.toThrow('审计不可用');
  });

  it.each([
    ['start', 'R1'],
    ['submit', 'R2'],
  ] as const)('考试 %s 提交后的审计故障只告警且保留成功终态', async (action, riskLevel) => {
    const store = fixture();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store.audit.record.mockRejectedValueOnce(new Error('WORM 暂时不可用'));

    const result = action === 'start'
      ? await store.controller.start(ID, 'exam-start-001', store.response as never)
      : await store.controller.submit(
        ID,
        '"2"',
        'exam-submit-001',
        { submissionRef: ID },
        store.response as never,
      );

    expect(result).toHaveProperty('examRun');
    expect(error).toHaveBeenCalledWith({
      code: 'KNOWLEDGE_EXAM_AUDIT_AFTER_COMMIT_FAILED',
      action: `knowledge.exam.run.${action}`,
      resourceType: 'knowledge_exam_run',
      resourceId: ID,
      riskLevel,
    });
  });
});

function method(name: keyof KnowledgeExamRunController): object {
  const value: unknown = Object.getOwnPropertyDescriptor(
    KnowledgeExamRunController.prototype,
    name,
  )?.value;
  if (typeof value !== 'function') throw new Error('测试目标方法不存在');
  return value;
}

function scope(name: keyof KnowledgeExamRunController): unknown {
  const metadata: unknown = Reflect.getMetadata(
    REQUIRED_SCOPES_KEY,
    method(name),
  );
  return metadata;
}

function httpCode(name: keyof KnowledgeExamRunController): unknown {
  const metadata: unknown = Reflect.getMetadata(
    HTTP_CODE_METADATA,
    method(name),
  );
  return metadata;
}
