import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { calculateNextAttemptAt, ORG_DELIVERY_MAX_ATTEMPTS } from './org-delivery.policy.js';
import {
  OrgDeliveryRecord,
  type OrgDeliveryAggregateType,
  type OrgDeliveryChannel,
  type OrgDeliveryDocument,
  OrgExternalVersionState,
  type OrgExternalVersionStateDocument,
} from './org-delivery.schemas.js';
import { OrgExternalIdentityResolver } from './org-external-identity.resolver.js';
import {
  OrgPushAdapterRegistry,
  OrgPushError,
  type OrgPushResult,
} from './org-push.adapter.js';

const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_:-]{1,128}$/;

const cloudEventSchema = z.object({
  idempotencyKey: z.string().min(1).max(512),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

const departmentDataSchema = z.object({
  tenantId: z.string().min(1),
  aggregateId: z.string().min(1),
  version: z.number().int().positive(),
  code: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['active', 'inactive']),
  parentId: z.string().nullable(),
  managerId: z.string().nullable(),
  sortOrder: z.number().int().nonnegative(),
}).strict();

const employeeDataSchema = z.object({
  tenantId: z.string().min(1),
  aggregateId: z.string().min(1),
  version: z.number().int().positive(),
  employeeNo: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(['probation', 'active', 'suspended', 'terminated']),
  departmentIds: z.array(z.string().min(1)),
  primaryDepartmentId: z.string().min(1),
  positionIds: z.array(z.string().min(1)),
  jobLevelId: z.string().nullable(),
}).strict();

const employeeStatusDataSchema = z.object({
  tenantId: z.string().min(1),
  aggregateId: z.string().min(1),
  version: z.number().int().positive(),
  fromStatus: z.enum(['probation', 'active', 'suspended', 'terminated']),
  toStatus: z.enum(['probation', 'active', 'suspended', 'terminated']),
}).strict();

interface ClaimedDelivery {
  readonly eventId: string;
  readonly tenantId: string;
  readonly channel: OrgDeliveryChannel;
  readonly aggregateType: OrgDeliveryAggregateType;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly envelope: Record<string, unknown>;
  readonly attempts: number;
}

interface VersionStateView {
  readonly appliedVersion: number;
  readonly externalId: string | null;
}

/** 执行单渠道组织下发，原子租约保证同一聚合严格按版本顺序。 */
@Injectable()
export class OrgDeliveryService {
  constructor(
    @InjectModel(OrgDeliveryRecord.name)
    private readonly deliveries: Model<OrgDeliveryDocument>,
    @InjectModel(OrgExternalVersionState.name)
    private readonly versions: Model<OrgExternalVersionStateDocument>,
    private readonly adapters: OrgPushAdapterRegistry,
    private readonly identities: OrgExternalIdentityResolver,
  ) {}

  async processBatch(
    channel: OrgDeliveryChannel,
    workerId: string,
    limit = 25,
  ): Promise<number> {
    this.assertWorker(workerId, limit);
    let succeeded = 0;
    for (let index = 0; index < limit; index += 1) {
      const delivery = await this.claimNext(channel, workerId, new Date());
      if (delivery === null) break;
      try {
        if (await this.hasEarlierUnfinished(delivery)) {
          await this.releaseBusy(delivery, workerId, new Date());
          continue;
        }
        const reservation = await this.reserveVersion(delivery, workerId, new Date());
        if (reservation === 'busy') {
          await this.releaseBusy(delivery, workerId, new Date());
          continue;
        }
        if (reservation.kind === 'already_applied') {
          await this.markSucceeded(delivery, workerId, reservation.externalId, new Date());
          succeeded += 1;
          continue;
        }
        const currentExternalId = reservation.externalId ?? (
          delivery.aggregateType === 'org.employee'
            ? await this.identities.findBoundExternalUserId(
                delivery.tenantId,
                delivery.channel,
                delivery.aggregateId,
              )
            : null
        );
        const result = await this.push(delivery, currentExternalId);
        await this.commitVersion(delivery, workerId, result, new Date());
        await this.markSucceeded(delivery, workerId, result.externalId, new Date());
        succeeded += 1;
      } catch (error) {
        await this.releaseVersion(delivery, workerId);
        if (this.isDependencyPending(error)) {
          await this.markDependencyPending(delivery, workerId, error.code, new Date());
        } else {
          await this.markFailed(delivery, workerId, error, new Date());
        }
      }
    }
    return succeeded;
  }

  private async claimNext(
    channel: OrgDeliveryChannel,
    workerId: string,
    now: Date,
  ): Promise<ClaimedDelivery | null> {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const record = await this.deliveries.findOneAndUpdate(
      {
        channel,
        nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          { status: 'processing', lockedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: 'processing', lockedAt: now, lockedBy: workerId } },
      { sort: { aggregateType: 1, aggregateVersion: 1, createdAt: 1 }, returnDocument: 'after' },
    ).lean().exec();
    if (record === null) return null;
    return {
      eventId: record.eventId,
      tenantId: record.tenantId,
      channel: record.channel,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      aggregateVersion: record.aggregateVersion,
      eventType: record.eventType,
      envelope: structuredClone(record.envelope),
      attempts: record.attempts,
    };
  }

  private async hasEarlierUnfinished(delivery: ClaimedDelivery): Promise<boolean> {
    const result = await this.deliveries.exists({
      tenantId: delivery.tenantId,
      channel: delivery.channel,
      aggregateType: delivery.aggregateType,
      aggregateId: delivery.aggregateId,
      aggregateVersion: { $lt: delivery.aggregateVersion },
      status: { $in: ['pending', 'processing'] },
    });
    return result !== null;
  }

  private async reserveVersion(
    delivery: ClaimedDelivery,
    workerId: string,
    now: Date,
  ): Promise<(VersionStateView & { readonly kind: 'reserved' }) | {
    readonly kind: 'already_applied';
    readonly externalId: string | null;
  } | 'busy'> {
    const key = this.versionKey(delivery);
    try {
      await this.versions.updateOne(
        key,
        {
          $setOnInsert: {
            ...key,
            appliedVersion: 0,
            externalId: null,
            lastEventId: null,
            processingVersion: null,
            processingEventId: null,
            lockedAt: null,
            lockedBy: null,
          },
        },
        { upsert: true, timestamps: false },
      );
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
    }
    const current = await this.versions.findOne(key).lean().exec();
    if (current !== null && current.appliedVersion >= delivery.aggregateVersion) {
      return { kind: 'already_applied', externalId: current.externalId };
    }
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const reserved = await this.versions.findOneAndUpdate(
      {
        ...key,
        appliedVersion: { $lt: delivery.aggregateVersion },
        $or: [
          { processingVersion: null },
          { lockedAt: { $lt: staleBefore } },
        ],
      },
      {
        $set: {
          processingVersion: delivery.aggregateVersion,
          processingEventId: delivery.eventId,
          lockedAt: now,
          lockedBy: workerId,
        },
      },
      { returnDocument: 'after' },
    ).lean().exec();
    if (reserved === null) return 'busy';
    return {
      kind: 'reserved',
      appliedVersion: reserved.appliedVersion,
      externalId: reserved.externalId,
    };
  }

  private async push(
    delivery: ClaimedDelivery,
    currentExternalId: string | null,
  ): Promise<OrgPushResult> {
    const envelope = cloudEventSchema.parse(delivery.envelope);
    const adapter = this.adapters.get(delivery.channel);
    if (delivery.aggregateType === 'org.department') {
      const data = departmentDataSchema.parse(envelope.data);
      this.assertEnvelopeIdentity(delivery, data.tenantId, data.aggregateId, data.version);
      const parentExternalId = data.parentId === null
        ? null
        : await this.requireExternalId(delivery, 'org.department', data.parentId);
      const managerExternalId = data.managerId === null
        ? null
        : await this.findExternalId(delivery, 'org.employee', data.managerId);
      return adapter.pushDepartment({
        tenantId: delivery.tenantId,
        departmentId: delivery.aggregateId,
        version: delivery.aggregateVersion,
        code: data.code,
        name: data.name,
        status: data.status,
        parentExternalId,
        managerExternalId,
        sortOrder: data.sortOrder,
        currentExternalId,
        idempotencyKey: envelope.idempotencyKey,
      });
    }
    if (delivery.eventType.includes('employee.status_changed')) {
      const data = employeeStatusDataSchema.parse(envelope.data);
      this.assertEnvelopeIdentity(delivery, data.tenantId, data.aggregateId, data.version);
      if (currentExternalId === null) {
        throw new OrgPushError('ORG_EXTERNAL_MAPPING_MISSING', 'retryable', '员工外部映射尚未就绪');
      }
      return adapter.changeEmployeeStatus({
        tenantId: delivery.tenantId,
        employeeId: delivery.aggregateId,
        externalId: currentExternalId,
        version: delivery.aggregateVersion,
        status: data.toStatus,
        idempotencyKey: envelope.idempotencyKey,
      });
    }
    const data = employeeDataSchema.parse(envelope.data);
    this.assertEnvelopeIdentity(delivery, data.tenantId, data.aggregateId, data.version);
    const departmentExternalIds: string[] = [];
    for (const departmentId of data.departmentIds) {
      departmentExternalIds.push(
        await this.requireExternalId(delivery, 'org.department', departmentId),
      );
    }
    const primaryDepartmentExternalId = await this.requireExternalId(
      delivery,
      'org.department',
      data.primaryDepartmentId,
    );
    return adapter.pushEmployee({
      tenantId: delivery.tenantId,
      employeeId: delivery.aggregateId,
      version: delivery.aggregateVersion,
      employeeNo: data.employeeNo,
      displayName: data.displayName,
      status: data.status,
      departmentExternalIds,
      primaryDepartmentExternalId,
      currentExternalId,
      idempotencyKey: envelope.idempotencyKey,
    });
  }

  private async requireExternalId(
    delivery: ClaimedDelivery,
    aggregateType: OrgDeliveryAggregateType,
    aggregateId: string,
  ): Promise<string> {
    const externalId = await this.findExternalId(delivery, aggregateType, aggregateId);
    if (externalId === null) {
      throw new OrgPushError('ORG_DEPENDENCY_NOT_READY', 'retryable', '外部依赖映射尚未就绪');
    }
    return externalId;
  }

  private async findExternalId(
    delivery: ClaimedDelivery,
    aggregateType: OrgDeliveryAggregateType,
    aggregateId: string,
  ): Promise<string | null> {
    const state = await this.versions.findOne({
      tenantId: delivery.tenantId,
      channel: delivery.channel,
      aggregateType,
      aggregateId,
      appliedVersion: { $gte: 1 },
      externalId: { $ne: null },
    }).lean().exec();
    return state?.externalId ?? null;
  }

  private async commitVersion(
    delivery: ClaimedDelivery,
    workerId: string,
    result: OrgPushResult,
    now: Date,
  ): Promise<void> {
    const updated = await this.versions.updateOne(
      {
        ...this.versionKey(delivery),
        processingVersion: delivery.aggregateVersion,
        processingEventId: delivery.eventId,
        lockedBy: workerId,
      },
      {
        $set: {
          appliedVersion: delivery.aggregateVersion,
          externalId: result.externalId,
          lastEventId: delivery.eventId,
          processingVersion: null,
          processingEventId: null,
          lockedAt: null,
          lockedBy: null,
          updatedAt: now,
        },
      },
      { timestamps: false },
    );
    if (updated.matchedCount !== 1) throw new Error('ORG_VERSION_LEASE_LOST');
  }

  private async releaseVersion(delivery: ClaimedDelivery, workerId: string): Promise<void> {
    await this.versions.updateOne(
      {
        ...this.versionKey(delivery),
        processingEventId: delivery.eventId,
        lockedBy: workerId,
      },
      {
        $set: {
          processingVersion: null,
          processingEventId: null,
          lockedAt: null,
          lockedBy: null,
        },
      },
      { timestamps: false },
    );
  }

  private async markSucceeded(
    delivery: ClaimedDelivery,
    workerId: string,
    externalId: string | null,
    now: Date,
  ): Promise<void> {
    await this.deliveries.updateOne(
      { eventId: delivery.eventId, channel: delivery.channel, status: 'processing', lockedBy: workerId },
      {
        $set: {
          status: 'succeeded',
          externalId,
          succeededAt: now,
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: null,
          lastErrorCategory: null,
        },
      },
      { timestamps: false },
    );
  }

  private async releaseBusy(
    delivery: ClaimedDelivery,
    workerId: string,
    now: Date,
  ): Promise<void> {
    await this.deliveries.updateOne(
      { eventId: delivery.eventId, channel: delivery.channel, status: 'processing', lockedBy: workerId },
      {
        $set: {
          status: 'pending',
          nextAttemptAt: new Date(now.getTime() + 1_000),
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: 'ORG_VERSION_BUSY',
          lastErrorCategory: 'retryable',
        },
      },
      { timestamps: false },
    );
  }

  private async markFailed(
    delivery: ClaimedDelivery,
    workerId: string,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const category = error instanceof OrgPushError
      ? error.category
      : error instanceof z.ZodError ? 'conflict' : 'retryable';
    const code = error instanceof OrgPushError && ERROR_CODE_PATTERN.test(error.code)
      ? error.code
      : error instanceof z.ZodError ? 'ORG_EVENT_INVALID' : 'ORG_PUSH_UNEXPECTED';
    const attempts = delivery.attempts + 1;
    const terminal = category !== 'retryable' || attempts >= ORG_DELIVERY_MAX_ATTEMPTS;
    await this.deliveries.updateOne(
      { eventId: delivery.eventId, channel: delivery.channel, status: 'processing', lockedBy: workerId },
      {
        $set: {
          status: terminal ? (category === 'retryable' ? 'dead' : 'manual_review') : 'pending',
          attempts,
          nextAttemptAt: terminal ? now : calculateNextAttemptAt(attempts, now),
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: code,
          lastErrorCategory: category,
        },
      },
      { timestamps: false },
    );
  }

  /** 跨聚合依赖未就绪不消耗业务重试预算，避免部门慢同步把员工任务提前打死。 */
  private async markDependencyPending(
    delivery: ClaimedDelivery,
    workerId: string,
    code: string,
    now: Date,
  ): Promise<void> {
    await this.deliveries.updateOne(
      { eventId: delivery.eventId, channel: delivery.channel, status: 'processing', lockedBy: workerId },
      { $set: {
        status: 'pending',
        nextAttemptAt: new Date(now.getTime() + 5_000),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: code,
        lastErrorCategory: 'retryable',
      } },
      { timestamps: false },
    );
  }

  private versionKey(delivery: ClaimedDelivery): Record<string, string> {
    return {
      tenantId: delivery.tenantId,
      channel: delivery.channel,
      aggregateType: delivery.aggregateType,
      aggregateId: delivery.aggregateId,
    };
  }

  private assertEnvelopeIdentity(
    delivery: ClaimedDelivery,
    tenantId: string,
    aggregateId: string,
    version: number,
  ): void {
    if (
      tenantId !== delivery.tenantId ||
      aggregateId !== delivery.aggregateId ||
      version !== delivery.aggregateVersion
    ) {
      throw new OrgPushError('ORG_EVENT_IDENTITY_MISMATCH', 'conflict', '组织事件身份不一致');
    }
  }

  private assertWorker(workerId: string, limit: number): void {
    if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('delivery workerId 非法');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('delivery batch limit 必须为 1..100 的整数');
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
  }

  private isDependencyPending(error: unknown): error is OrgPushError {
    return error instanceof OrgPushError && (
      error.code === 'ORG_DEPENDENCY_NOT_READY' ||
      error.code === 'ORG_EXTERNAL_MAPPING_MISSING'
    );
  }
}
