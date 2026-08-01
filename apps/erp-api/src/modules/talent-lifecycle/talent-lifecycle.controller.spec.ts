import { BadRequestException, Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import type {
  TalentLifecycleDetail,
  TalentLifecycleService,
} from './application/talent-lifecycle.service.js';
import { TalentLifecycleController } from './talent-lifecycle.controller.js';

const CANDIDATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y6';
const TOUCHPOINT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4Y7';
const KEY = 'talent-touchpoint-001';
const OCCURRED_AT = '2026-07-28T01:00:00.000Z';
const NEXT_ACTION_AT = '2026-08-01T01:00:00.000Z';
const createBody = {
  kind: 'candidate_outreach',
  channel: 'email',
  direction: 'outbound',
  outcome: 'follow_up_required',
  occurredAt: OCCURRED_AT,
  nextActionAt: NEXT_ACTION_AT,
  note: '等待候选人反馈',
} as const;
const touchpoint = {
  id: TOUCHPOINT_ID,
  candidateId: CANDIDATE_ID,
  kind: createBody.kind,
  channel: createBody.channel,
  direction: createBody.direction,
  outcome: createBody.outcome,
  ownerActorId: 'actor-001',
  occurredAt: OCCURRED_AT,
  nextActionAt: NEXT_ACTION_AT,
  status: 'open',
  version: 1,
} as const;

function fixture() {
  const lifecycle = {
    list: vi.fn(),
    get: vi.fn(),
    createTouchpoint: vi.fn(),
    closeTouchpoint: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const controller = new TalentLifecycleController(
    lifecycle as unknown as TalentLifecycleService,
    audit as unknown as AuditService,
  );
  return {
    controller,
    lifecycle,
    audit,
    response: { setHeader: vi.fn() },
  };
}

describe('TalentLifecycleController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('读取与服务触点写入使用分离的最小 Scope', () => {
    expect(scope('list')).toEqual(['erp:talent-lifecycle:read']);
    expect(scope('get')).toEqual(['erp:talent-lifecycle:read']);
    expect(scope('createTouchpoint')).toEqual([
      'erp:talent-lifecycle:read',
      'erp:talent-lifecycle:touchpoint:write',
    ]);
    expect(scope('closeTouchpoint')).toEqual([
      'erp:talent-lifecycle:read',
      'erp:talent-lifecycle:touchpoint:write',
    ]);
  });

  it('列表与详情读取仅把白名单参数交给应用服务并压缩公开投影', async () => {
    const store = fixture();
    const query = { limit: 20, stage: 'recruiting' as const };
    const summary = {
      candidateId: CANDIDATE_ID,
      displayName: '候选人甲',
      stage: 'recruiting' as const,
      candidateStatus: 'active' as const,
      currentApplicationStage: 'interview',
      currentPositionTitle: '平台工程师',
      employeeStatus: null,
      activeCareStatus: null,
      alumniConsentStatus: null,
      openFollowUpCount: 1,
      nextActionAt: NEXT_ACTION_AT,
      updatedAt: OCCURRED_AT,
    };
    const listResult = {
      items: [{ ...summary, tenantId: 'tenant-001', internalEvidenceId: 'evidence-001' }],
    };
    const detail = {
      ...summary,
      personId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
      candidateContactConsentExpiresAt: '2027-07-28T01:00:00.000Z',
      candidateRetentionExpiresAt: '2028-07-28T01:00:00.000Z',
      applications: [{
        id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
        positionId: '01J8ZQK7V0A2M4N6P8R0T2W4A2',
        positionTitle: '平台工程师',
        departmentId: 'department-001',
        location: '上海',
        stage: 'interview',
        sourceChannel: 'portal',
        offerId: null,
        onboardingInstanceId: null,
        employmentId: null,
        appliedAt: OCCURRED_AT,
        endedAt: null,
        updatedAt: OCCURRED_AT,
        stageHistory: [],
      }],
      onboarding: [{
        id: '01J8ZQK7V0A2M4N6P8R0T2W4B1',
        applicationId: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
        offerId: '01J8ZQK7V0A2M4N6P8R0T2W4B2',
        departmentId: 'department-001',
        proposedStartDate: '2026-08-01',
        status: 'in_progress',
        tasks: {},
        employmentId: null,
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      }],
      employments: [{
        id: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
        employeeId: '01J8ZQK7V0A2M4N6P8R0T2W4C2',
        employeeNo: 'E001',
        displayName: '员工甲',
        employeeStatus: 'active',
        departmentIds: ['department-001'],
        primaryDepartmentId: 'department-001',
        status: 'active',
        effectiveFrom: '2026-08-01',
        effectiveTo: null,
        onboardingInstanceId: '01J8ZQK7V0A2M4N6P8R0T2W4B1',
        offerId: '01J8ZQK7V0A2M4N6P8R0T2W4B2',
        careCaseId: null,
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      }],
      care: {
        cases: [{
          id: '01J8ZQK7V0A2M4N6P8R0T2W4D1',
          employmentId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
          employeeId: '01J8ZQK7V0A2M4N6P8R0T2W4C2',
          separationType: 'voluntary_resignation',
          lastWorkingDate: '2026-12-31',
          status: 'draft',
          tasks: {},
          createdAt: OCCURRED_AT,
          updatedAt: OCCURRED_AT,
        }],
        alumniConsents: [{
          id: '01J8ZQK7V0A2M4N6P8R0T2W4D2',
          personId: '01J8ZQK7V0A2M4N6P8R0T2W4P1',
          careCaseId: '01J8ZQK7V0A2M4N6P8R0T2W4D1',
          purpose: 'alumni_network',
          channels: ['email'],
          grantedAt: OCCURRED_AT,
          expiresAt: '2027-07-28T01:00:00.000Z',
          withdrawnAt: null,
          status: 'active',
        }],
      },
      touchpoints: [{ ...touchpoint, note: '授权备注', tenantId: 'tenant-001' }],
      timeline: [{
        id: `service:${TOUCHPOINT_ID}`,
        domain: 'service',
        eventType: 'touchpoint.open',
        title: '服务跟进',
        occurredAt: OCCURRED_AT,
        referenceType: 'touchpoint',
        referenceId: TOUCHPOINT_ID,
        tenantId: 'tenant-001',
      }],
    } as unknown as TalentLifecycleDetail;
    store.lifecycle.list.mockResolvedValue(listResult);
    store.lifecycle.get.mockResolvedValue(detail);

    await expect(store.controller.list(query)).resolves.toEqual({ items: [summary] });
    const publicDetail = await store.controller.get(CANDIDATE_ID);
    expect(publicDetail).toMatchObject({
      ...summary,
      applications: [{
        id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
        positionTitle: '平台工程师',
        stage: 'interview',
        sourceChannel: 'portal',
        appliedAt: OCCURRED_AT,
      }],
      touchpoints: [{ ...touchpoint, note: '授权备注' }],
    });
    expect(JSON.stringify(publicDetail)).not.toMatch(
      /tenantId|candidateContactConsentExpiresAt|candidateRetentionExpiresAt|departmentId|employeeId|channels/iu,
    );

    expect(store.lifecycle.list).toHaveBeenCalledWith(query);
    expect(store.lifecycle.get).toHaveBeenCalledWith(CANDIDATE_ID);
  });

  it('创建触点绑定目标、幂等键、强响应版本和 R2 成功审计', async () => {
    const store = fixture();
    const result = {
      touchpoint: {
        ...touchpoint,
        tenantId: 'tenant-001',
        note: '不得进入写响应',
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      },
    };
    store.lifecycle.createTouchpoint.mockResolvedValue(result);
    store.audit.record.mockResolvedValue(undefined);

    await expect(store.controller.createTouchpoint(
      CANDIDATE_ID,
      KEY,
      createBody,
      store.response as never,
    )).resolves.toEqual({ touchpoint });

    expect(store.lifecycle.createTouchpoint).toHaveBeenCalledWith(
      CANDIDATE_ID,
      KEY,
      createBody,
    );
    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"1"');
    expect(store.audit.record).toHaveBeenCalledWith({
      action: 'talent.lifecycle.touchpoint.create',
      resourceType: 'talent_touchpoint',
      resourceId: TOUCHPOINT_ID,
      riskLevel: 'R2',
      outcome: 'success',
      metadata: {
        candidateId: CANDIDATE_ID,
        kind: 'candidate_outreach',
        channel: 'email',
        outcome: 'follow_up_required',
        status: 'open',
      },
    });
  });

  it('创建触点允许省略可选行动时间与备注且不注入 undefined 字段', async () => {
    const store = fixture();
    const request = {
      kind: createBody.kind,
      channel: createBody.channel,
      direction: createBody.direction,
      outcome: 'resolved' as const,
      occurredAt: OCCURRED_AT,
    };
    const completed = {
      ...touchpoint,
      outcome: 'resolved' as const,
      nextActionAt: null,
      status: 'completed' as const,
    };
    store.lifecycle.createTouchpoint.mockResolvedValue({ touchpoint: completed });
    store.audit.record.mockResolvedValue(undefined);

    await store.controller.createTouchpoint(
      CANDIDATE_ID,
      KEY,
      request,
      store.response as never,
    );

    expect(store.lifecycle.createTouchpoint).toHaveBeenCalledWith(
      CANDIDATE_ID,
      KEY,
      request,
    );
    expect(request).not.toHaveProperty('nextActionAt');
    expect(request).not.toHaveProperty('note');
  });

  it.each(['completed', 'cancelled'] as const)(
    '关闭触点绑定强版本、幂等键并审计 %s 终态',
    async (status) => {
      const store = fixture();
      const closed = { ...touchpoint, status, version: 2 };
      const result = { touchpoint: closed };
      store.lifecycle.closeTouchpoint.mockResolvedValue(result);
      store.audit.record.mockResolvedValue(undefined);

      await expect(store.controller.closeTouchpoint(
        TOUCHPOINT_ID,
        '"1"',
        KEY,
        { status },
        store.response as never,
      )).resolves.toEqual(result);

      expect(store.lifecycle.closeTouchpoint).toHaveBeenCalledWith(
        TOUCHPOINT_ID,
        1,
        KEY,
        { status },
      );
      expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"2"');
      expect(store.audit.record).toHaveBeenCalledWith({
        action: 'talent.lifecycle.touchpoint.close',
        resourceType: 'talent_touchpoint',
        resourceId: TOUCHPOINT_ID,
        riskLevel: 'R2',
        outcome: 'success',
        metadata: {
          candidateId: CANDIDATE_ID,
          status,
          version: 2,
        },
      });
    },
  );

  it.each([
    ['非法目标标识', 'not-an-id', KEY, createBody],
    ['非法幂等键', CANDIDATE_ID, 'short', createBody],
    ['缺少字段', CANDIDATE_ID, KEY, { ...createBody, kind: undefined }],
    ['未知字段', CANDIDATE_ID, KEY, { ...createBody, tenantId: 'attacker' }],
    ['非规范时间', CANDIDATE_ID, KEY, { ...createBody, occurredAt: '2026-07-28' }],
    ['过长备注', CANDIDATE_ID, KEY, { ...createBody, note: '甲'.repeat(1_001) }],
  ])('创建入口拒绝%s且无副作用', async (_name, id, key, body) => {
    const store = fixture();

    await expect(store.controller.createTouchpoint(
      id,
      key,
      body,
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(store.lifecycle.createTouchpoint).not.toHaveBeenCalled();
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['非法目标标识', 'not-an-id', '"1"', KEY, { status: 'completed' }],
    ['弱 If-Match', TOUCHPOINT_ID, '1', KEY, { status: 'completed' }],
    ['非字符串 If-Match', TOUCHPOINT_ID, null, KEY, { status: 'completed' }],
    ['零版本', TOUCHPOINT_ID, '"0"', KEY, { status: 'completed' }],
    ['溢出版本', TOUCHPOINT_ID, '"999999999999999999999"', KEY, { status: 'completed' }],
    ['非法幂等键', TOUCHPOINT_ID, '"1"', 'short', { status: 'completed' }],
    ['非法终态', TOUCHPOINT_ID, '"1"', KEY, { status: 'open' }],
    ['未知字段', TOUCHPOINT_ID, '"1"', KEY, { status: 'completed', tenantId: 'attacker' }],
  ])('关闭入口拒绝%s且无副作用', async (_name, id, version, key, body) => {
    const store = fixture();

    await expect(store.controller.closeTouchpoint(
      id,
      version,
      key,
      body,
      store.response as never,
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(store.lifecycle.closeTouchpoint).not.toHaveBeenCalled();
    expect(store.audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['createTouchpoint', 'talent.lifecycle.touchpoint.create', 'talent_candidate', CANDIDATE_ID],
    ['closeTouchpoint', 'talent.lifecycle.touchpoint.close', 'talent_touchpoint', TOUCHPOINT_ID],
  ] as const)('业务失败保留原异常并记录 %s 失败审计', async (
    operation,
    action,
    resourceType,
    resourceId,
  ) => {
    const store = fixture();
    const businessError = new Error('BUSINESS_FAILURE');
    store.lifecycle[operation].mockRejectedValue(businessError);
    store.audit.record.mockResolvedValue(undefined);
    const call = operation === 'createTouchpoint'
      ? store.controller.createTouchpoint(
        CANDIDATE_ID,
        KEY,
        createBody,
        store.response as never,
      )
      : store.controller.closeTouchpoint(
        TOUCHPOINT_ID,
        '"1"',
        KEY,
        { status: 'completed' },
        store.response as never,
      );

    await expect(call).rejects.toBe(businessError);
    expect(store.audit.record).toHaveBeenCalledWith({
      action,
      resourceType,
      resourceId,
      riskLevel: 'R2',
      outcome: 'failure',
      metadata: {},
    });
    expect(store.response.setHeader).not.toHaveBeenCalled();
  });

  it('失败审计自身故障不覆盖业务异常', async () => {
    const store = fixture();
    const businessError = new Error('BUSINESS_FAILURE');
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store.lifecycle.createTouchpoint.mockRejectedValue(businessError);
    store.audit.record.mockRejectedValue(new Error('AUDIT_UNAVAILABLE'));

    await expect(store.controller.createTouchpoint(
      CANDIDATE_ID,
      KEY,
      createBody,
      store.response as never,
    )).rejects.toBe(businessError);

    expect(logger).toHaveBeenCalledWith({
      code: 'TALENT_LIFECYCLE_FAILURE_AUDIT_FAILED',
      action: 'talent.lifecycle.touchpoint.create',
      resourceId: CANDIDATE_ID,
    });
  });

  it('事务提交后的成功审计故障不把已成功写入回报为失败', async () => {
    const store = fixture();
    const result = { touchpoint };
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store.lifecycle.createTouchpoint.mockResolvedValue(result);
    store.audit.record.mockRejectedValue(new Error('AUDIT_UNAVAILABLE'));

    await expect(store.controller.createTouchpoint(
      CANDIDATE_ID,
      KEY,
      createBody,
      store.response as never,
    )).resolves.toEqual(result);

    expect(store.response.setHeader).toHaveBeenCalledWith('ETag', '"1"');
    expect(logger).toHaveBeenCalledWith({
      code: 'TALENT_LIFECYCLE_AUDIT_AFTER_COMMIT_FAILED',
      action: 'talent.lifecycle.touchpoint.create',
      resourceId: TOUCHPOINT_ID,
    });
  });
});

function scope(name: keyof TalentLifecycleController): unknown {
  const method = Object.getOwnPropertyDescriptor(
    TalentLifecycleController.prototype,
    name,
  )?.value as object;
  return Reflect.getMetadata(REQUIRED_SCOPES_KEY, method) as unknown;
}
