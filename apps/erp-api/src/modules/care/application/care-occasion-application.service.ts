import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Connection } from 'mongoose';

import { IdempotencyService } from '../../../core/idempotency/idempotency.service.js';
import {
  elapsedSeconds,
  MetricsService,
} from '../../../core/observability/metrics.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { AccessProfileRepository } from '../../identity/access-profile.repository.js';
import { OrgCareOccasionSourceService } from '../../org/application/org-care-occasion-source.service.js';
import { CareExecutionQueueService } from '../care-execution-queue.service.js';
import {
  CareDomainError,
  careOccasionSourceDigest,
  careOccasionPreferenceEvent,
  careOccasionTaskEvent,
  careOccasionTaskReplayedEvent,
  completeCareOccasionTask,
  createCareOccasionPreference,
  planCareOccasionTasks,
  releaseCareOccasionTask,
  updateCareOccasionPreference,
  type CareOccasionChannel,
  type CareOccasionPreference,
  type CareOccasionTask,
} from '../domain/index.js';
import { CareOccasionNotificationPort } from '../integration/care-occasion-notification.port.js';
import { CareOutboxWriter } from '../persistence/care-outbox.writer.js';
import {
  CareOccasionPreferenceRepository,
  CareOccasionTaskRepository,
  CareOccasionTenantRepository,
  CareWriteConflictError,
} from '../persistence/care.repositories.js';
import type { UpdateMyCareOccasionPreferenceDto } from './care-occasion.dto.js';
import { CareOccasionPolicyService } from './care-occasion-policy.service.js';

export interface CareOccasionPreferenceSummary extends Record<string, unknown> {
  readonly id: string;
  readonly birthdayEnabled: boolean;
  readonly anniversaryEnabled: boolean;
  readonly preferredChannels: readonly CareOccasionChannel[];
  readonly unsubscribed: boolean;
  readonly version: number;
}

export interface CareOccasionTaskSummary extends Record<string, unknown> {
  readonly id: string;
  readonly occasionType: CareOccasionTask['occasionType'];
  readonly occurrenceYear: number;
  readonly status: CareOccasionTask['status'];
  readonly version: number;
}

export interface MyCareOccasionSummary extends Record<string, unknown> {
  readonly preference: CareOccasionPreferenceSummary | null;
  readonly tasks: readonly CareOccasionTaskSummary[];
}

export interface MyCareOccasionMcpSummary extends Record<string, unknown> {
  readonly configured: boolean;
  readonly birthdayEnabled: boolean;
  readonly anniversaryEnabled: boolean;
  readonly unsubscribed: boolean;
  readonly pendingCount: number;
  readonly deliveredCount: number;
  readonly attentionRequiredCount: number;
}

/**
 * 员工本人关怀偏好与任务应用服务。
 * 租户、员工、主数据、策略和发送时间全部来自可信上下文或服务端控制面。
 */
@Injectable()
export class CareOccasionApplicationService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly idempotency: IdempotencyService,
    private readonly context: TenantContextService,
    private readonly accessProfiles: AccessProfileRepository,
    private readonly source: OrgCareOccasionSourceService,
    private readonly policies: CareOccasionPolicyService,
    private readonly preferences: CareOccasionPreferenceRepository,
    private readonly tasks: CareOccasionTaskRepository,
    private readonly tenants: CareOccasionTenantRepository,
    private readonly outbox: CareOutboxWriter,
    private readonly queue: CareExecutionQueueService,
    private readonly notifications: CareOccasionNotificationPort,
    private readonly metrics: MetricsService,
  ) {}

  async getMySummary(): Promise<MyCareOccasionSummary> {
    this.assertScope('erp:care:occasion:preference:read');
    const employeeId = await this.currentEmployeeId();
    const [preference, tasks] = await Promise.all([
      this.preferences.findByEmployeeId(employeeId),
      this.tasks.findByEmployeeId(employeeId),
    ]);
    return Object.freeze({
      preference: preference === null ? null : preferenceSummary(preference),
      tasks: Object.freeze(tasks.map((task) => taskSummary(task))),
    });
  }

  async getMySummaryForMcp(): Promise<MyCareOccasionMcpSummary> {
    const summary = await this.getMySummary();
    return Object.freeze({
      configured: summary.preference !== null,
      birthdayEnabled: summary.preference?.birthdayEnabled ?? false,
      anniversaryEnabled: summary.preference?.anniversaryEnabled ?? false,
      unsubscribed: summary.preference?.unsubscribed ?? false,
      pendingCount: summary.tasks.filter((task) =>
        task.status === 'pending' || task.status === 'dispatching',
      ).length,
      deliveredCount: summary.tasks.filter((task) => task.status === 'delivered').length,
      attentionRequiredCount: summary.tasks.filter((task) => task.status === 'dead').length,
    });
  }

  async createMyPreference(
    key: string,
    input: UpdateMyCareOccasionPreferenceDto,
  ): Promise<{ readonly preference: CareOccasionPreferenceSummary }> {
    this.assertSelfWrite();
    const source = await this.currentSource();
    const policy = this.policies.get(this.context.getTenantRequired().tenantId);
    const result = await this.run(async () => this.idempotency.execute(
      'care.occasion.preference.create',
      key,
      input,
      async (session) => {
        const existing = await this.preferences.findByEmployeeId(source.employeeId, session);
        if (existing !== null) throw new ConflictException({
          code: 'CARE_OCCASION_PREFERENCE_EXISTS',
          message: '关怀偏好已存在，必须使用版本化更新',
        });
        const preference = createCareOccasionPreference({
          id: createEventId(),
          tenantId: this.context.getTenantRequired().tenantId,
          personId: source.personId,
          employeeId: source.employeeId,
          currentEmploymentId: source.currentEmploymentId,
          birthdayEnabled: input.birthdayEnabled,
          anniversaryEnabled: input.anniversaryEnabled,
          preferredChannels: input.preferredChannels,
          unsubscribed: false,
        }, new Date());
        await this.preferences.insert(preference, session);
        await this.tenants.register(session);
        const planned = await this.plan(preference, source, policy, session);
        await this.outbox.append(
          careOccasionPreferenceEvent(preference, 'care.occasion.preference_updated'),
          session,
        );
        for (const task of planned) {
          await this.outbox.append(
            careOccasionTaskEvent(task, 'care.occasion.scheduled'),
            session,
          );
        }
        return { preference: preferenceSummary(preference) };
      },
    ));
    await this.scheduleCurrentTasks(source.employeeId);
    return result;
  }

  async updateMyPreference(
    expectedVersion: number,
    key: string,
    input: UpdateMyCareOccasionPreferenceDto,
  ): Promise<{ readonly preference: CareOccasionPreferenceSummary }> {
    this.assertSelfWrite();
    const source = await this.currentSource();
    const policy = this.policies.get(this.context.getTenantRequired().tenantId);
    const result = await this.run(async () => this.idempotency.execute(
      'care.occasion.preference.update',
      key,
      { expectedVersion, ...input },
      async (session) => {
        const current = await this.requirePreference(source.employeeId, session);
        const preference = updateCareOccasionPreference(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          currentEmploymentId: source.currentEmploymentId,
          birthdayEnabled: input.birthdayEnabled,
          anniversaryEnabled: input.anniversaryEnabled,
          preferredChannels: input.preferredChannels,
          unsubscribeAll: false,
        }, new Date());
        await this.preferences.replace(preference, expectedVersion, session);
        await this.cancelDisabled(preference, session);
        const planned = await this.plan(preference, source, policy, session);
        await this.outbox.append(
          careOccasionPreferenceEvent(preference, 'care.occasion.preference_updated'),
          session,
        );
        for (const task of planned) {
          await this.outbox.append(
            careOccasionTaskEvent(task, 'care.occasion.scheduled'),
            session,
          );
        }
        return { preference: preferenceSummary(preference) };
      },
    ));
    await this.scheduleCurrentTasks(source.employeeId);
    return result;
  }

  async unsubscribeMyPreference(
    expectedVersion: number,
    key: string,
  ): Promise<{ readonly preference: CareOccasionPreferenceSummary }> {
    this.assertSelfWrite();
    const employeeId = await this.currentEmployeeId();
    return this.run(async () => this.idempotency.execute(
      'care.occasion.preference.unsubscribe',
      key,
      { expectedVersion },
      async (session) => {
        const current = await this.requirePreference(employeeId, session);
        const preference = updateCareOccasionPreference(current, {
          tenantId: this.context.getTenantRequired().tenantId,
          expectedVersion,
          currentEmploymentId: current.currentEmploymentId,
          birthdayEnabled: false,
          anniversaryEnabled: false,
          preferredChannels: [],
          unsubscribeAll: true,
        }, new Date());
        await this.preferences.replace(preference, expectedVersion, session);
        const cancelled = await this.tasks.cancelPendingByEmployee(
          preference.employeeId,
          'unsubscribed',
          new Date(),
          session,
        );
        await this.outbox.append(
          careOccasionPreferenceEvent(preference, 'care.occasion.unsubscribed'),
          session,
        );
        for (const task of cancelled) {
          await this.outbox.append(
            careOccasionTaskEvent(task, 'care.occasion.cancelled'),
            session,
          );
        }
        return { preference: preferenceSummary(preference) };
      },
    ));
  }

  /** 空载荷周期任务通过服务端租户注册表对账，不接受队列传入租户或员工范围。 */
  async reconcileRegisteredTenants(): Promise<number> {
    const tenantIds = await this.tenants.listTenantIds();
    let planned = 0;
    let failures = 0;
    const aggregate = new Map<
      'pending' | 'dispatching' | 'dead',
      { count: number; oldestAt: number | null }
    >([
      ['pending', { count: 0, oldestAt: null }],
      ['dispatching', { count: 0, oldestAt: null }],
      ['dead', { count: 0, oldestAt: null }],
    ]);
    for (const tenantId of tenantIds) {
      let result: {
        readonly planned: number;
        readonly backlog: Awaited<ReturnType<CareOccasionTaskRepository['backlog']>>;
      };
      try {
        result = await this.context.run(
          systemContext(tenantId, 'reconcile'),
          async () => ({
            planned: await this.reconcileTenant(),
            backlog: await this.tasks.backlog(),
          }),
        );
      } catch {
        failures += 1;
        continue;
      }
      planned += result.planned;
      for (const item of result.backlog) {
        const current = aggregate.get(item.status);
        if (current === undefined) continue;
        current.count += item.count;
        const oldestAt = item.oldestAt === null ? null : Date.parse(item.oldestAt);
        if (
          oldestAt !== null &&
          (current.oldestAt === null || oldestAt < current.oldestAt)
        ) current.oldestAt = oldestAt;
      }
    }
    this.metrics.recordCareOccasion(
      'reconcile',
      failures === 0 ? 'success' : 'retry',
    );
    if (failures > 0) throw new ServiceUnavailableException({
      code: 'CARE_OCCASION_RECONCILE_PARTIAL_FAILURE',
      message: '部分租户关怀对账失败，已保留其他租户处理结果并等待重试',
    });
    const now = Date.now();
    for (const [status, value] of aggregate) {
      this.metrics.setCareOccasionBacklog(
        status,
        value.count,
        value.oldestAt === null ? 0 : (now - value.oldestAt) / 1_000,
      );
    }
    return planned;
  }

  async reconcileTenant(): Promise<number> {
    this.assertScope('erp:care:occasion:plan');
    await this.tasks.recoverStaleLocks(new Date(), 15 * 60_000);
    let afterEmployeeId: string | null = null;
    let count = 0;
    for (;;) {
      const page = await this.preferences.findEnabled(afterEmployeeId, 200);
      if (page.length === 0) break;
      for (const current of page) {
        const source = await this.source.getEligibleByEmployeeId(current.employeeId);
        if (source === null) {
          await this.inTransaction(async (session) => {
            const cancelled = await this.tasks.cancelPendingByEmployee(
              current.employeeId,
              'purpose_restricted',
              new Date(),
              session,
            );
            for (const task of cancelled) {
              await this.outbox.append(
                careOccasionTaskEvent(task, 'care.occasion.cancelled'),
                session,
              );
            }
          });
          continue;
        }
        const policy = this.policies.get(current.tenantId);
        const taskIds = await this.inTransaction(async (session) => {
          const preference = current.currentEmploymentId === source.currentEmploymentId
            ? current
            : await this.refreshEmploymentReference(current, source.currentEmploymentId, session);
          const planned = await this.plan(preference, source, policy, session);
          for (const task of planned) {
            await this.outbox.append(
              careOccasionTaskEvent(task, 'care.occasion.scheduled'),
              session,
            );
          }
          return planned.map((task) => task.id);
        });
        count += taskIds.length;
        await this.scheduleTaskIds(taskIds);
        await this.scheduleCurrentTasks(current.employeeId);
      }
      afterEmployeeId = page.at(-1)?.employeeId ?? null;
      if (page.length < 200) break;
    }
    return count;
  }

  async dispatchTask(taskId: string, workerId: string): Promise<CareOccasionTask> {
    this.assertScope('erp:care:occasion:dispatch');
    const startedAt = process.hrtime.bigint();
    const current = await this.tasks.findById(taskId);
    if (current === null) throw new NotFoundException({
      code: 'CARE_OCCASION_TASK_NOT_FOUND',
      message: '关怀任务不存在',
    });
    if (current.status === 'delivered' || current.status === 'cancelled') {
      this.metrics.recordCareOccasion(
        'dispatch',
        'deduplicated',
        elapsedSeconds(startedAt),
      );
      return current;
    }
    const policy = this.policies.get(current.tenantId);
    const task = await this.tasks.claimById(taskId, workerId, new Date());
    if (task === null) throw new ConflictException({
      code: 'CARE_OCCASION_TASK_NOT_DISPATCHABLE',
      message: '关怀任务当前不可投递',
    });
    try {
      const [preference, source] = await Promise.all([
        this.preferences.findByEmployeeId(task.employeeId),
        this.source.getEligibleByEmployeeId(task.employeeId),
      ]);
      const enabled = task.occasionType === 'birthday'
        ? preference?.birthdayEnabled === true
        : preference?.anniversaryEnabled === true;
      const expectedTemplate = task.occasionType === 'birthday'
        ? policy.birthdayTemplateCode
        : policy.anniversaryTemplateCode;
      const currentDigest = preference === null || source === null
        ? null
        : careOccasionSourceDigest({
            tenantId: task.tenantId,
            source,
            preferenceVersion: preference.version,
            policyVersion: policy.version,
          });
      if (
        preference === null ||
        preference.unsubscribed ||
        !enabled ||
        source === null ||
        source.currentEmploymentId !== task.employmentId ||
        currentDigest !== task.sourceDigest ||
        expectedTemplate !== task.templateCode ||
        JSON.stringify(preference.preferredChannels) !==
          JSON.stringify(task.preferredChannels)
      ) {
        const cancelled = completeCareOccasionTask(task, {
          outcome: 'denied',
          denialCode: preference?.unsubscribed === true
            ? 'unsubscribed'
            : 'purpose_restricted',
        }, new Date());
        await this.persistTerminal(task, cancelled, 'care.occasion.cancelled');
        this.metrics.recordCareOccasion(
          'dispatch',
          'cancelled',
          elapsedSeconds(startedAt),
        );
        return cancelled;
      }
      const receipt = await this.notifications.dispatch({
        tenantId: task.tenantId,
        occasionTaskId: task.id,
        employeeId: task.employeeId,
        occasionType: task.occasionType,
        purpose: 'employee_care',
        templateCode: task.templateCode,
        policyVersion: task.policyVersion,
        scheduledAt: task.scheduledAt,
        preferredChannels: task.preferredChannels,
        sourceDigest: task.sourceDigest,
        idempotencyKey: createHash('sha256').update(JSON.stringify([
          'gaoq-care-occasion-delivery-v1',
          task.tenantId,
          task.id,
          task.sourceDigest,
        ]), 'utf8').digest('base64url'),
      });
      const terminal = completeCareOccasionTask(task, receipt, new Date());
      await this.persistTerminal(
        task,
        terminal,
        terminal.status === 'delivered'
          ? 'care.occasion.delivered'
          : 'care.occasion.cancelled',
      );
      this.metrics.recordCareOccasion(
        'dispatch',
        terminal.status === 'delivered' ? 'delivered' : 'cancelled',
        elapsedSeconds(startedAt),
      );
      return terminal;
    } catch (error) {
      const released = releaseCareOccasionTask(
        task,
        policy.maxAttempts,
        new Date(),
      );
      await this.inTransaction(async (session) => {
        await this.tasks.replace(released, task.version, session);
        if (released.status === 'dead') {
          await this.outbox.append(
            careOccasionTaskEvent(released, 'care.occasion.dead'),
            session,
          );
        }
      });
      this.metrics.recordCareOccasion(
        'dispatch',
        released.status === 'dead' ? 'dead' : 'retry',
        elapsedSeconds(startedAt),
      );
      if (released.status === 'dead') return released;
      throw new ServiceUnavailableException({
        code: safeFailureCode(error),
        message: '关怀通知暂不可用，任务已进入受控重试',
      });
    }
  }

  async replayDeadTask(taskId: string, reasonCode: string): Promise<CareOccasionTask> {
    this.assertScope('erp:care:occasion:operations');
    if (!/^[A-Z][A-Z0-9_]{7,63}$/.test(reasonCode)) throw new BadRequestException({
      code: 'CARE_OCCASION_REPLAY_REASON_INVALID',
      message: '关怀任务重放必须提供受控原因码',
    });
    const task = await this.inTransaction(async (session) => {
      const replayed = await this.tasks.replayDeadById(taskId, new Date(), session);
      if (replayed !== null) {
        await this.outbox.append(
          careOccasionTaskReplayedEvent(replayed, reasonCode),
          session,
        );
      }
      return replayed;
    });
    if (task === null) throw new ConflictException({
      code: 'CARE_OCCASION_TASK_NOT_DEAD',
      message: '仅允许重放 dead 终态关怀任务',
    });
    await this.queue.scheduleOccasion(task);
    this.metrics.recordCareOccasion('replay', 'success');
    return task;
  }

  async getBacklog() {
    this.assertScope('erp:care:occasion:operations');
    return this.tasks.backlog();
  }

  private async plan(
    preference: CareOccasionPreference,
    source: NonNullable<Awaited<ReturnType<OrgCareOccasionSourceService['getEligibleByEmployeeId']>>>,
    policy: ReturnType<CareOccasionPolicyService['get']>,
    session: ClientSession,
  ): Promise<readonly CareOccasionTask[]> {
    const planned = planCareOccasionTasks({
      tenantId: this.context.getTenantRequired().tenantId,
      source,
      preference,
      policy,
      now: new Date(),
      createId: (scheduledAt, occasionType) => taskId(
        this.context.getTenantRequired().tenantId,
        preference.employeeId,
        occasionType,
        scheduledAt,
      ),
    });
    const stored: CareOccasionTask[] = [];
    for (const task of planned) {
      const result = await this.tasks.upsertPlanned(task, session);
      if (result.changed && result.task.status === 'pending') stored.push(result.task);
    }
    return Object.freeze(stored);
  }

  private async cancelDisabled(
    preference: CareOccasionPreference,
    session: ClientSession,
  ): Promise<void> {
    const allowed = [
      ...(preference.birthdayEnabled ? ['birthday' as const] : []),
      ...(preference.anniversaryEnabled ? ['employment_anniversary' as const] : []),
    ];
    const cancelled = await this.tasks.cancelPendingByEmployee(
      preference.employeeId,
      'purpose_restricted',
      new Date(),
      session,
      allowed,
    );
    for (const task of cancelled) {
      await this.outbox.append(
        careOccasionTaskEvent(task, 'care.occasion.cancelled'),
        session,
      );
    }
  }

  private async scheduleCurrentTasks(employeeId: string): Promise<void> {
    const tasks = await this.tasks.listByEmployeeId(employeeId, 100);
    for (const task of tasks) {
      if (task.status === 'pending') await this.queue.scheduleOccasion(task);
    }
  }

  private async scheduleTaskIds(taskIds: readonly string[]): Promise<void> {
    for (const taskId of [...new Set(taskIds)]) {
      const task = await this.tasks.findById(taskId);
      if (task?.status === 'pending') await this.queue.scheduleOccasion(task);
    }
  }

  private async refreshEmploymentReference(
    preference: CareOccasionPreference,
    currentEmploymentId: string,
    session: ClientSession,
  ): Promise<CareOccasionPreference> {
    const updated = updateCareOccasionPreference(preference, {
      tenantId: preference.tenantId,
      expectedVersion: preference.version,
      currentEmploymentId,
      birthdayEnabled: preference.birthdayEnabled,
      anniversaryEnabled: preference.anniversaryEnabled,
      preferredChannels: preference.preferredChannels,
      unsubscribeAll: false,
    }, new Date());
    await this.preferences.replace(updated, preference.version, session);
    await this.outbox.append(
      careOccasionPreferenceEvent(updated, 'care.occasion.preference_updated'),
      session,
    );
    return updated;
  }

  private async persistTerminal(
    previous: CareOccasionTask,
    terminal: CareOccasionTask,
    type: 'care.occasion.delivered' | 'care.occasion.cancelled',
  ): Promise<void> {
    await this.inTransaction(async (session) => {
      await this.tasks.replace(terminal, previous.version, session);
      await this.outbox.append(careOccasionTaskEvent(terminal, type), session);
    });
  }

  private async currentSource() {
    const employeeId = await this.currentEmployeeId();
    const trusted = this.context.getRequired();
    const source = await this.context.run({
      tenant: trusted.tenant,
      actor: {
        actorId: 'system:care-occasion-source',
        actorType: 'system_job',
        tenantId: trusted.tenant.tenantId,
        roleCodes: ['CARE_OCCASION_SOURCE'],
        scopes: ['erp:care:occasion:source:read'],
        departmentIds: [],
        traceId: trusted.actor.traceId,
      },
    }, () => this.source.getEligibleByEmployeeId(employeeId));
    if (source === null) throw new ConflictException({
      code: 'CARE_OCCASION_EMPLOYMENT_INELIGIBLE',
      message: '当前员工或劳动关系不具备关怀资格',
    });
    return source;
  }

  private async currentEmployeeId(): Promise<string> {
    const actor = this.context.getActorRequired();
    const tenantId = this.context.getTenantRequired().tenantId;
    const profile = await this.accessProfiles.resolveActive(tenantId, actor.actorId);
    if (profile === null || profile.tenantId !== tenantId) throw new ForbiddenException({
      code: 'CARE_OCCASION_IDENTITY_UNRESOLVED',
      message: '当前主体未绑定有效员工身份',
    });
    return profile.employeeId;
  }

  private async requirePreference(
    employeeId: string,
    session: ClientSession,
  ): Promise<CareOccasionPreference> {
    const preference = await this.preferences.findByEmployeeId(employeeId, session);
    if (preference === null) throw new NotFoundException({
      code: 'CARE_OCCASION_PREFERENCE_NOT_FOUND',
      message: '关怀偏好不存在',
    });
    return preference;
  }

  private assertSelfWrite(): void {
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'user') throw new ForbiddenException({
      code: 'CARE_OCCASION_SELF_SERVICE_REQUIRED',
      message: '关怀偏好只能由员工本人修改',
    });
    this.assertScope('erp:care:occasion:preference:write');
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) throw new ForbiddenException({
      code: 'CARE_SCOPE_REQUIRED',
      message: `缺少 ${scope}`,
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CareWriteConflictError) throw new ConflictException({
        code: 'CARE_VERSION_CONFLICT',
        message: error.message,
      });
      if (error instanceof CareDomainError) {
        if (error.code.includes('TENANT') || error.code.includes('SOURCE_MISMATCH')) {
          throw new ForbiddenException({ code: error.code, message: error.message });
        }
        if (
          error.code.includes('VERSION') ||
          error.code.includes('IMMUTABLE') ||
          error.code.includes('NOT_DUE') ||
          error.code.includes('NOT_DISPATCHING')
        ) throw new ConflictException({ code: error.code, message: error.message });
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  private async inTransaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let completed = false;
      let result!: T;
      await session.withTransaction(async () => {
        result = await operation(session);
        completed = true;
      });
      if (!completed) throw new Error('CARE_TRANSACTION_RESULT_MISSING');
      return result;
    } catch (error) {
      if (error instanceof CareWriteConflictError) throw new ConflictException({
        code: 'CARE_VERSION_CONFLICT',
        message: error.message,
      });
      throw error;
    } finally {
      await session.endSession();
    }
  }
}

function preferenceSummary(
  preference: CareOccasionPreference,
): CareOccasionPreferenceSummary {
  return Object.freeze({
    id: preference.id,
    birthdayEnabled: preference.birthdayEnabled,
    anniversaryEnabled: preference.anniversaryEnabled,
    preferredChannels: Object.freeze([...preference.preferredChannels]),
    unsubscribed: preference.unsubscribed,
    version: preference.version,
  });
}

function taskSummary(task: CareOccasionTask): CareOccasionTaskSummary {
  return Object.freeze({
    id: task.id,
    occasionType: task.occasionType,
    occurrenceYear: task.occurrenceYear,
    status: task.status,
    version: task.version,
  });
}

function taskId(
  tenantId: string,
  employeeId: string,
  occasionType: string,
  scheduledAt: Date,
): string {
  return `care-task-${createHash('sha256').update(JSON.stringify([
    'gaoq-care-occasion-task-v1',
    tenantId,
    employeeId,
    occasionType,
    scheduledAt.toISOString().slice(0, 4),
  ]), 'utf8').digest('base64url')}`;
}

function systemContext(tenantId: string, operation: string) {
  return {
    tenant: { tenantId, source: 'service_identity' as const },
    actor: {
      actorId: `system:care-occasion-${operation}`,
      actorType: 'system_job' as const,
      tenantId,
      roleCodes: ['CARE_OCCASION_WORKER'],
      scopes: [
        'erp:care:occasion:plan',
        'erp:care:occasion:source:read',
        'erp:care:occasion:dispatch',
        'erp:care:occasion:operations',
      ],
      departmentIds: [],
      traceId: `care-occasion-${operation}-${Date.now()}`,
    },
  };
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)) {
    return error.message;
  }
  return 'CARE_OCCASION_GATEWAY_FAILED';
}
