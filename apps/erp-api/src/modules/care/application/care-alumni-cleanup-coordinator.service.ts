import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { z } from 'zod';
import type { Connection, Model } from 'mongoose';

import { MetricsService } from '../../../core/observability/metrics.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OutboxRecord, type OutboxDocument } from '../../org/persistence/outbox.schema.js';
import { CareExecutionQueueService } from '../care-execution-queue.service.js';
import {
  alumniCleanupTaskEvent,
  createAlumniCleanupTask,
  type AlumniCleanupTask,
  type AlumniCleanupTerminationReason,
} from '../domain/index.js';
import { CareAlumniCleanupTargetRegistry } from '../integration/care-alumni-cleanup-target-registry.js';
import { CareOutboxWriter } from '../persistence/care-outbox.writer.js';
import {
  CareAlumniCleanupTaskRecord,
  type CareAlumniCleanupTaskDocument,
} from '../persistence/care.schemas.js';
import { CareAlumniConsentRepository } from '../persistence/care.repositories.js';

const TERMINATION_EVENTS: Readonly<Record<string, AlumniCleanupTerminationReason>> =
  Object.freeze({
  'cn.gaoq.erp.care.alumni_consent.withdrawn.v1': 'withdrawn',
  'cn.gaoq.erp.care.alumni_consent.expired.v1': 'expired',
});
const eventDataSchema = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  aggregateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  version: z.number().int().min(2),
  careCaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  purpose: z.enum(['alumni_network', 'rehire_contact', 'alumni_events']),
  channels: z.array(z.enum(['email', 'sms', 'phone', 'wechat'])).min(1).max(4),
  status: z.enum(['withdrawn', 'expired']),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();
const envelopeSchema = z.object({
  specversion: z.literal('1.0'),
  id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  source: z.literal('//gaoq-erp/care-module'),
  type: z.enum([
    'cn.gaoq.erp.care.alumni_consent.withdrawn.v1',
    'cn.gaoq.erp.care.alumni_consent.expired.v1',
  ]),
  subject: z.string().min(1).max(512),
  time: z.iso.datetime({ offset: true }),
  datacontenttype: z.literal('application/json'),
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  traceId: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(512),
  schemaVersion: z.literal('1'),
  data: eventDataSchema,
}).strict();
const LOCK_TIMEOUT_MS = 5 * 60_000;
const MAX_RELAY_ATTEMPTS = 6;

interface ClaimedConsentEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly consentId: string;
  readonly consentVersion: number;
  readonly consentPurpose: 'alumni_network' | 'rehire_contact' | 'alumni_events';
  readonly terminationReason: AlumniCleanupTerminationReason;
  readonly terminatedAt: string;
  readonly attempts: number;
}

/** 从授权终止 Outbox 原子扇出清理任务，并用空载荷对账恢复 DB→Queue 窗口。 */
@Injectable()
export class CareAlumniCleanupCoordinatorService {
  private readonly logger = new Logger(CareAlumniCleanupCoordinatorService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OutboxRecord.name) private readonly outbox: Model<OutboxDocument>,
    @InjectModel(CareAlumniCleanupTaskRecord.name)
    private readonly tasks: Model<CareAlumniCleanupTaskDocument>,
    private readonly context: TenantContextService,
    private readonly consents: CareAlumniConsentRepository,
    private readonly targets: CareAlumniCleanupTargetRegistry,
    private readonly outboxWriter: CareOutboxWriter,
    private readonly queue: CareExecutionQueueService,
    private readonly metrics: MetricsService,
  ) {}

  async relayBatch(workerId: string, limit = 50): Promise<number> {
    assertWorker(workerId, limit);
    let relayed = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claimNext(workerId, new Date());
      if (event === null) break;
      try {
        const tasks = await this.fanOut(event, workerId);
        await this.enqueue(tasks);
        this.metrics.recordCareAlumniCleanup('relay', 'success');
        relayed += 1;
      } catch (error: unknown) {
        this.logger.warn({
          code: safeErrorCode(error, 'CARE_ALUMNI_CLEANUP_RELAY_FAILED'),
          eventId: event.eventId,
        });
        await this.releaseEvent(event, workerId, new Date());
        this.metrics.recordCareAlumniCleanup('relay', 'retry');
      }
    }
    await this.refreshBacklogMetrics();
    return relayed;
  }

  async reconcileAndEnqueue(limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('CARE_ALUMNI_CLEANUP_RECONCILE_LIMIT_INVALID');
    }
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 15 * 60_000);
    const candidates = await this.tasks.find({
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'dispatching', lockedAt: { $lte: staleBefore } },
      ],
    }).sort({ nextAttemptAt: 1, tenantId: 1, id: 1 }).limit(limit).lean().exec();
    let scheduled = 0;
    for (const candidate of candidates) {
      let task = toDomain(candidate);
      if (task.status === 'dispatching') {
        const recovered = await this.tasks.findOneAndUpdate(
          {
            tenantId: task.tenantId,
            id: task.id,
            version: task.version,
            status: 'dispatching',
            lockedAt: { $lte: staleBefore },
          },
          {
            $set: {
              status: 'pending',
              lockedAt: null,
              lockedBy: null,
              nextAttemptAt: now,
              updatedAt: now,
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', timestamps: false, runValidators: true },
        ).lean().exec();
        if (recovered === null) continue;
        task = toDomain(recovered);
      }
      try {
        await this.runForTenant(task.tenantId, `reconcile:${task.id}`, () =>
          this.queue.scheduleAlumniCleanup(task));
        scheduled += 1;
      } catch (error: unknown) {
        this.logger.warn({
          code: safeErrorCode(error, 'CARE_ALUMNI_CLEANUP_ENQUEUE_FAILED'),
          cleanupTaskId: task.id,
        });
      }
    }
    this.metrics.recordCareAlumniCleanup(
      'reconcile',
      scheduled === candidates.length ? 'success' : 'retry',
    );
    await this.refreshBacklogMetrics();
    return scheduled;
  }

  private async claimNext(
    workerId: string,
    now: Date,
  ): Promise<ClaimedConsentEvent | null> {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const event = await this.outbox.findOneAndUpdate(
      {
        eventType: { $in: Object.keys(TERMINATION_EVENTS) },
        nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          { status: 'dispatching', lockedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: 'dispatching', lockedAt: now, lockedBy: workerId } },
      { sort: { createdAt: 1, eventId: 1 }, returnDocument: 'after' },
    ).lean().exec();
    if (event === null) return null;
    const envelope = envelopeSchema.parse(event.envelope);
    const terminationReason = TERMINATION_EVENTS[envelope.type];
    if (
      terminationReason === undefined ||
      envelope.id !== event.eventId ||
      envelope.tenantId !== event.tenantId ||
      envelope.type !== event.eventType ||
      envelope.data.tenantId !== event.tenantId ||
      envelope.data.aggregateId !== event.aggregateId ||
      envelope.data.version !== event.aggregateVersion ||
      envelope.data.status !== terminationReason ||
      envelope.subject !== `tenant/${event.tenantId}/care/${event.aggregateId}`
    ) throw new Error('CARE_ALUMNI_CLEANUP_SOURCE_EVENT_MISMATCH');
    return Object.freeze({
      eventId: event.eventId,
      tenantId: event.tenantId,
      consentId: event.aggregateId,
      consentVersion: event.aggregateVersion,
      consentPurpose: envelope.data.purpose,
      terminationReason,
      terminatedAt: new Date(envelope.time).toISOString(),
      attempts: event.attempts,
    });
  }

  private async fanOut(
    event: ClaimedConsentEvent,
    workerId: string,
  ): Promise<readonly AlumniCleanupTask[]> {
    const targets = this.targets.targets();
    if (targets.length === 0) throw new Error('CARE_ALUMNI_CLEANUP_TARGETS_REQUIRED');
    return this.runForTenant(event.tenantId, `relay:${event.eventId}`, async () => {
      const consent = await this.consents.findById(event.consentId);
      const terminatedAt = event.terminationReason === 'withdrawn'
        ? consent?.withdrawnAt
        : consent?.expiredAt;
      if (
        consent === null ||
        consent.version !== event.consentVersion ||
        consent.status !== event.terminationReason ||
        consent.purpose !== event.consentPurpose ||
        terminatedAt !== event.terminatedAt
      ) throw new Error('CARE_ALUMNI_CLEANUP_SOURCE_STATE_MISMATCH');
      const session = await this.connection.startSession();
      const created: AlumniCleanupTask[] = [];
      try {
        await session.withTransaction(async () => {
          for (const target of targets) {
            const task = createAlumniCleanupTask({ ...event, sourceEventId: event.eventId, target });
            const result = await this.tasks.updateOne(
              {
                tenantId: task.tenantId,
                consentId: task.consentId,
                consentVersion: task.consentVersion,
                consentPurpose: task.consentPurpose,
                targetCode: task.targetCode,
                policyVersion: task.policyVersion,
              },
              { $setOnInsert: toRecord(task) },
              {
                upsert: true,
                session,
                timestamps: false,
                runValidators: true,
                setDefaultsOnInsert: true,
              },
            );
            if (result.upsertedCount === 1) {
              await this.outboxWriter.append(
                alumniCleanupTaskEvent(task, 'care.alumni_cleanup.scheduled'),
                session,
              );
              created.push(task);
            } else {
              const existing = await this.tasks.findOne({
                tenantId: task.tenantId,
                id: task.id,
              }).session(session).lean().exec();
              if (
                existing === null ||
                existing.controlDigest !== task.controlDigest ||
                existing.policyVersion !== task.policyVersion
              ) throw new Error('CARE_ALUMNI_CLEANUP_TASK_CONTEXT_MISMATCH');
              if (existing.status === 'pending') created.push(toDomain(existing));
            }
          }
          const updated = await this.outbox.updateOne(
            {
              eventId: event.eventId,
              status: 'dispatching',
              lockedBy: workerId,
            },
            { $set: {
              status: 'dispatched',
              dispatchedAt: new Date(),
              lockedAt: null,
              lockedBy: null,
              lastErrorCode: null,
            } },
            { session, timestamps: false },
          );
          if (updated.matchedCount !== 1) {
            throw new Error('CARE_ALUMNI_CLEANUP_SOURCE_CLAIM_LOST');
          }
        });
      } finally {
        await session.endSession();
      }
      return Object.freeze(created);
    });
  }

  private async enqueue(tasks: readonly AlumniCleanupTask[]): Promise<void> {
    for (const task of tasks) {
      try {
        await this.runForTenant(task.tenantId, `enqueue:${task.id}`, () =>
          this.queue.scheduleAlumniCleanup(task));
      } catch (error: unknown) {
        this.logger.warn({
          code: safeErrorCode(error, 'CARE_ALUMNI_CLEANUP_ENQUEUE_FAILED'),
          cleanupTaskId: task.id,
        });
      }
    }
  }

  private async releaseEvent(
    event: ClaimedConsentEvent,
    workerId: string,
    now: Date,
  ): Promise<void> {
    const attempts = event.attempts + 1;
    const dead = attempts >= MAX_RELAY_ATTEMPTS;
    const delay = Math.min(6 * 60 * 60_000, 60_000 * (2 ** Math.min(attempts - 1, 8)));
    await this.outbox.updateOne(
      {
        eventId: event.eventId,
        status: 'dispatching',
        lockedBy: workerId,
      },
      { $set: {
        status: dead ? 'dead' : 'pending',
        attempts,
        nextAttemptAt: dead ? now : new Date(now.getTime() + delay),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: 'CARE_ALUMNI_CLEANUP_RELAY_FAILED',
      } },
      { timestamps: false },
    );
  }

  private async refreshBacklogMetrics(): Promise<void> {
    const now = Date.now();
    const values = await this.tasks.aggregate<{
      _id: 'pending' | 'dispatching' | 'dead';
      count: number;
      oldestAt: Date;
    }>([
      { $match: { status: { $in: ['pending', 'dispatching', 'dead'] } } },
      { $group: { _id: '$status', count: { $sum: 1 }, oldestAt: { $min: '$createdAt' } } },
    ]).exec();
    const byStatus = new Map(values.map((value) => [value._id, value]));
    for (const status of ['pending', 'dispatching', 'dead'] as const) {
      const value = byStatus.get(status);
      this.metrics.setCareAlumniCleanupBacklog(
        status,
        value?.count ?? 0,
        value === undefined ? 0 : Math.max(0, (now - value.oldestAt.getTime()) / 1_000),
      );
    }
  }

  private async runForTenant<T>(
    tenantId: string,
    traceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.context.run({
      tenant: { tenantId, source: 'service_identity' },
      actor: {
        actorId: 'system:care-alumni-cleanup-coordinator',
        actorType: 'system_job',
        tenantId,
        roleCodes: ['CARE_ALUMNI_CLEANUP_COORDINATOR'],
        scopes: ['erp:care:alumni:cleanup:relay'],
        departmentIds: [],
        traceId,
      },
    }, operation);
  }
}

function toRecord(task: AlumniCleanupTask): Record<string, unknown> {
  return {
    ...task,
    terminatedAt: new Date(task.terminatedAt),
    nextAttemptAt: new Date(task.nextAttemptAt),
    lockedAt: null,
    proofCompletedAt: null,
    proofRetentionUntil: null,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  };
}

function toDomain(value: CareAlumniCleanupTaskRecord): AlumniCleanupTask {
  return Object.freeze({
    ...value,
    terminatedAt: value.terminatedAt.toISOString(),
    nextAttemptAt: value.nextAttemptAt.toISOString(),
    lockedAt: value.lockedAt?.toISOString() ?? null,
    proofCompletedAt: value.proofCompletedAt?.toISOString() ?? null,
    proofRetentionUntil: value.proofRetentionUntil?.toISOString() ?? null,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  });
}

function assertWorker(workerId: string, limit: number): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId)) {
    throw new Error('CARE_ALUMNI_CLEANUP_WORKER_INVALID');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('CARE_ALUMNI_CLEANUP_RELAY_LIMIT_INVALID');
  }
}

function safeErrorCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{7,63}$/.test(error.message)
    ? error.message
    : fallback;
}
