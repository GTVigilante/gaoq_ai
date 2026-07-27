import { ForbiddenException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { CareTalentSourceService } from '../../care/application/care-talent-source.service.js';
import type { OnboardingTalentSourceService } from '../../onboarding/application/onboarding-talent-source.service.js';
import type { OrgTalentSourceService } from '../../org/application/org-talent-source.service.js';
import type { RecruitmentTalentSourceService } from '../../recruitment/application/recruitment-talent-source.service.js';
import type { TalentLifecycleOutboxWriter } from '../persistence/talent-lifecycle-outbox.writer.js';
import type { TalentTouchpointRepository } from '../persistence/talent-lifecycle.repository.js';
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
  return { service, run, recruitment, touchpoints, outbox };
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
});
