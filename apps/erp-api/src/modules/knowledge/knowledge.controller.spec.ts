import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { KnowledgeApplicationService } from './application/knowledge-application.service.js';
import { KnowledgeController } from './knowledge.controller.js';

const ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';

function fixture() {
  const service = {
    listMyAssignments: vi.fn().mockResolvedValue({ items: [] }),
    searchMyKnowledge: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    retireCourse: vi.fn().mockResolvedValue({ course: {
      id: ID, status: 'retired', version: 3,
    } }),
    completeAssignment: vi.fn().mockResolvedValue({ assignment: {
      id: ID, onboardingInstanceId: ID, status: 'completed', version: 3,
    } }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new KnowledgeController(
    service as unknown as KnowledgeApplicationService,
    audit as unknown as AuditService,
  );
  return { controller, service, audit, response: { setHeader: vi.fn() } };
}

describe('KnowledgeController', () => {
  it('写接口声明精确 Scope，考试与完成不向通用人工任务 Scope 开放', () => {
    expect(scope('createCourse')).toEqual(['erp:knowledge:course:create']);
    expect(scope('publishCourse')).toEqual(['erp:knowledge:course:publish']);
    expect(scope('retireCourse')).toEqual(['erp:knowledge:course:publish']);
    expect(scope('getCourse')).toEqual(['erp:knowledge:course:read']);
    expect(scope('listMyAssignments')).toEqual(['erp:knowledge:assignment:read']);
    expect(scope('searchMyKnowledge')).toEqual(['erp:knowledge:search']);
    expect(scope('recordProgress')).toEqual(['erp:integration:knowledge:progress']);
    expect(Object.getOwnPropertyDescriptor(
      KnowledgeController.prototype,
      'gradeExam',
    )).toBeUndefined();
    expect(scope('completeAssignment')).toEqual(['erp:knowledge:assignment:complete']);
  });

  it('完成接口强制严格 ULID、If-Match 与幂等键', async () => {
    const store = fixture();
    await expect(store.controller.completeAssignment(
      ID, undefined, 'knowledge-complete-001', {}, store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.controller.completeAssignment(
      'not-an-id', '"2"', 'knowledge-complete-001', {}, store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(store.service.completeAssignment).not.toHaveBeenCalled();
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

  it('本人知识检索不把查询正文写入审计', async () => {
    const store = fixture();
    await expect(store.controller.searchMyKnowledge({
      query: '信息安全',
      limit: 10,
    })).resolves.toEqual({ items: [], nextCursor: null });
    expect(store.service.searchMyKnowledge).toHaveBeenCalledWith({
      query: '信息安全',
      limit: 10,
    });
    expect(store.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'knowledge.search.read',
      resourceType: 'knowledge_search_result',
      resourceId: 'mine',
      riskLevel: 'R0',
      metadata: { count: 0, limit: 10, hasNextPage: false },
    }));
    expect(JSON.stringify(store.audit.record.mock.calls)).not.toContain('信息安全');
  });
});

function scope(name: keyof KnowledgeController): unknown {
  const method = Object.getOwnPropertyDescriptor(
    KnowledgeController.prototype, name,
  )?.value as object;
  return Reflect.getMetadata(REQUIRED_SCOPES_KEY, method) as unknown;
}
