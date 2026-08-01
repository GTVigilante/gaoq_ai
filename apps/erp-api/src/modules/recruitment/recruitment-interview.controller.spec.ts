import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type {
  RecruitmentInterviewService,
} from './application/recruitment-interview.service.js';
import { RecruitmentInterviewController } from './recruitment-interview.controller.js';

const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const INTERVIEW_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X1';
const FEEDBACK_ID = '01J8ZQK7V0A2M4N6P8R0T2W4X2';
const IDEMPOTENCY_KEY = 'interview-write-key-001';
const interview = {
  id: INTERVIEW_ID,
  applicationId: APPLICATION_ID,
  roundNumber: 1,
  mode: 'video' as const,
  startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:00:00.000Z',
  timezone: 'Asia/Shanghai',
  interviewerIds: ['employee-001'],
  status: 'scheduled' as const,
  version: 1,
  completedAt: null,
  cancelledAt: null,
};
const scheduleBody = {
  roundNumber: 1,
  mode: 'video' as const,
  startsAt: interview.startsAt,
  endsAt: interview.endsAt,
  timezone: interview.timezone,
  interviewerIds: ['employee-001'],
  location: 'https://meeting.example/protected',
};
const feedbackBody = {
  recommendation: 'hire' as const,
  score: 4,
  notes: '候选人经验匹配',
};

function fixture() {
  const service = {
    schedule: vi.fn().mockResolvedValue({ interview }),
    get: vi.fn().mockResolvedValue(interview),
    submitFeedback: vi.fn().mockResolvedValue({
      feedback: {
        id: FEEDBACK_ID,
        interviewId: INTERVIEW_ID,
        interviewerId: 'employee-001',
        submittedAt: '2026-07-22T09:01:00.000Z',
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

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('读取严格校验 ULID 并设置强 ETag', async () => {
    const store = fixture();
    await expect(store.controller.get(INTERVIEW_ID, store.response))
      .resolves.toMatchObject({ id: INTERVIEW_ID, version: 1 });
    expect(store.service.get).toHaveBeenCalledWith(INTERVIEW_ID);
    expect(store.headers.get('ETag')).toBe('"1"');
    expect(store.record).not.toHaveBeenCalled();
  });

  it('排期传递规范并写低敏 R1 成功审计', async () => {
    const store = fixture();
    const result = await store.controller.schedule(
      APPLICATION_ID,
      '"3"',
      IDEMPOTENCY_KEY,
      scheduleBody,
      store.response,
    );
    expect(store.service.schedule).toHaveBeenCalledWith(
      APPLICATION_ID,
      3,
      IDEMPOTENCY_KEY,
      scheduleBody,
    );
    expect(result.interview).not.toHaveProperty('location');
    expect(store.headers.get('ETag')).toBe('"1"');
    expect(store.record).toHaveBeenCalledWith({
      action: 'recruitment.interview.schedule',
      resourceType: 'recruitment_interview',
      resourceId: INTERVIEW_ID,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { version: 1, status: 'scheduled' },
    });
    expect(JSON.stringify(store.record.mock.calls)).not.toContain('meeting.example');
  });

  it('评价响应与审计不包含推荐、分数或 L3 原文', async () => {
    const store = fixture();
    const result = await store.controller.submitFeedback(
      INTERVIEW_ID,
      '"1"',
      IDEMPOTENCY_KEY,
      feedbackBody,
    );
    expect(store.service.submitFeedback).toHaveBeenCalledWith(
      INTERVIEW_ID,
      1,
      IDEMPOTENCY_KEY,
      feedbackBody,
    );
    expect(result.feedback).toEqual({
      id: FEEDBACK_ID,
      interviewId: INTERVIEW_ID,
      interviewerId: 'employee-001',
      submittedAt: '2026-07-22T09:01:00.000Z',
    });
    expect(store.record).toHaveBeenCalledWith({
      action: 'recruitment.interview.feedback.submit',
      resourceType: 'recruitment_interview',
      resourceId: INTERVIEW_ID,
      riskLevel: 'R1',
      outcome: 'success',
      metadata: { feedbackId: FEEDBACK_ID },
    });
    expect(JSON.stringify(store.record.mock.calls))
      .not.toMatch(/hire|候选人经验|score|notes/iu);
  });

  it.each([
    ['complete', 'completed'],
    ['cancel', 'cancelled'],
  ] as const)('%s 仅接受空正文并返回新版本', async (action, status) => {
    const store = fixture();
    const result = await store.controller[action](
      INTERVIEW_ID,
      '"1"',
      IDEMPOTENCY_KEY,
      {},
      store.response,
    );
    expect(store.service[action]).toHaveBeenCalledWith(
      INTERVIEW_ID,
      1,
      IDEMPOTENCY_KEY,
    );
    expect(result.interview).toMatchObject({ status, version: 2 });
    expect(store.headers.get('ETag')).toBe('"2"');
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: `recruitment.interview.${action}`,
      resourceId: INTERVIEW_ID,
      outcome: 'success',
      metadata: { version: 2, status },
    }));
  });

  it('完成动作允许请求正文缺失', async () => {
    const store = fixture();
    await expect(store.controller.complete(
      INTERVIEW_ID,
      '"1"',
      IDEMPOTENCY_KEY,
      undefined,
      store.response,
    )).resolves.toMatchObject({ interview: { status: 'completed' } });
  });

  it.each([
    undefined,
    1,
    '',
    '01J8ZQK7V0A2M4N6P8R0T2W4XI',
    '81J8ZQK7V0A2M4N6P8R0T2W4X1',
    '01j8zqk7v0a2m4n6p8r0t2w4x1',
  ])('拒绝非法资源 ULID：%s', async (value) => {
    const store = fixture();
    await expect(store.controller.get(value as string, store.response))
      .rejects.toMatchObject({ response: { code: 'RECRUITMENT_INVALID_ID' } });
    expect(store.service.get).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    1,
    '',
    '1',
    '"0"',
    '"01"',
    'W/"1"',
    '"-1"',
    `"${Number.MAX_SAFE_INTEGER}"`,
    '"9007199254740992"',
  ])('拒绝非正安全强 If-Match：%s', async (value) => {
    const store = fixture();
    await expect(store.controller.complete(
      INTERVIEW_ID,
      value as string,
      IDEMPOTENCY_KEY,
      undefined,
      store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_IF_MATCH_REQUIRED' } });
    expect(store.service.complete).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    1,
    '',
    'short',
    'contains space',
    '含中文字符1234',
    'a'.repeat(129),
  ])('拒绝非法幂等键：%s', async (value) => {
    const store = fixture();
    await expect(store.controller.schedule(
      APPLICATION_ID,
      '"3"',
      value as string,
      scheduleBody,
      store.response,
    )).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect(store.service.schedule).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    { outcome: 'completed' },
    Object.create(null),
    new (class UnknownBody {})(),
    { [Symbol('control')]: true },
    new Proxy({}, {
      getPrototypeOf() {
        throw new Error('proxy trap');
      },
    }),
  ])('完成或取消拒绝非精确空普通对象', async (body) => {
    const store = fixture();
    await expect(store.controller.cancel(
      INTERVIEW_ID,
      '"1"',
      IDEMPOTENCY_KEY,
      body,
      store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_INTERVIEW_BODY_FORBIDDEN' } });
    expect(store.service.cancel).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it.each([
    'schedule',
    'submitFeedback',
    'complete',
    'cancel',
  ] as const)('%s 业务失败写低敏 R1 失败审计并保留原异常', async (action) => {
    const store = fixture();
    const original = new Error('business-secret-detail');
    store.service[action].mockRejectedValueOnce(original);
    const operation = action === 'schedule'
      ? store.controller.schedule(
          APPLICATION_ID,
          '"3"',
          IDEMPOTENCY_KEY,
          scheduleBody,
          store.response,
        )
      : action === 'submitFeedback'
        ? store.controller.submitFeedback(
            INTERVIEW_ID,
            '"1"',
            IDEMPOTENCY_KEY,
            feedbackBody,
          )
        : store.controller[action](
            INTERVIEW_ID,
            '"1"',
            IDEMPOTENCY_KEY,
            undefined,
            store.response,
          );
    await expect(operation).rejects.toBe(original);
    expect(store.record).toHaveBeenCalledWith({
      action: action === 'submitFeedback'
        ? 'recruitment.interview.feedback.submit'
        : `recruitment.interview.${action}`,
      resourceType: action === 'schedule'
        ? 'recruitment_application'
        : 'recruitment_interview',
      resourceId: action === 'schedule' ? APPLICATION_ID : INTERVIEW_ID,
      riskLevel: 'R1',
      outcome: 'failure',
      metadata: { expectedVersion: action === 'schedule' ? 3 : 1 },
    });
    expect(JSON.stringify(store.record.mock.calls)).not.toContain('business-secret-detail');
  });

  it('失败审计自身异常不覆盖原始业务异常', async () => {
    const store = fixture();
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const original = new Error('original-business-failure');
    store.service.cancel.mockRejectedValueOnce(original);
    store.record.mockRejectedValueOnce(new Error('audit-storage-secret'));
    await expect(store.controller.cancel(
      INTERVIEW_ID,
      '"1"',
      IDEMPOTENCY_KEY,
      undefined,
      store.response,
    )).rejects.toBe(original);
    expect(log).toHaveBeenCalledWith({
      code: 'RECRUITMENT_INTERVIEW_FAILURE_AUDIT_FAILED',
      action: 'recruitment.interview.cancel',
      resourceId: INTERVIEW_ID,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/original-business|audit-storage/iu);
  });

  it('事务提交后的面试成功审计异常不改变响应或 ETag', async () => {
    const store = fixture();
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store.record.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(store.controller.schedule(
      APPLICATION_ID,
      '"3"',
      IDEMPOTENCY_KEY,
      scheduleBody,
      store.response,
    )).resolves.toEqual({ interview });
    expect(store.headers.get('ETag')).toBe('"1"');
    expect(log).toHaveBeenCalledWith({
      code: 'RECRUITMENT_INTERVIEW_AUDIT_AFTER_COMMIT_FAILED',
      action: 'recruitment.interview.schedule',
      resourceId: INTERVIEW_ID,
    });
  });

  it('事务提交后的评价成功审计异常不诱发评价重放', async () => {
    const store = fixture();
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store.record.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(store.controller.submitFeedback(
      INTERVIEW_ID,
      '"1"',
      IDEMPOTENCY_KEY,
      feedbackBody,
    )).resolves.toMatchObject({ feedback: { id: FEEDBACK_ID } });
    expect(store.service.submitFeedback).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      code: 'RECRUITMENT_INTERVIEW_AUDIT_AFTER_COMMIT_FAILED',
      action: 'recruitment.interview.feedback.submit',
      resourceId: INTERVIEW_ID,
    });
  });
});

type MethodName = 'schedule' | 'get' | 'submitFeedback' | 'complete' | 'cancel';

function method(name: MethodName): object {
  const value: unknown = Object.getOwnPropertyDescriptor(
    RecruitmentInterviewController.prototype,
    name,
  )?.value;
  if (typeof value !== 'function') throw new Error(`控制器方法 ${name} 不存在`);
  return value;
}
