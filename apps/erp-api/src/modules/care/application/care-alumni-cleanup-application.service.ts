import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';

import {
  elapsedSeconds,
  MetricsService,
} from '../../../core/observability/metrics.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  alumniCleanupTaskEvent,
  completeAlumniCleanupTask,
  failAlumniCleanupTask,
  type AlumniCleanupTask,
} from '../domain/index.js';
import { CareAlumniCleanupPort } from '../integration/care-alumni-cleanup.port.js';
import { CareAlumniCleanupTargetRegistry } from '../integration/care-alumni-cleanup-target-registry.js';
import { CareOutboxWriter } from '../persistence/care-outbox.writer.js';
import {
  CareAlumniCleanupTaskRepository,
  CareAlumniConsentRepository,
  CareWriteConflictError,
} from '../persistence/care.repositories.js';
import { CareExecutionQueueService } from '../care-execution-queue.service.js';

export interface CareAlumniCleanupStatusSummary extends Record<string, unknown> {
  readonly consentId: string;
  readonly consentStatus: 'active' | 'withdrawn' | 'expired';
  readonly cleanupStatus:
    | 'not_required'
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'attention_required'
    | 'configuration_required';
  readonly counts: Readonly<{
    pending: number;
    dispatching: number;
    completed: number;
    dead: number;
  }>;
  readonly targets: readonly Readonly<{
    targetCode: string;
    policyVersion: string;
    status: AlumniCleanupTask['status'];
  }>[];
}

export interface CareAlumniCleanupMcpSummary {
  readonly consentStatus: CareAlumniCleanupStatusSummary['consentStatus'];
  readonly cleanupStatus: CareAlumniCleanupStatusSummary['cleanupStatus'];
  readonly counts: CareAlumniCleanupStatusSummary['counts'];
}

/** 清理投递前重读授权终态与服务端登记策略，并在事务中固化不可变证明摘要。 */
@Injectable()
export class CareAlumniCleanupApplicationService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly context: TenantContextService,
    private readonly consents: CareAlumniConsentRepository,
    private readonly tasks: CareAlumniCleanupTaskRepository,
    private readonly targets: CareAlumniCleanupTargetRegistry,
    private readonly outbox: CareOutboxWriter,
    private readonly gateway: CareAlumniCleanupPort,
    private readonly queue: CareExecutionQueueService,
    private readonly metrics: MetricsService,
  ) {}

  async dispatchTask(taskId: string, workerId: string): Promise<AlumniCleanupTask> {
    this.assertScope('erp:care:alumni:cleanup:dispatch');
    const startedAt = process.hrtime.bigint();
    const claimed = await this.tasks.claim(taskId, workerId, new Date());
    if (claimed === null) {
      const existing = await this.tasks.findById(taskId);
      if (existing === null) throw new NotFoundException({
        code: 'CARE_ALUMNI_CLEANUP_TASK_NOT_FOUND',
        message: '校友清理任务不存在',
      });
      this.metrics.recordCareAlumniCleanup(
        'dispatch',
        existing.status === 'completed' ? 'deduplicated' : 'deferred',
        elapsedSeconds(startedAt),
      );
      return existing;
    }
    let proof: Awaited<ReturnType<CareAlumniCleanupPort['execute']>>;
    try {
      const consent = await this.requireConsent(claimed.consentId);
      const target = this.targets.require(claimed.targetCode);
      const terminatedAt = claimed.terminationReason === 'withdrawn'
        ? consent.withdrawnAt
        : consent.expiredAt;
      if (
        consent.version !== claimed.consentVersion ||
        consent.status !== claimed.terminationReason ||
        consent.purpose !== claimed.consentPurpose ||
        terminatedAt !== claimed.terminatedAt ||
        target.policyVersion !== claimed.policyVersion ||
        target.maxAttempts !== claimed.maxAttempts ||
        target.proofRetentionDays !== claimed.proofRetentionDays
      ) throw new Error('CARE_ALUMNI_CLEANUP_SOURCE_STATE_MISMATCH');
      proof = await this.gateway.execute(claimed);
    } catch (error: unknown) {
      const failureCode = safeFailureCode(error);
      const failed = failAlumniCleanupTask(
        claimed,
        workerId,
        failureCode,
        new Date(),
      );
      await this.persistClaimed(
        claimed,
        failed,
        workerId,
        failed.status === 'dead' ? 'care.alumni_cleanup.dead' : null,
      );
      this.metrics.recordCareAlumniCleanup(
        'dispatch',
        failed.status === 'dead' ? 'dead' : 'retry',
        elapsedSeconds(startedAt),
      );
      if (failed.status === 'pending') await this.queue.scheduleAlumniCleanup(failed);
      return failed;
    }
    const completed = completeAlumniCleanupTask(
      claimed,
      proof,
      workerId,
      new Date(),
    );
    // 外部副作用已成功：本地事务失败时保留 dispatching，锁超时后用同一幂等键重取证明。
    await this.persistClaimed(
      claimed,
      completed,
      workerId,
      'care.alumni_cleanup.completed',
    );
    this.metrics.recordCareAlumniCleanup(
      'dispatch',
      'completed',
      elapsedSeconds(startedAt),
    );
    return completed;
  }

  async getStatus(consentId: string): Promise<CareAlumniCleanupStatusSummary> {
    this.assertScope('erp:care:alumni:cleanup:read');
    const consent = await this.requireConsent(consentId);
    const tasks = await this.tasks.findByConsentId(consentId);
    const configured = this.targets.targets();
    const configuredKeys = new Set(configured.map((target) =>
      `${target.targetCode}:${target.policyVersion}`));
    const relevantTasks = tasks.filter((task) =>
      task.consentVersion === consent.version &&
      task.consentPurpose === consent.purpose &&
      configuredKeys.has(`${task.targetCode}:${task.policyVersion}`));
    const counts = Object.freeze({
      pending: relevantTasks.filter((task) => task.status === 'pending').length,
      dispatching: relevantTasks.filter((task) => task.status === 'dispatching').length,
      completed: relevantTasks.filter((task) => task.status === 'completed').length,
      dead: relevantTasks.filter((task) => task.status === 'dead').length,
    });
    const completedTargets = new Set(relevantTasks
      .filter((task) => task.status === 'completed')
      .map((task) => `${task.targetCode}:${task.policyVersion}`));
    const allConfiguredCompleted = configured.length > 0 &&
      configured.every((target) =>
        completedTargets.has(`${target.targetCode}:${target.policyVersion}`));
    const cleanupStatus = consent.status === 'active'
      ? 'not_required'
      : configured.length === 0
        ? 'configuration_required'
        : counts.dead > 0
          ? 'attention_required'
          : allConfiguredCompleted
            ? 'completed'
            : counts.dispatching > 0 || counts.completed > 0
              ? 'in_progress'
              : 'pending';
    return Object.freeze({
      consentId,
      consentStatus: consent.status,
      cleanupStatus,
      counts,
      targets: Object.freeze(relevantTasks.map((task) => Object.freeze({
        targetCode: task.targetCode,
        policyVersion: task.policyVersion,
        status: task.status,
      }))),
    });
  }

  async getStatusForMcp(consentId: string): Promise<CareAlumniCleanupMcpSummary> {
    const value = await this.getStatus(consentId);
    return Object.freeze({
      consentStatus: value.consentStatus,
      cleanupStatus: value.cleanupStatus,
      counts: value.counts,
    });
  }

  private async persistClaimed(
    before: AlumniCleanupTask,
    after: AlumniCleanupTask,
    workerId: string,
    eventType:
      | 'care.alumni_cleanup.completed'
      | 'care.alumni_cleanup.dead'
      | null,
  ): Promise<void> {
    await this.inTransaction(async (session) => {
      await this.tasks.replaceClaimed(after, before.version, workerId, session);
      if (eventType !== null) {
        await this.outbox.append(alumniCleanupTaskEvent(after, eventType), session);
      }
    });
  }

  private async requireConsent(
    id: string,
  ): Promise<NonNullable<Awaited<ReturnType<CareAlumniConsentRepository['findById']>>>> {
    const consent = await this.consents.findById(id);
    if (consent === null) throw new NotFoundException({
      code: 'CARE_ALUMNI_CONSENT_NOT_FOUND',
      message: '校友授权不存在',
    });
    return consent;
  }

  private assertScope(scope: string): void {
    if (!this.context.getActorRequired().scopes.includes(scope)) {
      throw new ForbiddenException({
        code: 'CARE_SCOPE_DENIED',
        message: '缺少校友清理操作权限',
      });
    }
  }

  private async inTransaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let completed = false;
      let value!: T;
      await session.withTransaction(async () => {
        value = await operation(session);
        completed = true;
      });
      if (!completed) throw new Error('CARE_ALUMNI_CLEANUP_TRANSACTION_EMPTY');
      return value;
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

function safeFailureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: unknown }).response;
    if (typeof response === 'object' && response !== null) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{7,63}$/.test(code)) return code;
    }
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{7,63}$/.test(error.message)) {
    return error.message;
  }
  return 'CARE_ALUMNI_CLEANUP_FAILED';
}
