import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type { RecruitmentApplicationService } from './application/recruitment-application.service.js';
import { RecruitmentController } from './recruitment.controller.js';

const APPLICATION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const POSITION_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y8';
const application = {
  id: APPLICATION_ID,
  candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
  positionId: POSITION_ID,
  stage: 'applied' as const,
  version: 1,
  appliedAt: '2026-07-21T00:00:00.000Z',
  endedAt: null,
};

function fixture() {
  const createApplication = vi.fn().mockResolvedValue({ application });
  const transitionApplication = vi.fn().mockResolvedValue({
    application: { ...application, stage: 'screening', version: 2 },
  });
  const getApplication = vi.fn().mockResolvedValue(application);
  const record = vi.fn().mockResolvedValue(undefined);
  const headers = new Map<string, string>();
  const response = {
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
  } as unknown as Response;
  const controller = new RecruitmentController(
    { createApplication, transitionApplication, getApplication } as unknown as RecruitmentApplicationService,
    { record } as unknown as AuditService,
  );
  return { controller, createApplication, transitionApplication, getApplication, record, headers, response };
}

describe('RecruitmentController', () => {
  it('三个端点声明独立最小 Scope', () => {
    expect(Reflect.getMetadata(
      REQUIRED_SCOPES_KEY, method('create'),
    )).toEqual(['erp:recruitment:application:create']);
    expect(Reflect.getMetadata(
      REQUIRED_SCOPES_KEY, method('get'),
    )).toEqual(['erp:recruitment:application:read']);
    expect(Reflect.getMetadata(
      REQUIRED_SCOPES_KEY, method('transition'),
    )).toEqual(['erp:recruitment:application:transition']);
  });

  it('创建强制幂等键，返回 ETag 并只审计摘要', async () => {
    const store = fixture();
    const body = {
      positionId: POSITION_ID, sourceChannel: 'portal',
      candidate: { name: '张三', phone: '+8613800138000' },
      consent: {
        version: 'privacy-v1', purpose: '招聘评估', source: 'portal' as const,
        expiresAt: '2027-01-01T00:00:00.000Z',
        retentionExpiresAt: '2028-01-01T00:00:00.000Z',
      },
    };
    await expect(store.controller.create(undefined, body, store.response))
      .rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    const result = await store.controller.create('create-key-001', body, store.response);
    expect(result.application.id).toBe(APPLICATION_ID);
    expect(store.headers.get('ETag')).toBe('"1"');
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recruitment.application.create', resourceId: APPLICATION_ID,
      metadata: { version: 1, stage: 'applied' },
    }));
    expect(JSON.stringify(store.record.mock.calls)).not.toMatch(/张三|13800138000/iu);
  });

  it('阶段变更强制严格 ULID、If-Match 和幂等键', async () => {
    const store = fixture();
    await expect(store.controller.transition(
      APPLICATION_ID, '1', 'transition-key-001', { targetStage: 'screening' }, store.response,
    )).rejects.toMatchObject({ response: { code: 'RECRUITMENT_IF_MATCH_REQUIRED' } });
    const result = await store.controller.transition(
      APPLICATION_ID, '"1"', 'transition-key-001', { targetStage: 'screening' }, store.response,
    );
    expect(result.application).toMatchObject({ stage: 'screening', version: 2 });
    expect(store.transitionApplication).toHaveBeenCalledWith(
      APPLICATION_ID, 1, 'transition-key-001', { targetStage: 'screening' },
    );
    expect(store.headers.get('ETag')).toBe('"2"');
  });
});

function method(name: 'create' | 'get' | 'transition'): object {
  const value: unknown = Object.getOwnPropertyDescriptor(RecruitmentController.prototype, name)?.value;
  if (typeof value !== 'function') throw new Error(`控制器方法 ${name} 不存在`);
  return value;
}
