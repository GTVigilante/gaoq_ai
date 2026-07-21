import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { RecruitmentInterviewService } from './application/recruitment-interview.service.js';
import { RecruitmentInterviewController } from './recruitment-interview.controller.js';

const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const INTERVIEW_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X1';
const interview = {
  id: INTERVIEW_ID, applicationId: APPLICATION_ID, roundNumber: 1, mode: 'video' as const,
  startsAt: '2026-07-22T08:00:00.000Z', endsAt: '2026-07-22T09:00:00.000Z',
  timezone: 'Asia/Shanghai', interviewerIds: ['employee-001'], status: 'scheduled' as const,
  version: 1, completedAt: null, cancelledAt: null,
};

function fixture() {
  const service = {
    schedule: vi.fn().mockResolvedValue({ interview }),
    get: vi.fn().mockResolvedValue(interview),
    submitFeedback: vi.fn().mockResolvedValue({
      feedback: {
        id: '01J8ZQK7V0A2M4N6P8R0T2W4X2', interviewId: INTERVIEW_ID,
        interviewerId: 'employee-001', submittedAt: '2026-07-22T09:01:00.000Z',
      },
    }),
    complete: vi.fn().mockResolvedValue({
      interview: { ...interview, status: 'completed', version: 2 },
    }),
    cancel: vi.fn().mockResolvedValue({
      interview: { ...interview, status: 'cancelled', version: 2 },
    }),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const headers = new Map<string, string>();
  const response = {
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
  } as unknown as Response;
  const controller = new RecruitmentInterviewController(
    service as unknown as RecruitmentInterviewService,
    { record } as unknown as AuditService,
  );
  return { controller, service, record, headers, response };
}

describe('RecruitmentInterviewController', () => {
  it('五个端点声明独立最小 Scope', () => {
    const expected: Readonly<Record<MethodName, string>> = {
      schedule: 'erp:recruitment:interview:schedule',
      get: 'erp:recruitment:interview:read',
      submitFeedback: 'erp:recruitment:interview:feedback',
      complete: 'erp:recruitment:interview:complete',
      cancel: 'erp:recruitment:interview:cancel',
    };
    for (const [name, scope] of Object.entries(expected) as [MethodName, string][]) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, method(name))).toEqual([scope]);
    }
  });

  it('排期强制幂等键，响应与审计不携带会议链接', async () => {
    const store = fixture();
    const body = {
      roundNumber: 1, mode: 'video' as const,
      startsAt: interview.startsAt, endsAt: interview.endsAt, timezone: interview.timezone,
      interviewerIds: ['employee-001'], location: 'https://meeting.example/secret',
    };
    await expect(store.controller.schedule(
      APPLICATION_ID, '"3"', undefined, body, store.response,
    ))
      .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    const result = await store.controller.schedule(
      APPLICATION_ID, '"3"', 'interview-schedule-key-001', body, store.response,
    );
    expect(result.interview).not.toHaveProperty('location');
    expect(store.headers.get('ETag')).toBe('"1"');
    expect(JSON.stringify(store.record.mock.calls)).not.toContain('meeting.example');
  });

  it('评价审计只记证据 ID，不记推荐、分数和原文', async () => {
    const store = fixture();
    const result = await store.controller.submitFeedback(
      INTERVIEW_ID, '"1"', 'interview-feedback-key-001',
      { recommendation: 'hire', score: 4, notes: '候选人经验匹配' },
    );
    expect(result.feedback).not.toHaveProperty('recommendation');
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recruitment.interview.feedback.submit', resourceId: INTERVIEW_ID,
      metadata: { feedbackId: result.feedback.id },
    }));
    expect(JSON.stringify(store.record.mock.calls)).not.toMatch(/hire|候选人经验|score|notes/iu);
  });

  it('完成和取消强制强 If-Match', async () => {
    const store = fixture();
    await expect(store.controller.complete(
      INTERVIEW_ID, '1', 'interview-complete-key-001', store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_IF_MATCH_REQUIRED' } });
    const result = await store.controller.complete(
      INTERVIEW_ID, '"1"', 'interview-complete-key-001', store.response,
    );
    expect(store.service.complete).toHaveBeenCalledWith(
      INTERVIEW_ID, 1, 'interview-complete-key-001',
    );
    expect(result.interview).toMatchObject({ status: 'completed', version: 2 });
    expect(store.headers.get('ETag')).toBe('"2"');
  });
});

type MethodName = 'schedule' | 'get' | 'submitFeedback' | 'complete' | 'cancel';

function method(name: MethodName): object {
  const value: unknown = Object.getOwnPropertyDescriptor(
    RecruitmentInterviewController.prototype, name,
  )?.value;
  if (typeof value !== 'function') throw new Error(`控制器方法 ${name} 不存在`);
  return value;
}
