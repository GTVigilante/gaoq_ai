import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  CareDomainError,
  careOccasionSourceDigest,
  type CareOccasionPolicy,
  type CareOccasionPreference,
  type CareOccasionSourceFacts,
  type CareOccasionTask,
} from '../domain/index.js';
import type {
  CareOccasionNotificationReceipt,
  CareOccasionNotificationRequest,
} from '../integration/care-occasion-notification.port.js';
import { CareWriteConflictError } from '../persistence/care.repositories.js';
import type { UpdateMyCareOccasionPreferenceDto } from './care-occasion.dto.js';
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
  birthdayMonthDay: '12-31',
  birthdaySourceRevision: 'revision-001',
  currentEmploymentEffectiveFrom: '2025-07-27',
  employmentEffectiveFromDates: ['2024-01-01', '2025-07-27'],
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
const INPUT: UpdateMyCareOccasionPreferenceDto = {
  birthdayEnabled: true,
  anniversaryEnabled: false,
  preferredChannels: ['feishu'],
};

function task(
  status: CareOccasionTask['status'],
  overrides: Partial<CareOccasionTask> = {},
): CareOccasionTask {
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
    ...overrides,
  };
}

describe('CareOccasionApplicationService 本人偏好', () => {
  it('返回冻结的本人偏好与最小任务摘要', async () => {
    const fixture = createFixture();
    fixture.tasks.findByEmployeeId.mockResolvedValue([
      task('pending'),
      task('delivered', { id: 'care-task-002', version: 3 }),
    ]);
    const result = await runUser(fixture.context, ['erp:care:occasion:preference:read'], () =>
      fixture.service.getMySummary(),
    );
    expect(result).toEqual({
      preference: {
        id: 'preference-001',
        birthdayEnabled: true,
        anniversaryEnabled: false,
        preferredChannels: ['feishu'],
        unsubscribed: false,
        version: 1,
      },
      tasks: [
        {
          id: 'care-task-001',
          occasionType: 'birthday',
          occurrenceYear: 2026,
          status: 'pending',
          version: 1,
        },
        {
          id: 'care-task-002',
          occasionType: 'birthday',
          occurrenceYear: 2026,
          status: 'delivered',
          version: 3,
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tasks)).toBe(true);
  });

  it('MCP 摘要只暴露配置和状态计数', async () => {
    const fixture = createFixture();
    fixture.tasks.findByEmployeeId.mockResolvedValue([
      task('pending'),
      task('dispatching', { id: 'task-2' }),
      task('delivered', { id: 'task-3' }),
      task('dead', { id: 'task-4' }),
      task('cancelled', { id: 'task-5' }),
    ]);
    await expect(runUser(
      fixture.context,
      ['erp:care:occasion:preference:read'],
      () => fixture.service.getMySummaryForMcp(),
    )).resolves.toEqual({
      configured: true,
      birthdayEnabled: true,
      anniversaryEnabled: false,
      unsubscribed: false,
      pendingCount: 2,
      deliveredCount: 1,
      attentionRequiredCount: 1,
    });
  });

  it('未配置偏好时返回安全默认值', async () => {
    const fixture = createFixture({ preference: null });
    await expect(runUser(
      fixture.context,
      ['erp:care:occasion:preference:read'],
      () => fixture.service.getMySummaryForMcp(),
    )).resolves.toEqual({
      configured: false,
      birthdayEnabled: false,
      anniversaryEnabled: false,
      unsubscribed: false,
      pendingCount: 0,
      deliveredCount: 0,
      attentionRequiredCount: 0,
    });
  });

  it('拒绝缺少读权限或有效员工身份的请求', async () => {
    const noScope = createFixture();
    await expect(runUser(noScope.context, [], () =>
      noScope.service.getMySummary(),
    )).rejects.toBeInstanceOf(ForbiddenException);

    const noProfile = createFixture({ profile: null });
    await expectRejectionCode(runUser(
      noProfile.context,
      ['erp:care:occasion:preference:read'],
      () => noProfile.service.getMySummary(),
    ), 'CARE_OCCASION_IDENTITY_UNRESOLVED');
  });

  it('拒绝跨租户员工身份映射', async () => {
    const fixture = createFixture({
      profile: {
        tenantId: 'tenant-other',
        employeeId: 'employee-001',
      },
    });
    await expect(runUser(
      fixture.context,
      ['erp:care:occasion:preference:read'],
      () => fixture.service.getMySummary(),
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('创建偏好时使用可信员工事实、登记租户并调度待发送任务', async () => {
    const fixture = createFixture({ preference: null });
    fixture.tasks.listByEmployeeId.mockResolvedValue([
      task('pending'),
      task('delivered', { id: 'task-delivered' }),
    ]);
    const result = await runUser(
      fixture.context,
      ['erp:care:occasion:preference:write'],
      () => fixture.service.createMyPreference('create-key', INPUT),
    );
    expect(result.preference).toMatchObject({
      birthdayEnabled: true,
      preferredChannels: ['feishu'],
      version: 1,
    });
    expect(fixture.idempotency.execute).toHaveBeenCalledWith(
      'care.occasion.preference.create',
      'create-key',
      INPUT,
      expect.any(Function),
    );
    expect(fixture.preferences.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-001',
        personId: 'person-001',
        employeeId: 'employee-001',
      }),
      fixture.session,
    );
    expect(fixture.tenants.register).toHaveBeenCalledWith(fixture.session);
    expect(fixture.queue.scheduleOccasion).toHaveBeenCalledTimes(1);
  });

  it('创建偏好拒绝重复配置和不合资格员工', async () => {
    const existing = createFixture();
    await expectRejectionCode(runUser(
      existing.context,
      ['erp:care:occasion:preference:write'],
      () => existing.service.createMyPreference('create-key', INPUT),
    ), 'CARE_OCCASION_PREFERENCE_EXISTS');

    const ineligible = createFixture({ source: null, preference: null });
    await expectRejectionCode(runUser(
      ineligible.context,
      ['erp:care:occasion:preference:write'],
      () => ineligible.service.createMyPreference('create-key', INPUT),
    ), 'CARE_OCCASION_EMPLOYMENT_INELIGIBLE');
  });

  it('更新偏好时按允许类型取消旧任务、重建计划并调度', async () => {
    const cancelled = task('cancelled', {
      id: 'cancelled-anniversary',
      occasionType: 'employment_anniversary',
      denialCode: 'purpose_restricted',
    });
    const fixture = createFixture();
    fixture.tasks.cancelPendingByEmployee.mockResolvedValue([cancelled]);
    fixture.tasks.listByEmployeeId.mockResolvedValue([task('pending')]);
    const result = await runUser(
      fixture.context,
      ['erp:care:occasion:preference:write'],
      () => fixture.service.updateMyPreference(1, 'update-key', INPUT),
    );
    expect(result.preference.version).toBe(2);
    expect(fixture.tasks.cancelPendingByEmployee).toHaveBeenCalledWith(
      'employee-001',
      'purpose_restricted',
      expect.any(Date),
      fixture.session,
      ['birthday'],
    );
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.occasion.cancelled' }),
      fixture.session,
    );
    expect(fixture.queue.scheduleOccasion).toHaveBeenCalled();
  });

  it('取消订阅时关闭所有用途并固化取消事件', async () => {
    const cancelled = task('cancelled', {
      denialCode: 'unsubscribed',
    });
    const fixture = createFixture();
    fixture.tasks.cancelPendingByEmployee.mockResolvedValue([cancelled]);
    const result = await runUser(
      fixture.context,
      ['erp:care:occasion:preference:write'],
      () => fixture.service.unsubscribeMyPreference(1, 'unsubscribe-key'),
    );
    expect(result.preference).toMatchObject({
      birthdayEnabled: false,
      anniversaryEnabled: false,
      preferredChannels: [],
      unsubscribed: true,
      version: 2,
    });
    expect(fixture.tasks.cancelPendingByEmployee).toHaveBeenCalledWith(
      'employee-001',
      'unsubscribed',
      expect.any(Date),
      fixture.session,
    );
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.occasion.unsubscribed' }),
      fixture.session,
    );
  });

  it('拒绝系统主体自助写入和不存在的偏好', async () => {
    const system = createFixture();
    await expectRejectionCode(runSystem(
      system.context,
      ['erp:care:occasion:preference:write'],
      () => system.service.updateMyPreference(1, 'update-key', INPUT),
    ), 'CARE_OCCASION_SELF_SERVICE_REQUIRED');

    const missing = createFixture({ preference: null });
    await expect(runUser(
      missing.context,
      ['erp:care:occasion:preference:write'],
      () => missing.service.unsubscribeMyPreference(1, 'unsubscribe-key'),
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    [
      new CareWriteConflictError(),
      ConflictException,
      'CARE_VERSION_CONFLICT',
    ],
    [
      new CareDomainError('CARE_CROSS_TENANT', '跨租户'),
      ForbiddenException,
      'CARE_CROSS_TENANT',
    ],
    [
      new CareDomainError('CARE_VERSION_CONFLICT', '版本冲突'),
      ConflictException,
      'CARE_VERSION_CONFLICT',
    ],
    [
      new CareDomainError('CARE_OCCASION_CHANNEL_REQUIRED', '缺少渠道'),
      BadRequestException,
      'CARE_OCCASION_CHANNEL_REQUIRED',
    ],
  ])('将领域和仓储异常映射为稳定 HTTP 语义：%s', async (
    error,
    exception,
    code,
  ) => {
    const fixture = createFixture();
    fixture.preferences.replace.mockRejectedValue(error);
    await expect(runUser(
      fixture.context,
      ['erp:care:occasion:preference:write'],
      () => fixture.service.updateMyPreference(1, 'update-key', INPUT),
    )).rejects.toSatisfy((value: unknown) =>
      value instanceof exception &&
      responseCode(value) === code,
    );
  });
});

describe('CareOccasionApplicationService 租户对账', () => {
  it('对有资格员工刷新劳动关系、生成计划并只调度 pending 任务', async () => {
    const stale = {
      ...PREFERENCE,
      currentEmploymentId: 'employment-old',
    };
    const fixture = createFixture();
    fixture.preferences.findEnabled
      .mockResolvedValueOnce([stale])
      .mockResolvedValueOnce([]);
    fixture.tasks.listByEmployeeId.mockResolvedValue([
      task('pending'),
      task('cancelled', { id: 'task-cancelled' }),
    ]);
    const count = await runSystem(
      fixture.context,
      ['erp:care:occasion:plan', 'erp:care:occasion:source:read'],
      () => fixture.service.reconcileTenant(),
    );
    expect(count).toBeGreaterThan(0);
    expect(fixture.tasks.recoverStaleLocks).toHaveBeenCalledWith(
      expect.any(Date),
      15 * 60_000,
    );
    expect(fixture.preferences.replace).toHaveBeenCalledWith(
      expect.objectContaining({ currentEmploymentId: 'employment-001', version: 2 }),
      1,
      fixture.session,
    );
    expect(fixture.queue.scheduleOccasion).toHaveBeenCalled();
  });

  it('取消已失去资格员工的待处理任务并继续对账', async () => {
    const fixture = createFixture({ source: null });
    fixture.preferences.findEnabled.mockResolvedValueOnce([PREFERENCE]);
    fixture.tasks.cancelPendingByEmployee.mockResolvedValue([
      task('cancelled', { denialCode: 'purpose_restricted' }),
    ]);
    await expect(runSystem(
      fixture.context,
      ['erp:care:occasion:plan', 'erp:care:occasion:source:read'],
      () => fixture.service.reconcileTenant(),
    )).resolves.toBe(0);
    expect(fixture.tasks.cancelPendingByEmployee).toHaveBeenCalledWith(
      'employee-001',
      'purpose_restricted',
      expect.any(Date),
      fixture.session,
    );
  });

  it('处理满页后继续翻页，并对任务 ID 去重', async () => {
    const fixture = createFixture();
    const page = Array.from({ length: 200 }, (_, index) => ({
      ...PREFERENCE,
      id: `preference-${index}`,
      employeeId: `employee-${String(index).padStart(3, '0')}`,
    }));
    fixture.preferences.findEnabled
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([]);
    fixture.source.getEligibleByEmployeeId.mockImplementation(
      (employeeId: string) => Promise.resolve({ ...SOURCE, employeeId }),
    );
    fixture.tasks.upsertPlanned.mockImplementation(
      (planned: CareOccasionTask) => Promise.resolve({
        task: planned,
        changed: false,
      }),
    );
    await runSystem(
      fixture.context,
      ['erp:care:occasion:plan', 'erp:care:occasion:source:read'],
      () => fixture.service.reconcileTenant(),
    );
    expect(fixture.preferences.findEnabled).toHaveBeenNthCalledWith(
      2,
      'employee-199',
      200,
    );
  });

  it('聚合多租户积压、忽略未知状态并计算最老等待时长', async () => {
    const fixture = createFixture();
    fixture.tenants.listTenantIds.mockResolvedValue(['tenant-001', 'tenant-002']);
    fixture.preferences.findEnabled.mockResolvedValue([]);
    fixture.tasks.backlog
      .mockResolvedValueOnce([
        { status: 'pending', count: 2, oldestAt: '2026-07-20T00:00:00.000Z' },
        { status: 'dead', count: 1, oldestAt: null },
        { status: 'unknown', count: 99, oldestAt: null },
      ])
      .mockResolvedValueOnce([
        { status: 'pending', count: 3, oldestAt: '2026-07-21T00:00:00.000Z' },
        { status: 'dispatching', count: 1, oldestAt: '2026-07-22T00:00:00.000Z' },
      ]);
    await expect(fixture.service.reconcileRegisteredTenants()).resolves.toBe(0);
    expect(fixture.metrics.recordCareOccasion).toHaveBeenCalledWith(
      'reconcile',
      'success',
    );
    expect(fixture.metrics.setCareOccasionBacklog).toHaveBeenCalledWith(
      'pending',
      5,
      expect.any(Number),
    );
    expect(fixture.metrics.setCareOccasionBacklog).toHaveBeenCalledWith(
      'dead',
      1,
      0,
    );
  });

  it('部分租户失败时保留其他结果并要求整批重试', async () => {
    const fixture = createFixture();
    fixture.tenants.listTenantIds.mockResolvedValue(['tenant-001', 'tenant-002']);
    fixture.preferences.findEnabled
      .mockRejectedValueOnce(new Error('TENANT_TEMPORARILY_UNAVAILABLE'))
      .mockResolvedValueOnce([]);
    await expectRejectionCode(
      fixture.service.reconcileRegisteredTenants(),
      'CARE_OCCASION_RECONCILE_PARTIAL_FAILURE',
    );
    expect(fixture.metrics.recordCareOccasion).toHaveBeenCalledWith(
      'reconcile',
      'retry',
    );
    expect(fixture.metrics.setCareOccasionBacklog).not.toHaveBeenCalled();
  });

  it('拒绝缺少计划权限的租户对账', async () => {
    const fixture = createFixture();
    await expect(runSystem(fixture.context, [], () =>
      fixture.service.reconcileTenant(),
    )).rejects.toBeInstanceOf(ForbiddenException);
  });
});

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
    const dispatchRequest = fixture.notifications.dispatch.mock.calls[0]?.[0];
    expect(dispatchRequest?.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const payload = JSON.stringify(dispatchRequest);
    expect(payload).not.toContain('12-31');
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

  it('网关受控拒绝时固化 cancelled 终态', async () => {
    const fixture = createFixture();
    fixture.notifications.dispatch.mockResolvedValue({
      outcome: 'denied',
      denialCode: 'no_authorized_channel',
    });
    await expect(runWorker(fixture.context, () =>
      fixture.service.dispatchTask('care-task-001', 'worker-001'),
    )).resolves.toMatchObject({
      status: 'cancelled',
      denialCode: 'no_authorized_channel',
    });
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.occasion.cancelled' }),
      fixture.session,
    );
  });

  it.each([
    ['偏好不存在', null, SOURCE, {}, 'purpose_restricted'],
    ['已退订', { ...PREFERENCE, unsubscribed: true }, SOURCE, {}, 'unsubscribed'],
    ['用途关闭', { ...PREFERENCE, birthdayEnabled: false }, SOURCE, {}, 'purpose_restricted'],
    ['主数据失效', PREFERENCE, null, {}, 'purpose_restricted'],
    [
      '劳动关系变更',
      PREFERENCE,
      { ...SOURCE, currentEmploymentId: 'employment-new' },
      {},
      'purpose_restricted',
    ],
    ['模板漂移', PREFERENCE, SOURCE, { templateCode: 'birthday-v2' }, 'purpose_restricted'],
    [
      '渠道漂移',
      { ...PREFERENCE, preferredChannels: ['email'] as const },
      SOURCE,
      {},
      'purpose_restricted',
    ],
    ['摘要漂移', PREFERENCE, SOURCE, { sourceDigest: 'x'.repeat(43) }, 'purpose_restricted'],
    [
      '纪念日用途关闭',
      PREFERENCE,
      SOURCE,
      {
        occasionType: 'employment_anniversary' as const,
        templateCode: POLICY.anniversaryTemplateCode,
      },
      'purpose_restricted',
    ],
  ])('%s 时默认拒绝且不发送通知', async (
    _name,
    preference,
    source,
    taskOverrides,
    denialCode,
  ) => {
    const fixture = createFixture({ preference, source });
    fixture.tasks.claimById.mockResolvedValue(task('dispatching', taskOverrides));
    const result = await runWorker(fixture.context, () =>
      fixture.service.dispatchTask('care-task-001', 'worker-001'),
    );
    expect(result).toMatchObject({ status: 'cancelled', denialCode });
    expect(fixture.notifications.dispatch).not.toHaveBeenCalled();
    expect(fixture.metrics.recordCareOccasion).toHaveBeenCalledWith(
      'dispatch',
      'cancelled',
      expect.any(Number),
    );
  });

  it('通道超时释放锁并按策略退避，不把任务直接终结', async () => {
    const fixture = createFixture();
    fixture.notifications.dispatch.mockRejectedValue(
      new Error('CARE_OCCASION_GATEWAY_FAILED'),
    );
    await expectRejectionCode(runWorker(fixture.context, () =>
      fixture.service.dispatchTask('care-task-001', 'worker-001'),
    ), 'CARE_OCCASION_GATEWAY_FAILED');
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

  it('不可信异常消息统一收敛为安全错误码', async () => {
    const fixture = createFixture();
    fixture.notifications.dispatch.mockRejectedValue(new Error('upstream timeout 502'));
    await expectRejectionCode(runWorker(fixture.context, () =>
      fixture.service.dispatchTask('care-task-001', 'worker-001'),
    ), 'CARE_OCCASION_GATEWAY_FAILED');
  });

  it('达到最大尝试次数后进入 dead 并写入事件', async () => {
    const fixture = createFixture();
    fixture.tasks.claimById.mockResolvedValue(task('dispatching', { attempts: 3 }));
    fixture.notifications.dispatch.mockRejectedValue(new Error('GATEWAY_DOWN'));
    await expect(runWorker(fixture.context, () =>
      fixture.service.dispatchTask('care-task-001', 'worker-001'),
    )).resolves.toMatchObject({ status: 'dead' });
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.occasion.dead' }),
      fixture.session,
    );
    expect(fixture.metrics.recordCareOccasion).toHaveBeenCalledWith(
      'dispatch',
      'dead',
      expect.any(Number),
    );
  });

  it.each(['delivered', 'cancelled'] as const)(
    '重复 %s 终态队列消息直接收敛',
    async (status) => {
      const terminal = task(status, {
        deliveryEvidenceId: status === 'delivered' ? 'delivery-001' : null,
        deliveredAt: status === 'delivered' ? '2026-07-27T00:01:00.000Z' : null,
        denialCode: status === 'cancelled' ? 'purpose_restricted' : null,
        version: 3,
      });
      const fixture = createFixture({ currentTask: terminal });
      await expect(runWorker(fixture.context, () =>
        fixture.service.dispatchTask('care-task-001', 'worker-001'),
      )).resolves.toBe(terminal);
      expect(fixture.tasks.claimById).not.toHaveBeenCalled();
      expect(fixture.notifications.dispatch).not.toHaveBeenCalled();
      expect(fixture.metrics.recordCareOccasion).toHaveBeenCalledWith(
        'dispatch',
        'deduplicated',
        expect.any(Number),
      );
    },
  );

  it('拒绝不存在、不可认领或无权限的任务', async () => {
    const missing = createFixture({ currentTask: null });
    await expect(runWorker(missing.context, () =>
      missing.service.dispatchTask('missing', 'worker-001'),
    )).rejects.toBeInstanceOf(NotFoundException);

    const conflict = createFixture();
    conflict.tasks.claimById.mockResolvedValue(null);
    await expect(runWorker(conflict.context, () =>
      conflict.service.dispatchTask('care-task-001', 'worker-001'),
    )).rejects.toBeInstanceOf(ConflictException);

    const noScope = createFixture();
    await expect(runSystem(noScope.context, [], () =>
      noScope.service.dispatchTask('care-task-001', 'worker-001'),
    )).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CareOccasionApplicationService 运维控制面', () => {
  it('校验重放原因码、事务写入事件并重新入队', async () => {
    const replayed = task('pending', { version: 4 });
    const fixture = createFixture();
    fixture.tasks.replayDeadById.mockResolvedValue(replayed);
    await expect(runSystem(
      fixture.context,
      ['erp:care:occasion:operations'],
      () => fixture.service.replayDeadTask('care-task-001', 'MANUAL_RECOVERY'),
    )).resolves.toBe(replayed);
    expect(fixture.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'care.occasion.replayed' }),
      fixture.session,
    );
    expect(fixture.queue.scheduleOccasion).toHaveBeenCalledWith(replayed);
    expect(fixture.metrics.recordCareOccasion).toHaveBeenCalledWith(
      'replay',
      'success',
    );
  });

  it('拒绝非法原因码、非 dead 任务和缺失运维权限', async () => {
    const invalid = createFixture();
    await expect(runSystem(
      invalid.context,
      ['erp:care:occasion:operations'],
      () => invalid.service.replayDeadTask('care-task-001', 'bad'),
    )).rejects.toBeInstanceOf(BadRequestException);

    const notDead = createFixture();
    notDead.tasks.replayDeadById.mockResolvedValue(null);
    await expect(runSystem(
      notDead.context,
      ['erp:care:occasion:operations'],
      () => notDead.service.replayDeadTask('care-task-001', 'MANUAL_RECOVERY'),
    )).rejects.toBeInstanceOf(ConflictException);

    const noScope = createFixture();
    await expect(runSystem(noScope.context, [], () =>
      noScope.service.getBacklog(),
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('返回当前可信租户积压', async () => {
    const backlog = [
      { status: 'pending' as const, count: 2, oldestAt: null },
    ];
    const fixture = createFixture();
    fixture.tasks.backlog.mockResolvedValue(backlog);
    await expect(runSystem(
      fixture.context,
      ['erp:care:occasion:operations'],
      () => fixture.service.getBacklog(),
    )).resolves.toBe(backlog);
  });

  it('事务冲突映射为版本冲突且始终结束会话', async () => {
    const fixture = createFixture();
    fixture.tasks.replayDeadById.mockRejectedValue(new CareWriteConflictError());
    await expectRejectionCode(runSystem(
      fixture.context,
      ['erp:care:occasion:operations'],
      () => fixture.service.replayDeadTask('care-task-001', 'MANUAL_RECOVERY'),
    ), 'CARE_VERSION_CONFLICT');
    expect(fixture.session.endSession).toHaveBeenCalled();
  });

  it('事务回调未执行时拒绝伪造成功结果', async () => {
    const fixture = createFixture();
    fixture.session.withTransaction.mockResolvedValue(undefined);
    await expect(runSystem(
      fixture.context,
      ['erp:care:occasion:operations'],
      () => fixture.service.replayDeadTask('care-task-001', 'MANUAL_RECOVERY'),
    )).rejects.toThrow('CARE_TRANSACTION_RESULT_MISSING');
    expect(fixture.session.endSession).toHaveBeenCalled();
  });
});

interface FixtureInput {
  readonly preference?: CareOccasionPreference | null;
  readonly currentTask?: CareOccasionTask | null;
  readonly source?: CareOccasionSourceFacts | null;
  readonly profile?: { readonly tenantId: string; readonly employeeId: string } | null;
}

function createFixture(input: FixtureInput = {}) {
  const context = new TenantContextService();
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const preference = input.preference === undefined ? PREFERENCE : input.preference;
  const currentTask = input.currentTask === undefined
    ? task('pending')
    : input.currentTask;
  const sourceValue = input.source === undefined ? SOURCE : input.source;
  const profile = input.profile === undefined
    ? { tenantId: 'tenant-001', employeeId: 'employee-001' }
    : input.profile;
  const connection = {
    startSession: vi.fn().mockResolvedValue(session),
  };
  const idempotency = {
    execute: vi.fn(async (
      _operation: string,
      _key: string,
      _input: unknown,
      handler: (clientSession: typeof session) => Promise<unknown>,
    ) => handler(session)),
  };
  const accessProfiles = {
    resolveActive: vi.fn().mockResolvedValue(profile),
  };
  const source = {
    getEligibleByEmployeeId: vi.fn().mockResolvedValue(sourceValue),
  };
  const policies = {
    get: vi.fn().mockReturnValue(POLICY),
  };
  const preferences = {
    findByEmployeeId: vi.fn().mockResolvedValue(preference),
    findEnabled: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const tasks = {
    findById: vi.fn().mockResolvedValue(currentTask),
    findByEmployeeId: vi.fn().mockResolvedValue([]),
    claimById: vi.fn().mockResolvedValue(task('dispatching')),
    replace: vi.fn().mockResolvedValue(undefined),
    cancelPendingByEmployee: vi.fn().mockResolvedValue([]),
    upsertPlanned: vi.fn((planned: CareOccasionTask) => Promise.resolve({
      task: planned,
      changed: true,
    })),
    listByEmployeeId: vi.fn().mockResolvedValue([]),
    recoverStaleLocks: vi.fn().mockResolvedValue(0),
    replayDeadById: vi.fn().mockResolvedValue(null),
    backlog: vi.fn().mockResolvedValue([]),
  };
  const tenants = {
    register: vi.fn().mockResolvedValue(undefined),
    listTenantIds: vi.fn().mockResolvedValue([]),
  };
  const outbox = {
    append: vi.fn().mockResolvedValue(undefined),
  };
  const queue = {
    scheduleOccasion: vi.fn().mockResolvedValue(undefined),
  };
  const notifications = {
    dispatch: vi.fn<
      (request: CareOccasionNotificationRequest) =>
        Promise<CareOccasionNotificationReceipt>
    >(),
  };
  const metrics = {
    recordCareOccasion: vi.fn(),
    setCareOccasionBacklog: vi.fn(),
  };
  const service = new CareOccasionApplicationService(
    connection as never,
    idempotency as never,
    context,
    accessProfiles as never,
    source as never,
    policies as never,
    preferences as never,
    tasks as never,
    tenants as never,
    outbox as never,
    queue as never,
    notifications,
    metrics as never,
  );
  return {
    service,
    context,
    session,
    connection,
    idempotency,
    accessProfiles,
    source,
    policies,
    preferences,
    tasks,
    tenants,
    outbox,
    queue,
    notifications,
    metrics,
  };
}

async function runUser<T>(
  context: TenantContextService,
  scopes: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return runAs(context, 'user', scopes, operation);
}

async function runSystem<T>(
  context: TenantContextService,
  scopes: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return runAs(context, 'system_job', scopes, operation);
}

async function runWorker<T>(
  context: TenantContextService,
  operation: () => Promise<T>,
): Promise<T> {
  return runSystem(
    context,
    ['erp:care:occasion:dispatch', 'erp:care:occasion:source:read'],
    operation,
  );
}

async function runAs<T>(
  context: TenantContextService,
  actorType: 'user' | 'system_job',
  scopes: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: {
      actorId: actorType === 'user' ? 'user-001' : 'system:care-worker',
      actorType,
      tenantId: 'tenant-001',
      roleCodes: ['CARE_OCCASION_WORKER'],
      scopes: [...scopes],
      departmentIds: [],
      traceId: 'trace-001',
    },
  }, operation);
}

function responseCode(error: unknown): string | undefined {
  if (error instanceof HttpException) {
    const response: unknown = error.getResponse();
    if (typeof response === 'object' && response !== null && 'code' in response) {
      return typeof response.code === 'string' ? response.code : undefined;
    }
  }
  return undefined;
}

async function expectRejectionCode(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(responseCode(error)).toBe(expectedCode);
    return;
  }
  throw new Error(`预期请求被拒绝：${expectedCode}`);
}
