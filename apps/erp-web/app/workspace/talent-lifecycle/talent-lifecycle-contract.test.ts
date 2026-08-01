import { describe, expect, it } from 'vitest';

import {
  buildTouchpointCreateInput,
  canCloseTalentTouchpoint,
  canRetryTalentTouchpoint,
  canWriteTalentTouchpoint,
  parseTalentLifecycleDetail,
  parseTalentLifecycleList,
  parseTouchpointMutationResult,
} from '../../lib/talent-lifecycle-contract';

const CANDIDATE_ID = '01J8ZQK7V0A2M4N6P8R0T2W4E1';
const TOUCHPOINT_ID = '01J8ZQK7V0A2M4N6P8R0T2W4T1';
const OCCURRED_AT = '2026-07-29T01:00:00.000Z';
const NEXT_ACTION_AT = '2026-07-30T01:00:00.000Z';

const summary = Object.freeze({
  candidateId: CANDIDATE_ID,
  displayName: '候选人甲',
  stage: 'recruiting',
  candidateStatus: 'active',
  currentApplicationStage: 'interview',
  currentPositionTitle: '平台工程师',
  employeeStatus: null,
  activeCareStatus: null,
  alumniConsentStatus: null,
  openFollowUpCount: 1,
  nextActionAt: NEXT_ACTION_AT,
  updatedAt: OCCURRED_AT,
});

const touchpoint = Object.freeze({
  id: TOUCHPOINT_ID,
  candidateId: CANDIDATE_ID,
  kind: 'candidate_outreach',
  channel: 'phone',
  direction: 'outbound',
  outcome: 'follow_up_required',
  ownerActorId: 'actor-001',
  occurredAt: OCCURRED_AT,
  nextActionAt: NEXT_ACTION_AT,
  status: 'open',
  note: '等待候选人反馈',
  version: 1,
});

const detail = Object.freeze({
  ...summary,
  personId: null,
  applications: Object.freeze([]),
  onboarding: Object.freeze([]),
  employments: Object.freeze([]),
  care: Object.freeze({
    cases: Object.freeze([]),
    alumniConsents: Object.freeze([]),
  }),
  touchpoints: Object.freeze([touchpoint]),
  timeline: Object.freeze([Object.freeze({
    id: `service:${TOUCHPOINT_ID}`,
    domain: 'service',
    eventType: 'touchpoint.open',
    title: '服务跟进',
    occurredAt: OCCURRED_AT,
    referenceType: 'touchpoint',
    referenceId: TOUCHPOINT_ID,
  })]),
});

describe('人才全周期浏览器契约', () => {
  it('接受并深冻结严格列表与详情公开投影', () => {
    const items = parseTalentLifecycleList({ items: [summary] });
    const parsed = parseTalentLifecycleDetail(detail);

    expect(items).toEqual([summary]);
    expect(parsed.touchpoints).toEqual([touchpoint]);
    expect(Object.isFrozen(items)).toBe(true);
    expect(Object.isFrozen(items[0])).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.touchpoints)).toBe(true);
    expect(Object.isFrozen(parsed.timeline[0])).toBe(true);
  });

  it.each([
    { ...summary, tenantId: 'tenant-001' },
    { ...summary, createdAt: OCCURRED_AT },
    { ...summary, stage: 'unknown' },
    { ...summary, updatedAt: '2026-07-29' },
  ])('列表拒绝内部字段、未知枚举和非规范时间', (invalid) => {
    expect(() => parseTalentLifecycleList({ items: [invalid] }))
      .toThrow('TALENT_LIFECYCLE_SUMMARY_INVALID');
  });

  it('列表拒绝重复候选人和未知顶层字段', () => {
    expect(() => parseTalentLifecycleList({ items: [summary, summary] }))
      .toThrow('TALENT_LIFECYCLE_LIST_INVALID');
    expect(() => parseTalentLifecycleList({ items: [summary], tenantId: 'tenant-001' }))
      .toThrow('TALENT_LIFECYCLE_LIST_INVALID');
  });

  it('详情拒绝跨候选人触点、重复时间线和内部授权期限', () => {
    expect(() => parseTalentLifecycleDetail({
      ...detail,
      touchpoints: [{ ...touchpoint, candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E2' }],
    })).toThrow('TALENT_LIFECYCLE_DETAIL_INVALID');
    expect(() => parseTalentLifecycleDetail({
      ...detail,
      timeline: [detail.timeline[0], detail.timeline[0]],
    })).toThrow('TALENT_LIFECYCLE_DETAIL_INVALID');
    expect(() => parseTalentLifecycleDetail({
      ...detail,
      candidateContactConsentExpiresAt: NEXT_ACTION_AT,
    })).toThrow('TALENT_LIFECYCLE_DETAIL_INVALID');
  });

  it('详情拒绝触点租户、持久化时间戳和未知字段', () => {
    for (const extra of [
      { tenantId: 'tenant-001' },
      { createdAt: OCCURRED_AT },
      { internalEvidenceId: 'evidence-001' },
    ]) {
      expect(() => parseTalentLifecycleDetail({
        ...detail,
        touchpoints: [{ ...touchpoint, ...extra }],
      })).toThrow('TALENT_TOUCHPOINT_INVALID');
    }
  });

  it('触点写响应只接受无备注、无租户的最小投影', () => {
    const mutation = {
      id: touchpoint.id,
      candidateId: touchpoint.candidateId,
      kind: touchpoint.kind,
      channel: touchpoint.channel,
      direction: touchpoint.direction,
      outcome: touchpoint.outcome,
      ownerActorId: touchpoint.ownerActorId,
      occurredAt: touchpoint.occurredAt,
      nextActionAt: touchpoint.nextActionAt,
      status: touchpoint.status,
      version: touchpoint.version,
    };
    expect(parseTouchpointMutationResult({ touchpoint: mutation })).toEqual({
      touchpoint: mutation,
    });
    expect(() => parseTouchpointMutationResult({ touchpoint }))
      .toThrow('TALENT_TOUCHPOINT_INVALID');
    expect(() => parseTouchpointMutationResult({
      touchpoint: { ...mutation, tenantId: 'tenant-001' },
    })).toThrow('TALENT_TOUCHPOINT_INVALID');
  });

  it('创建构造器只输出白名单并规范时间与备注', () => {
    const input = buildTouchpointCreateInput({
      kind: 'candidate_outreach',
      channel: 'phone',
      direction: 'outbound',
      outcome: 'follow_up_required',
      occurredAt: '2026-07-29T09:00:00+08:00',
      nextActionAt: '2026-07-30T09:00:00+08:00',
      note: '  等待候选人反馈  ',
    });

    expect(input).toEqual({
      kind: 'candidate_outreach',
      channel: 'phone',
      direction: 'outbound',
      outcome: 'follow_up_required',
      occurredAt: OCCURRED_AT,
      nextActionAt: NEXT_ACTION_AT,
      note: '等待候选人反馈',
    });
    expect(Object.isFrozen(input)).toBe(true);
  });

  it('创建构造器拒绝未知字段、倒序行动时间和非法枚举', () => {
    const valid = {
      kind: 'candidate_outreach',
      channel: 'phone',
      direction: 'outbound',
      outcome: 'follow_up_required',
      occurredAt: OCCURRED_AT,
    };
    expect(() => buildTouchpointCreateInput({ ...valid, tenantId: 'tenant-001' }))
      .toThrow('TALENT_TOUCHPOINT_INPUT_INVALID');
    expect(() => buildTouchpointCreateInput({ ...valid, nextActionAt: OCCURRED_AT }))
      .toThrow('TALENT_TOUCHPOINT_INPUT_INVALID');
    expect(() => buildTouchpointCreateInput({ ...valid, channel: 'sms' }))
      .toThrow('TALENT_TOUCHPOINT_INPUT_INVALID');
  });

  it('写入口要求读取与写入 Scope 的精确组合', () => {
    expect(canWriteTalentTouchpoint([
      'erp:talent-lifecycle:read',
      'erp:talent-lifecycle:touchpoint:write',
    ])).toBe(true);
    expect(canWriteTalentTouchpoint(['erp:talent-lifecycle:touchpoint:write'])).toBe(false);
    expect(canWriteTalentTouchpoint(['erp:talent-lifecycle:touchpoint:write_all'])).toBe(false);
  });

  it('关闭与重试绑定同一主体、责任人及跨责任人 Scope', () => {
    const owner = {
      actorId: 'actor-001',
      scopes: ['erp:talent-lifecycle:read', 'erp:talent-lifecycle:touchpoint:write'],
    };
    const supervisor = {
      actorId: 'actor-002',
      scopes: [
        'erp:talent-lifecycle:read',
        'erp:talent-lifecycle:touchpoint:write',
        'erp:talent-lifecycle:touchpoint:write_all',
      ],
    };
    expect(canCloseTalentTouchpoint(owner, touchpoint)).toBe(true);
    expect(canCloseTalentTouchpoint({ ...owner, actorId: 'actor-002' }, touchpoint)).toBe(false);
    expect(canCloseTalentTouchpoint(supervisor, touchpoint)).toBe(true);
    expect(canRetryTalentTouchpoint(owner, 'actor-001')).toBe(true);
    expect(canRetryTalentTouchpoint(owner, 'actor-002')).toBe(false);
    expect(canRetryTalentTouchpoint(supervisor, 'actor-002', 'actor-001')).toBe(true);
  });
});
