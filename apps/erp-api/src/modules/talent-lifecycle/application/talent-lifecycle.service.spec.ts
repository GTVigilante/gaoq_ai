import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { CareTalentSourceService } from '../../care/application/care-talent-source.service.js';
import type { OnboardingTalentSourceService } from '../../onboarding/application/onboarding-talent-source.service.js';
import type { OrgTalentSourceService } from '../../org/application/org-talent-source.service.js';
import type { RecruitmentTalentSourceService } from '../../recruitment/application/recruitment-talent-source.service.js';
import type { TalentLifecycleOutboxWriter } from '../persistence/talent-lifecycle-outbox.writer.js';
import {
  TalentTouchpointWriteConflictError,
  type TalentTouchpointRepository,
} from '../persistence/talent-lifecycle.repository.js';
import { TalentLifecycleService } from './talent-lifecycle.service.js';

const candidate = Object.freeze({
  candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
  displayName: '候选人甲',
  candidateStatus: 'active' as const,
  contactConsentExpiresAt: '2027-07-27T00:00:00.000Z',
  retentionExpiresAt: '2028-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
  applications: Object.freeze([Object.freeze({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4E2',
    positionId: '01J8ZQK7V0A2M4N6P8R0T2W4E3',
    positionTitle: '后端工程师',
    departmentId: 'department-001',
    location: '上海',
    stage: 'interview' as const,
    sourceChannel: 'portal',
    offerId: null,
    onboardingInstanceId: null,
    employmentId: null,
    appliedAt: '2026-07-20T00:00:00.000Z',
    endedAt: null,
    updatedAt: '2026-07-26T00:00:00.000Z',
    stageHistory: Object.freeze([]),
  })]),
});

const ownedTouchpoint = Object.freeze({
  id: '01J8ZQK7V0A2M4N6P8R0T2W4T1',
  tenantId: 'tenant-001',
  candidateId: candidate.candidateId,
  kind: 'candidate_outreach' as const,
  channel: 'phone' as const,
  direction: 'outbound' as const,
  outcome: 'follow_up_required' as const,
  ownerActorId: 'employee-001',
  occurredAt: '2026-07-27T07:30:00.000Z',
  nextActionAt: '2026-07-28T07:30:00.000Z',
  status: 'open' as const,
  note: '仅授权后解密的备注',
  version: 1,
  createdAt: '2026-07-27T08:00:00.000Z',
  updatedAt: '2026-07-27T08:00:00.000Z',
});

function fixture(
  alumniConsents: readonly Record<string, unknown>[] = [],
  candidateTouchpoints: readonly Record<string, unknown>[] = [],
) {
  const context = new TenantContextService();
  const recruitment = {
    get: vi.fn().mockResolvedValue(candidate),
    listRecent: vi.fn().mockResolvedValue([candidate]),
  };
  const onboarding = { getByCandidateId: vi.fn().mockResolvedValue([]) };
  const organization = { getByCandidateId: vi.fn().mockResolvedValue(null) };
  const care = {
    getByEmploymentIds: vi.fn().mockResolvedValue({
      cases: [],
      alumniConsents,
    }),
  };
  const touchpoints = {
    findByCandidateId: vi.fn().mockResolvedValue(candidateTouchpoints),
    insert: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn(),
    findAuthorizationRoute: vi.fn(),
    replace: vi.fn(),
  };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const session = {} as ClientSession;
  const idempotency = {
    execute: vi.fn((
      _operation: string,
      _key: string,
      _request: unknown,
      handler: (value: ClientSession) => Promise<Record<string, unknown>>,
    ) => handler(session)),
  };
  const service = new TalentLifecycleService(
    context,
    idempotency as unknown as IdempotencyService,
    recruitment as unknown as RecruitmentTalentSourceService,
    onboarding as unknown as OnboardingTalentSourceService,
    organization as unknown as OrgTalentSourceService,
    care as unknown as CareTalentSourceService,
    touchpoints as unknown as TalentTouchpointRepository,
    outbox as unknown as TalentLifecycleOutboxWriter,
  );
  const run = <T>(operation: () => Promise<T>) => context.run({
    tenant: { tenantId: 'tenant-001', source: 'access_token' },
    actor: {
      actorId: 'employee-001',
      actorType: 'user',
      tenantId: 'tenant-001',
      roleCodes: ['recruiter'],
      scopes: [
        'erp:talent-lifecycle:read',
        'erp:talent-lifecycle:touchpoint:write',
      ],
      departmentIds: ['department-001'],
      traceId: 'trace-talent-001',
    },
  }, operation);
  const runAs = <T>(
    operation: () => Promise<T>,
    scopes: readonly string[],
    actorId = 'employee-001',
  ) => context.run({
    tenant: { tenantId: 'tenant-001', source: 'access_token' },
    actor: {
      actorId,
      actorType: 'user',
      tenantId: 'tenant-001',
      roleCodes: ['recruiter'],
      scopes,
      departmentIds: ['department-001'],
      traceId: 'trace-talent-custom',
    },
  }, operation);
  return {
    service,
    run,
    runAs,
    recruitment,
    onboarding,
    organization,
    care,
    touchpoints,
    outbox,
    idempotency,
  };
}

describe('TalentLifecycleService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T08:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('组装招聘阶段并以可信主体创建加密前服务触点', async () => {
    const store = fixture();
    const detail = await store.run(() => store.service.get(candidate.candidateId));
    expect(detail.stage).toBe('recruiting');

    const result = await store.run(() => store.service.createTouchpoint(
      candidate.candidateId,
      'talent-touchpoint-create-001',
      {
        kind: 'candidate_outreach',
        channel: 'phone',
        direction: 'outbound',
        outcome: 'follow_up_required',
        occurredAt: '2026-07-27T07:30:00.000Z',
        nextActionAt: '2026-07-28T07:30:00.000Z',
        note: '等待候选人反馈',
      },
    ));
    expect(result.touchpoint).toMatchObject({
      candidateId: candidate.candidateId,
      ownerActorId: 'employee-001',
      status: 'open',
    });
    expect(result.touchpoint).not.toHaveProperty('note');
    expect(store.touchpoints.insert).toHaveBeenCalledOnce();
    expect(store.outbox.append).toHaveBeenCalledOnce();
  });

  it('普通读取只解密本人负责的服务备注', async () => {
    const store = fixture([], [
      ownedTouchpoint,
      { ...ownedTouchpoint, id: '01J8ZQK7V0A2M4N6P8R0T2W4T2', ownerActorId: 'employee-002' },
    ]);
    const detail = await store.run(() => store.service.get(candidate.candidateId));
    expect(detail.touchpoints).toEqual([
      expect.objectContaining({ id: ownedTouchpoint.id, note: ownedTouchpoint.note }),
    ]);
  });

  it('关闭触点先以非敏感路由完成授权且幂等响应不保存备注明文', async () => {
    const store = fixture();
    store.touchpoints.findAuthorizationRoute.mockResolvedValue({
      candidateId: candidate.candidateId,
      ownerActorId: 'employee-001',
    });
    store.touchpoints.findById.mockResolvedValue(ownedTouchpoint);
    store.touchpoints.replace.mockResolvedValue(undefined);

    const result = await store.run(() => store.service.closeTouchpoint(
      ownedTouchpoint.id,
      1,
      'talent-touchpoint-close-001',
      { status: 'completed' },
    ));

    expect(store.recruitment.get.mock.invocationCallOrder[0])
      .toBeLessThan(store.touchpoints.findById.mock.invocationCallOrder[0] ?? 0);
    expect(result.touchpoint).not.toHaveProperty('note');
    expect(result.touchpoint).toMatchObject({ status: 'completed', version: 2 });
  });

  it('校友联系没有用途和渠道匹配的有效授权时失败关闭', async () => {
    const store = fixture();
    await expect(store.run(() => store.service.createTouchpoint(
      candidate.candidateId,
      'talent-touchpoint-create-002',
      {
        kind: 'alumni_engagement',
        channel: 'wechat',
        direction: 'outbound',
        outcome: 'contacted',
        occurredAt: '2026-07-27T07:30:00.000Z',
      },
    ))).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.touchpoints.insert).not.toHaveBeenCalled();
  });

  it('校友授权必须同时匹配目的、渠道且尚未到期', async () => {
    const store = fixture([{
      id: '01J8ZQK7V0A2M4N6P8R0T2W4E4',
      personId: 'person-001',
      careCaseId: '01J8ZQK7V0A2M4N6P8R0T2W4E5',
      purpose: 'alumni_events',
      channels: ['wechat'],
      grantedAt: '2026-07-27T00:00:00.000Z',
      expiresAt: '2027-07-27T00:00:00.000Z',
      withdrawnAt: null,
      status: 'active',
    }]);
    await expect(store.run(() => store.service.createTouchpoint(
      candidate.candidateId,
      'talent-touchpoint-create-003',
      {
        kind: 'alumni_engagement',
        channel: 'wechat',
        direction: 'outbound',
        outcome: 'contacted',
        occurredAt: '2026-07-27T07:30:00.000Z',
      },
    ))).resolves.toMatchObject({
      touchpoint: { kind: 'alumni_engagement', channel: 'wechat' },
    });
  });

  it('读写能力在应用服务内二次校验 Scope', async () => {
    const store = fixture();
    await expect(store.runAs(
      () => store.service.get(candidate.candidateId),
      [],
    )).rejects.toMatchObject({ response: { code: 'TALENT_LIFECYCLE_SCOPE_DENIED' } });
    await expect(store.runAs(
      () => store.service.createTouchpoint(
        candidate.candidateId,
        'touchpoint-write-scope-denied',
        {
          kind: 'candidate_outreach',
          channel: 'phone',
          direction: 'outbound',
          outcome: 'contacted',
          occurredAt: '2026-07-27T07:30:00.000Z',
        },
      ),
      ['erp:talent-lifecycle:read'],
    )).rejects.toMatchObject({ response: { code: 'TALENT_TOUCHPOINT_SCOPE_DENIED' } });
    expect(store.idempotency.execute).not.toHaveBeenCalled();
  });

  it('列表支持规范化搜索、阶段过滤和稳定限额，MCP 只返回最小投影', async () => {
    const store = fixture();
    const byName = await store.run(() => store.service.list({
      search: ' 候选人甲 ',
      limit: 1,
    }));
    expect(byName.items).toHaveLength(1);
    expect(byName.items[0]).not.toHaveProperty('displayNameCiphertext');

    const byPosition = await store.run(() => store.service.list({
      search: '后端',
      stage: 'recruiting',
      limit: 1,
    }));
    expect(byPosition.items).toMatchObject([{ stage: 'recruiting' }]);

    const filtered = await store.run(() => store.service.list({
      search: '不存在',
      limit: 10,
    }));
    expect(filtered.items).toEqual([]);

    const mcp = await store.run(() => store.service.getForMcp(candidate.candidateId));
    expect(mcp).toMatchObject({
      candidateId: candidate.candidateId,
      stage: 'recruiting',
    });
    expect(mcp).not.toHaveProperty('displayName');
    expect(mcp).not.toHaveProperty('applications');
    expect(mcp).not.toHaveProperty('touchpoints');
  });

  it('全局读取可查看全部触点并计算最近跟进时间', async () => {
    const other = {
      ...ownedTouchpoint,
      id: '01J8ZQK7V0A2M4N6P8R0T2W4T2',
      ownerActorId: 'employee-002',
      nextActionAt: '2026-07-29T07:30:00.000Z',
    };
    const closed = {
      ...ownedTouchpoint,
      id: '01J8ZQK7V0A2M4N6P8R0T2W4T3',
      status: 'completed',
      nextActionAt: null,
    };
    const store = fixture([], [other, closed, ownedTouchpoint]);
    const result = await store.runAs(
      () => store.service.get(candidate.candidateId),
      ['erp:talent-lifecycle:read', 'erp:talent-lifecycle:read_all'],
    );
    expect(result.touchpoints).toHaveLength(3);
    expect(result.openFollowUpCount).toBe(2);
    expect(result.nextActionAt).toBe(ownedTouchpoint.nextActionAt);
  });

  it('阶段推导优先级覆盖离职、任职、入职和 Offer', async () => {
    const offboarding = fixture();
    offboarding.care.getByEmploymentIds.mockResolvedValueOnce({
      cases: [{
        id: 'care-active',
        status: 'clearance',
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
      }],
      alumniConsents: [],
    });
    await expect(offboarding.run(() => offboarding.service.get(candidate.candidateId)))
      .resolves.toMatchObject({ stage: 'offboarding', activeCareStatus: 'clearance' });

    const employed = fixture();
    employed.organization.getByCandidateId.mockResolvedValueOnce({
      personId: 'person-001',
      employments: [{
        id: 'employment-active',
        employeeNo: 'E001',
        employeeStatus: 'active',
        effectiveTo: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      }],
    });
    await expect(employed.run(() => employed.service.get(candidate.candidateId)))
      .resolves.toMatchObject({ stage: 'employed', employeeStatus: 'active' });

    const onboarding = fixture();
    onboarding.onboarding.getByCandidateId.mockResolvedValueOnce([{
      id: 'onboarding-001',
      status: 'in_progress',
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    }]);
    await expect(onboarding.run(() => onboarding.service.get(candidate.candidateId)))
      .resolves.toMatchObject({ stage: 'onboarding' });

    const offer = fixture();
    offer.recruitment.get.mockResolvedValueOnce({
      ...candidate,
      applications: [{ ...candidate.applications[0], stage: 'offer_sent' }],
    });
    await expect(offer.run(() => offer.service.get(candidate.candidateId)))
      .resolves.toMatchObject({ stage: 'offer', currentApplicationStage: 'offer_sent' });
  });

  it('阶段推导覆盖校友、前员工、失活与人才池', async () => {
    const alumni = fixture([{
      id: 'consent-active',
      personId: 'person-001',
      careCaseId: 'care-completed',
      purpose: 'alumni_network',
      channels: ['email'],
      grantedAt: '2026-07-26T00:00:00.000Z',
      expiresAt: '2027-07-27T00:00:00.000Z',
      withdrawnAt: null,
      status: 'active',
    }]);
    alumni.recruitment.get.mockResolvedValueOnce({ ...candidate, applications: [] });
    await expect(alumni.run(() => alumni.service.get(candidate.candidateId)))
      .resolves.toMatchObject({ stage: 'alumni', alumniConsentStatus: 'active' });

    const former = fixture();
    former.recruitment.get.mockResolvedValueOnce({ ...candidate, applications: [] });
    former.care.getByEmploymentIds.mockResolvedValueOnce({
      cases: [{
        id: 'care-completed',
        status: 'completed',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      }],
      alumniConsents: [],
    });
    await expect(former.run(() => former.service.get(candidate.candidateId)))
      .resolves.toMatchObject({ stage: 'former_employee' });

    const inactive = fixture();
    inactive.recruitment.get.mockResolvedValueOnce({
      ...candidate,
      candidateStatus: 'withdrawn',
      applications: [],
    });
    await expect(inactive.run(() => inactive.service.get(candidate.candidateId)))
      .resolves.toMatchObject({ stage: 'inactive' });

    const pool = fixture();
    pool.recruitment.get.mockResolvedValueOnce({ ...candidate, applications: [] });
    await expect(pool.run(() => pool.service.get(candidate.candidateId)))
      .resolves.toMatchObject({
        stage: 'talent_pool',
        currentApplicationStage: null,
        currentPositionTitle: null,
      });
  });

  it('完整历史组装覆盖阶段、入职、任职、离职、校友和服务触点', async () => {
    const withdrawnConsent = {
      id: 'consent-withdrawn',
      personId: 'person-001',
      careCaseId: 'care-completed',
      purpose: 'alumni_network',
      channels: ['email'],
      grantedAt: '2026-07-24T00:00:00.000Z',
      expiresAt: '2027-07-27T00:00:00.000Z',
      withdrawnAt: '2026-07-26T00:00:00.000Z',
      status: 'withdrawn',
    };
    const store = fixture([withdrawnConsent], [ownedTouchpoint]);
    store.recruitment.get.mockResolvedValueOnce({
      ...candidate,
      applications: [{
        ...candidate.applications[0],
        stage: 'hired',
        stageHistory: [{
          from: 'interview',
          to: 'hired',
          occurredAt: '2026-07-23T00:00:00.000Z',
        }],
      }],
    });
    store.onboarding.getByCandidateId.mockResolvedValueOnce([{
      id: 'onboarding-completed',
      status: 'completed',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    }]);
    store.organization.getByCandidateId.mockResolvedValueOnce({
      personId: 'person-001',
      employments: [{
        id: 'employment-ended',
        employeeNo: 'E001',
        employeeStatus: 'terminated',
        effectiveTo: '2026-07-25T00:00:00.000Z',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      }],
    });
    store.care.getByEmploymentIds.mockResolvedValueOnce({
      cases: [{
        id: 'care-completed',
        status: 'completed',
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
      }],
      alumniConsents: [withdrawnConsent],
    });
    const detail = await store.run(() => store.service.get(candidate.candidateId));
    expect(detail.stage).toBe('former_employee');
    expect(detail.personId).toBe('person-001');
    expect(detail.timeline.map((entry) => entry.eventType)).toEqual(expect.arrayContaining([
      'application.applied',
      'application.stage_changed',
      'onboarding.created',
      'onboarding.status',
      'employment.established',
      'employment.terminated',
      'care.case.created',
      'care.case.status',
      'alumni.consent.granted',
      'alumni.consent.withdrawn',
      'touchpoint.open',
    ]));
  });

  it('候选人联系要求有效状态、联系授权和保留期', async () => {
    for (const value of [
      { ...candidate, candidateStatus: 'withdrawn' },
      { ...candidate, contactConsentExpiresAt: '2026-07-27T07:59:59.999Z' },
      { ...candidate, retentionExpiresAt: '2026-07-27T07:59:59.999Z' },
    ]) {
      const denied = fixture();
      denied.recruitment.get.mockResolvedValueOnce(value);
      await expect(denied.run(() => denied.service.createTouchpoint(
        candidate.candidateId,
        `candidate-contact-denied-${value.candidateStatus}`,
        {
          kind: 'candidate_outreach',
          channel: 'email',
          direction: 'outbound',
          outcome: 'contacted',
          occurredAt: '2026-07-27T07:30:00.000Z',
        },
      ))).rejects.toMatchObject({
        response: { code: 'TALENT_CANDIDATE_CONTACT_CONSENT_REQUIRED' },
      });
      expect(denied.touchpoints.insert).not.toHaveBeenCalled();
    }
  });

  it('内部退订不受联系授权阻断，复聘联系必须匹配专用授权', async () => {
    const withdrawn = fixture();
    withdrawn.recruitment.get.mockResolvedValueOnce({
      ...candidate,
      candidateStatus: 'withdrawn',
      contactConsentExpiresAt: '2020-01-01T00:00:00.000Z',
      retentionExpiresAt: '2020-01-01T00:00:00.000Z',
    });
    await expect(withdrawn.run(() => withdrawn.service.createTouchpoint(
      candidate.candidateId,
      'internal-consent-withdrawn',
      {
        kind: 'candidate_outreach',
        channel: 'internal',
        direction: 'inbound',
        outcome: 'consent_withdrawn',
        occurredAt: '2026-07-27T07:30:00.000Z',
      },
    ))).resolves.toMatchObject({ touchpoint: { outcome: 'consent_withdrawn' } });

    const rehire = fixture([{
      id: 'rehire-consent',
      personId: 'person-001',
      careCaseId: 'care-completed',
      purpose: 'rehire_contact',
      channels: ['email'],
      grantedAt: '2026-07-26T00:00:00.000Z',
      expiresAt: '2027-07-27T00:00:00.000Z',
      withdrawnAt: null,
      status: 'active',
    }]);
    await expect(rehire.run(() => rehire.service.createTouchpoint(
      candidate.candidateId,
      'rehire-contact-allowed',
      {
        kind: 'rehire_contact',
        channel: 'email',
        direction: 'outbound',
        outcome: 'contacted',
        occurredAt: '2026-07-27T07:30:00.000Z',
      },
    ))).resolves.toMatchObject({ touchpoint: { kind: 'rehire_contact' } });
  });

  it('触点时间非法时返回稳定输入错误且不落库', async () => {
    const store = fixture();
    await expect(store.run(() => store.service.createTouchpoint(
      candidate.candidateId,
      'touchpoint-invalid-date',
      {
        kind: 'candidate_outreach',
        channel: 'phone',
        direction: 'outbound',
        outcome: 'contacted',
        occurredAt: 'invalid-date',
      },
    ))).rejects.toMatchObject({ response: { code: 'TALENT_TOUCHPOINT_INPUT_INVALID' } });
    expect(store.touchpoints.insert).not.toHaveBeenCalled();
  });

  it('关闭触点对缺失路由、负责人越权和全局写权限失败关闭', async () => {
    const missing = fixture();
    missing.touchpoints.findAuthorizationRoute.mockResolvedValueOnce(null);
    await expect(missing.run(() => missing.service.closeTouchpoint(
      ownedTouchpoint.id,
      1,
      'close-route-missing',
      { status: 'completed' },
    ))).rejects.toMatchObject({ response: { code: 'TALENT_TOUCHPOINT_NOT_FOUND' } });

    const denied = fixture();
    denied.touchpoints.findAuthorizationRoute.mockResolvedValueOnce({
      candidateId: candidate.candidateId,
      ownerActorId: 'employee-002',
    });
    await expect(denied.run(() => denied.service.closeTouchpoint(
      ownedTouchpoint.id,
      1,
      'close-owner-denied',
      { status: 'completed' },
    ))).rejects.toMatchObject({ response: { code: 'TALENT_TOUCHPOINT_OWNER_DENIED' } });
    expect(denied.touchpoints.findById).not.toHaveBeenCalled();

    const allowed = fixture();
    allowed.touchpoints.findAuthorizationRoute.mockResolvedValueOnce({
      candidateId: candidate.candidateId,
      ownerActorId: 'employee-002',
    });
    allowed.touchpoints.findById.mockResolvedValueOnce(ownedTouchpoint);
    allowed.touchpoints.replace.mockResolvedValueOnce(undefined);
    await expect(allowed.runAs(
      () => allowed.service.closeTouchpoint(
        ownedTouchpoint.id,
        1,
        'close-write-all',
        { status: 'cancelled' },
      ),
      [
        'erp:talent-lifecycle:touchpoint:write',
        'erp:talent-lifecycle:touchpoint:write_all',
      ],
      'employee-003',
    )).resolves.toMatchObject({ touchpoint: { status: 'cancelled' } });
  });

  it('关闭触点在事务内重读并统一映射并发和领域错误', async () => {
    const missingFresh = fixture();
    missingFresh.touchpoints.findAuthorizationRoute.mockResolvedValueOnce({
      candidateId: candidate.candidateId,
      ownerActorId: 'employee-001',
    });
    missingFresh.touchpoints.findById.mockResolvedValueOnce(null);
    await expect(missingFresh.run(() => missingFresh.service.closeTouchpoint(
      ownedTouchpoint.id,
      1,
      'close-fresh-missing',
      { status: 'completed' },
    ))).rejects.toMatchObject({ response: { code: 'TALENT_TOUCHPOINT_NOT_FOUND' } });

    const version = fixture();
    version.touchpoints.findAuthorizationRoute.mockResolvedValueOnce({
      candidateId: candidate.candidateId,
      ownerActorId: 'employee-001',
    });
    version.touchpoints.findById.mockResolvedValueOnce(ownedTouchpoint);
    await expect(version.run(() => version.service.closeTouchpoint(
      ownedTouchpoint.id,
      2,
      'close-version-conflict',
      { status: 'completed' },
    ))).rejects.toMatchObject({
      response: { code: 'TALENT_TOUCHPOINT_VERSION_CONFLICT' },
    });

    const repositoryConflict = fixture();
    repositoryConflict.touchpoints.findAuthorizationRoute.mockResolvedValueOnce({
      candidateId: candidate.candidateId,
      ownerActorId: 'employee-001',
    });
    repositoryConflict.touchpoints.findById.mockResolvedValueOnce(ownedTouchpoint);
    repositoryConflict.touchpoints.replace.mockRejectedValueOnce(
      new TalentTouchpointWriteConflictError(),
    );
    await expect(repositoryConflict.run(() => repositoryConflict.service.closeTouchpoint(
      ownedTouchpoint.id,
      1,
      'close-repository-conflict',
      { status: 'completed' },
    ))).rejects.toMatchObject({
      response: { code: 'TALENT_TOUCHPOINT_VERSION_CONFLICT' },
    });
  });

  it('创建触点对仓储并发与领域内容错误使用稳定契约', async () => {
    const conflict = fixture();
    conflict.touchpoints.insert.mockRejectedValueOnce(new TalentTouchpointWriteConflictError());
    await expect(conflict.run(() => conflict.service.createTouchpoint(
      candidate.candidateId,
      'create-repository-conflict',
      {
        kind: 'candidate_outreach',
        channel: 'phone',
        direction: 'outbound',
        outcome: 'contacted',
        occurredAt: '2026-07-27T07:30:00.000Z',
      },
    ))).rejects.toMatchObject({
      response: { code: 'TALENT_TOUCHPOINT_VERSION_CONFLICT' },
    });

    const invalidNote = fixture();
    await expect(invalidNote.run(() => invalidNote.service.createTouchpoint(
      candidate.candidateId,
      'create-invalid-note',
      {
        kind: 'candidate_outreach',
        channel: 'phone',
        direction: 'outbound',
        outcome: 'contacted',
        occurredAt: '2026-07-27T07:30:00.000Z',
        note: '',
      },
    ))).rejects.toBeInstanceOf(BadRequestException);
  });
});
