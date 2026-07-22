import { describe, expect, it } from 'vitest';

import { parsePersonalKnowledgeAssignments } from './knowledge-contract.js';

const ID = '01J8ZQK7V0A2M4N6P8R0T2W4A1';

function response() {
  return { items: [{
    id: ID,
    course: {
      id: ID, courseCode: 'SECURITY', revision: 1, title: '安全培训', examRequired: true,
      passingScoreBps: 8_000, status: 'published', version: 2,
    },
    mandatory: true, examRequired: true, dueDate: '2026-08-31',
    status: 'in_progress', progressBps: 6_500, version: 3,
  }] };
}

describe('移动知识任务契约', () => {
  it('只接受脱敏课程与任务摘要并冻结结果', () => {
    const result = parsePersonalKnowledgeAssignments(response());
    expect(result[0]).toMatchObject({ course: { title: '安全培训' }, progressBps: 6_500 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]?.course)).toBe(true);
  });

  it('拒绝租户、入职、内容、题库、答卷和证据字段', () => {
    for (const field of ['tenantId', 'onboardingInstanceId', 'contentRef', 'questionBankRef', 'submissionRef', 'completionEvidenceId']) {
      const value = response();
      Object.assign(value.items[0]!, { [field]: 'secret-ref' });
      expect(() => parsePersonalKnowledgeAssignments(value)).toThrowError('KNOWLEDGE_ASSIGNMENTS_INVALID');
    }
  });

  it('拒绝越界进度、非法日期和课程考试标记不一致', () => {
    expect(() => parsePersonalKnowledgeAssignments({ ...response(), items: [{ ...response().items[0], progressBps: 10_001 }] }))
      .toThrowError('KNOWLEDGE_ASSIGNMENTS_INVALID');
    expect(() => parsePersonalKnowledgeAssignments({ ...response(), items: [{ ...response().items[0], dueDate: '2026-02-30' }] }))
      .toThrowError('KNOWLEDGE_ASSIGNMENTS_INVALID');
    expect(() => parsePersonalKnowledgeAssignments({ ...response(), items: [{ ...response().items[0], examRequired: false }] }))
      .toThrowError('KNOWLEDGE_ASSIGNMENTS_INVALID');
  });
});
