import { describe, expect, it } from 'vitest';

import {
  closeTalentTouchpoint,
  createTalentTouchpoint,
} from './talent-lifecycle.js';

const now = new Date('2026-07-27T08:00:00.000Z');

function create(nextActionAt: string | null = '2026-07-28T08:00:00.000Z') {
  return createTalentTouchpoint({
    id: '01J8ZQK7V0A2M4N6P8R0T2W4E2',
    tenantId: 'tenant-001',
    candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    kind: 'candidate_outreach',
    channel: 'phone',
    direction: 'outbound',
    outcome: 'follow_up_required',
    ownerActorId: 'employee-001',
    occurredAt: '2026-07-27T07:00:00.000Z',
    nextActionAt,
    note: '  候选人希望次日下午再次沟通  ',
  }, now);
}

describe('人才服务触点领域规则', () => {
  it('存在下一行动时保持开放，并规范化加密前备注', () => {
    const touchpoint = create();
    expect(touchpoint.status).toBe('open');
    expect(touchpoint.note).toBe('候选人希望次日下午再次沟通');
    expect(Object.isFrozen(touchpoint)).toBe(true);
  });

  it('没有下一行动时直接形成已完成服务记录', () => {
    expect(create(null).status).toBe('completed');
  });

  it('关闭动作强制租户、版本和开放状态', () => {
    const closed = closeTalentTouchpoint(create(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      status: 'completed',
    }, new Date('2026-07-27T09:00:00.000Z'));
    expect(closed).toMatchObject({ status: 'completed', version: 2 });
    expect(() => closeTalentTouchpoint(closed, {
      tenantId: 'tenant-001',
      expectedVersion: 2,
      status: 'cancelled',
    }, now)).toThrow('TALENT_TOUCHPOINT_ALREADY_CLOSED');
  });

  it('拒绝倒序下一行动、超窗发生时间和超长备注', () => {
    expect(() => createTalentTouchpoint({
      ...create(),
      id: '01J8ZQK7V0A2M4N6P8R0T2W4E3',
      nextActionAt: '2026-07-27T06:00:00.000Z',
    }, now)).toThrow('TALENT_TOUCHPOINT_NEXT_ACTION_INVALID');
    expect(() => createTalentTouchpoint({
      ...create(),
      id: '01J8ZQK7V0A2M4N6P8R0T2W4E4',
      occurredAt: '2024-01-01T00:00:00.000Z',
    }, now)).toThrow('TALENT_TOUCHPOINT_OCCURRED_AT_INVALID');
    expect(() => createTalentTouchpoint({
      ...create(),
      id: '01J8ZQK7V0A2M4N6P8R0T2W4E5',
      note: '字'.repeat(1_001),
    }, now)).toThrow('TALENT_TOUCHPOINT_NOTE_INVALID');
  });
});
