import { BadRequestException, HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';

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
    expect(store.service.submit).not.toHaveBeenCalled();
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
