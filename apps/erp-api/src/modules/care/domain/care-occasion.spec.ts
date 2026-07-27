import { describe, expect, it } from 'vitest';

import {
  completeCareOccasionTask,
  createCareOccasionPreference,
  markCareOccasionDispatching,
  planCareOccasionTasks,
  releaseCareOccasionTask,
  updateCareOccasionPreference,
  validateCareOccasionPolicy,
  type CareOccasionPolicy,
} from './care-occasion.js';

const POLICY: CareOccasionPolicy = {
  version: 'care-occasion-v1',
  timeZone: 'Asia/Shanghai',
  dispatchLocalTime: '09:00',
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  leapDayPolicy: 'feb28',
  rehireAnniversaryBasis: 'current_employment',
  birthdayTemplateCode: 'CARE_BIRTHDAY_V1',
  anniversaryTemplateCode: 'CARE_ANNIVERSARY_V1',
  maxAttempts: 6,
};

function preference() {
  return createCareOccasionPreference({
    id: 'preference-001',
    tenantId: 'tenant-001',
    personId: 'person-001',
    employeeId: 'employee-001',
    currentEmploymentId: 'employment-current',
    birthdayEnabled: true,
    anniversaryEnabled: true,
    preferredChannels: ['feishu', 'email'],
    unsubscribed: false,
  }, new Date('2026-07-26T00:00:00.000Z'));
}

describe('Care 生日与周年关怀领域', () => {
  it('按租户时区规划生日与当前复聘段周年，任务不含完整生日', () => {
    let sequence = 0;
    const tasks = planCareOccasionTasks({
      tenantId: 'tenant-001',
      preference: preference(),
      source: {
        personId: 'person-001',
        employeeId: 'employee-001',
        currentEmploymentId: 'employment-current',
        birthdayMonthDay: '07-27',
        currentEmploymentEffectiveFrom: '2025-08-01',
        employmentEffectiveFromDates: ['2018-03-01', '2025-08-01'],
      },
      policy: POLICY,
      now: new Date('2026-07-27T00:00:00.000Z'),
      createId: () => `task-${sequence += 1}`,
    });
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      occasionType: 'birthday',
      scheduledAt: '2026-07-27T01:00:00.000Z',
      occurrenceYear: 2026,
      status: 'pending',
    });
    expect(tasks[1]).toMatchObject({
      occasionType: 'employment_anniversary',
      scheduledAt: '2026-08-01T01:00:00.000Z',
    });
    expect(JSON.stringify(tasks)).not.toMatch(
      /birthdayMonthDay|employmentEffectiveFromDates|identityEvidence/iu,
    );
  });

  it('闰日策略与最初劳动关系周年均按版本化策略确定', () => {
    const tasks = planCareOccasionTasks({
      tenantId: 'tenant-001',
      preference: preference(),
      source: {
        personId: 'person-001',
        employeeId: 'employee-001',
        currentEmploymentId: 'employment-current',
        birthdayMonthDay: '02-29',
        currentEmploymentEffectiveFrom: '2025-08-01',
        employmentEffectiveFromDates: ['2018-03-01', '2025-08-01'],
      },
      policy: {
        ...POLICY,
        rehireAnniversaryBasis: 'original_employment',
      },
      now: new Date('2027-02-20T00:00:00.000Z'),
      createId: (date) => `task-${date.getTime()}`,
    });
    expect(tasks[0]?.scheduledAt).toBe('2027-02-28T01:00:00.000Z');
    expect(tasks[1]?.scheduledAt).toBe('2027-03-01T01:00:00.000Z');
  });

  it('全局退订清空偏好且不再规划任何任务', () => {
    const unsubscribed = updateCareOccasionPreference(preference(), {
      tenantId: 'tenant-001',
      expectedVersion: 1,
      currentEmploymentId: 'employment-current',
      birthdayEnabled: true,
      anniversaryEnabled: true,
      preferredChannels: ['email'],
      unsubscribeAll: true,
    }, new Date('2026-07-27T00:00:00.000Z'));
    expect(unsubscribed).toMatchObject({
      birthdayEnabled: false,
      anniversaryEnabled: false,
      preferredChannels: [],
      unsubscribed: true,
      version: 2,
    });
    expect(planCareOccasionTasks({
      tenantId: 'tenant-001',
      preference: unsubscribed,
      source: {
        personId: 'person-001',
        employeeId: 'employee-001',
        currentEmploymentId: 'employment-current',
        birthdayMonthDay: '07-27',
        currentEmploymentEffectiveFrom: '2025-08-01',
        employmentEffectiveFromDates: ['2025-08-01'],
      },
      policy: POLICY,
      now: new Date('2026-07-27T00:00:00.000Z'),
      createId: () => 'task-001',
    })).toEqual([]);
  });

  it('静默时段冲突失败关闭，Worker 重试达到上限进入 dead', () => {
    expect(() => validateCareOccasionPolicy({
      ...POLICY,
      dispatchLocalTime: '22:00',
    })).toThrow('关怀发送时间不能落在静默时段');
    const [planned] = planCareOccasionTasks({
      tenantId: 'tenant-001',
      preference: preference(),
      source: {
        personId: 'person-001',
        employeeId: 'employee-001',
        currentEmploymentId: 'employment-current',
        birthdayMonthDay: '07-27',
        currentEmploymentEffectiveFrom: '2025-08-01',
        employmentEffectiveFromDates: ['2025-08-01'],
      },
      policy: { ...POLICY, maxAttempts: 1 },
      now: new Date('2026-07-27T00:00:00.000Z'),
      createId: () => 'task-001',
    });
    if (planned === undefined) throw new Error('测试任务缺失');
    const dispatching = markCareOccasionDispatching(
      planned,
      'worker-001',
      new Date(planned.scheduledAt),
    );
    expect(releaseCareOccasionTask(
      dispatching,
      1,
      new Date('2026-07-27T01:00:01.000Z'),
    ).status).toBe('dead');
  });

  it('受信任送达证据或受控拒绝形成互斥终态', () => {
    const [planned] = planCareOccasionTasks({
      tenantId: 'tenant-001',
      preference: preference(),
      source: {
        personId: 'person-001',
        employeeId: 'employee-001',
        currentEmploymentId: 'employment-current',
        birthdayMonthDay: '07-27',
        currentEmploymentEffectiveFrom: '2025-08-01',
        employmentEffectiveFromDates: ['2025-08-01'],
      },
      policy: POLICY,
      now: new Date('2026-07-27T00:00:00.000Z'),
      createId: () => 'task-001',
    });
    if (planned === undefined) throw new Error('测试任务缺失');
    const dispatching = markCareOccasionDispatching(
      planned,
      'worker-001',
      new Date(planned.scheduledAt),
    );
    expect(completeCareOccasionTask(dispatching, {
      outcome: 'delivered',
      deliveryEvidenceId: 'delivery-evidence-001',
      deliveredAt: '2026-07-27T01:00:03.000Z',
    }, new Date('2026-07-27T01:00:03.000Z'))).toMatchObject({
      status: 'delivered',
      deliveryEvidenceId: 'delivery-evidence-001',
    });
    expect(completeCareOccasionTask(dispatching, {
      outcome: 'denied',
      denialCode: 'no_authorized_channel',
    }, new Date('2026-07-27T01:00:03.000Z'))).toMatchObject({
      status: 'cancelled',
      denialCode: 'no_authorized_channel',
    });
  });
});
