import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  careOccasionSourceDigest,
  type CareOccasionPolicy,
  type CareOccasionPreference,
  type CareOccasionSourceFacts,
  type CareOccasionTask,
} from '../domain/index.js';
import { CareOccasionApplicationService } from './care-occasion-application.service.js';

const POLICY: CareOccasionPolicy = {
  version: 'policy-v1',
  timeZone: 'Asia/Shanghai',
  dispatchLocalTime: '09:00',
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  leapDayPolicy: 'feb28',
  rehireAnniversaryBasis: 'current_employment',
  birthdayTemplateCode: 'birthday-v1',
  anniversaryTemplateCode: 'anniversary-v1',
  maxAttempts: 3,
};
const SOURCE: CareOccasionSourceFacts = {
  personId: 'person-001',
  employeeId: 'employee-001',
  currentEmploymentId: 'employment-001',
  birthdayMonthDay: '07-27',
  birthdaySourceRevision: 'revision-001',
  currentEmploymentEffectiveFrom: '2025-07-27',
  employmentEffectiveFromDates: ['2025-07-27'],
};
const PREFERENCE: CareOccasionPreference = {
  id: 'preference-001',
  tenantId: 'tenant-001',
  personId: SOURCE.personId,
  employeeId: SOURCE.employeeId,
  currentEmploymentId: SOURCE.currentEmploymentId,
  birthdayEnabled: true,
  anniversaryEnabled: false,
  preferredChannels: ['feishu'],
  unsubscribed: false,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const SOURCE_DIGEST = careOccasionSourceDigest({
  tenantId: 'tenant-001',
  source: SOURCE,
  preferenceVersion: PREFERENCE.version,
  policyVersion: POLICY.version,
});

function task(status: CareOccasionTask['status']): CareOccasionTask {
  const dispatching = status === 'dispatching';
  return {
    id: 'care-task-001',
    tenantId: 'tenant-001',
    personId: SOURCE.personId,
    employeeId: SOURCE.employeeId,
    employmentId: SOURCE.currentEmploymentId,
    occasionType: 'birthday',
    occurrenceYear: 2026,
    scheduledAt: '2026-07-26T01:00:00.000Z',
    templateCode: POLICY.birthdayTemplateCode,
    policyVersion: POLICY.version,
    preferredChannels: ['feishu'],
    sourceDigest: SOURCE_DIGEST,
    status,
    attempts: dispatching ? 1 : 0,
    nextAttemptAt: '2026-07-26T01:00:00.000Z',
    lockedAt: dispatching ? '2026-07-27T00:00:00.000Z' : null,
    lockedBy: dispatching ? 'worker-001' : null,
    denialCode: null,
    deliveryEvidenceId: null,
    deliveredAt: null,
    version: dispatching ? 2 : 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: dispatching
      ? '2026-07-27T00:00:00.000Z'
      : '2026-01-01T00:00:00.000Z',
  };
}

describe('CareOccasionApplicationService 投递闭环', () => {
  it('重读权威偏好和主数据后仅发送最小控制字段，并事务固化签名终态', async () => {
    const fixture = createFixture();
    fixture.notifications.dispatch.mockResolvedValue({
      outcome: 'delivered',
      deliveryEvidenceId: 'delivery-001',
      deliveredAt: '2026-07-27T00:01:00.000Z',
      channel: 'feishu',
    });
    const result = await runWorker(fixture.context, () =>
      fixture.service.dispatchTask('care-task-001', 'worker-001'),
    );
    expect(result.status).toBe('delivered');
    expect(fixture.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        occasionTaskId: 'care-task-001',
        employeeId: 'employee-001',
        purpose: 'employee_care',
        templateCode: 'birthday-v1',
        policyVersion: 'policy-v1',
        sourceDigest: SOURCE_DIGEST,
      }),
    );
    const payload = JSON.stringify(fixture.notifications.dispatch.mock.calls[0]?.[0]);
    expect(payload).not.toContain('07-27');
    expect(payload).not.toContain('contact');
    expect(payload).not.toContain('body');
    expect(fixture.tasks.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'delivered', deliveryEvidenceId: 'delivery-001' }),
      2,
      fixture.session,
    );
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.occasion.delivered' }),
      fixture.session,
    );
  });

  it('偏好版本或渠道变化后默认拒绝，不调用通知网关', async () => {
    const fixture = createFixture({
      preference: { ...PREFERENCE, version: 2, preferredChannels: ['email'] },
    });
    const result = await runWorker(fixture.context, () =>
      fixture.service.dispatchTask('care-task-001', 'worker-001'),
    );
    expect(result).toMatchObject({
      status: 'cancelled',
      denialCode: 'purpose_restricted',
    });
    expect(fixture.notifications.dispatch).not.toHaveBeenCalled();
  });

  it('通道超时释放锁并按策略退避，不把业务成功终态回写为失败', async () => {
    const fixture = createFixture();
    fixture.notifications.dispatch.mockRejectedValue(
      new Error('CARE_OCCASION_GATEWAY_FAILED'),
    );
    await expect(runWorker(fixture.context, () =>
      fixture.service.dispatchTask('care-task-001', 'worker-001'),
    )).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fixture.tasks.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        attempts: 1,
        lockedAt: null,
        lockedBy: null,
      }),
      2,
      fixture.session,
    );
    expect(fixture.metrics.recordCareOccasion).toHaveBeenCalledWith(
      'dispatch',
      'retry',
      expect.any(Number),
    );
  });

  it('重复终态队列消息直接收敛，不再次发送', async () => {
    const delivered = {
      ...task('pending'),
      status: 'delivered' as const,
      deliveryEvidenceId: 'delivery-001',
      deliveredAt: '2026-07-27T00:01:00.000Z',
      version: 3,
    };
    const fixture = createFixture({ currentTask: delivered });
    await expect(runWorker(fixture.context, () =>
      fixture.service.dispatchTask('care-task-001', 'worker-001'),
    )).resolves.toBe(delivered);
    expect(fixture.tasks.claimById).not.toHaveBeenCalled();
    expect(fixture.notifications.dispatch).not.toHaveBeenCalled();
  });
});

function createFixture(input: {
  readonly preference?: CareOccasionPreference;
  readonly currentTask?: CareOccasionTask;
} = {}) {
  const context = new TenantContextService();
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const tasks = {
    findById: vi.fn().mockResolvedValue(input.currentTask ?? task('pending')),
    claimById: vi.fn().mockResolvedValue(task('dispatching')),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const preferences = {
    findByEmployeeId: vi.fn().mockResolvedValue(input.preference ?? PREFERENCE),
  };
  const notifications = { dispatch: vi.fn() };
  const outbox = { append: vi.fn().mockResolvedValue(undefined) };
  const metrics = {
    recordCareOccasion: vi.fn(),
    setCareOccasionBacklog: vi.fn(),
  };
  const service = new CareOccasionApplicationService(
    { startSession: vi.fn().mockResolvedValue(session) } as never,
    {} as never,
    context,
    {} as never,
    { getEligibleByEmployeeId: vi.fn().mockResolvedValue(SOURCE) } as never,
    { get: vi.fn().mockReturnValue(POLICY) } as never,
    preferences as never,
    tasks as never,
    {} as never,
    outbox as never,
    {} as never,
    notifications,
    metrics as never,
  );
  return {
    service,
    context,
    session,
    tasks,
    preferences,
    notifications,
    outbox,
    metrics,
  };
}

async function runWorker<T>(
  context: TenantContextService,
  operation: () => Promise<T>,
): Promise<T> {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: {
      actorId: 'system:care-worker',
      actorType: 'system_job',
      tenantId: 'tenant-001',
      roleCodes: ['CARE_OCCASION_WORKER'],
      scopes: [
        'erp:care:occasion:dispatch',
        'erp:care:occasion:source:read',
      ],
      departmentIds: [],
      traceId: 'trace-001',
    },
  }, operation);
}
