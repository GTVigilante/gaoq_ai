import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { elapsedSeconds, MetricsService } from '../../core/observability/metrics.service.js';
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
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_:-]{1,128}$/;
const INDETERMINATE_ERROR_CODES = new Set([
  'ORG_PLATFORM_NETWORK_ERROR',
  'ORG_PLATFORM_RESPONSE_READ_ERROR',
  'ORG_PLATFORM_RESPONSE_TOO_LARGE',
  'ORG_PLATFORM_RESPONSE_INVALID',
  'DINGTALK_RESPONSE_INVALID',
  'DINGTALK_DEPARTMENT_ID_MISSING',
  'FEISHU_RESPONSE_INVALID',
  'FEISHU_DEPARTMENT_ID_MISSING',
  'OP_ORG_NETWORK_ERROR',
  'OP_ORG_RESPONSE_READ_ERROR',
  'OP_ORG_RESPONSE_TOO_LARGE',
  'OP_ORG_RESPONSE_INVALID',
]);

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

const claimedDeliverySchema = z.object({
  eventId: z.string().regex(ULID_PATTERN),
  tenantId: z.string().regex(ID_PATTERN),
  channel: z.enum(['dingtalk', 'feishu', 'op']),
  aggregateType: z.enum(['org.department', 'org.employee']),
  aggregateId: z.string().regex(ID_PATTERN),
  aggregateVersion: z.number().int().positive().safe(),
  eventType: z.enum([
    'cn.gaoq.erp.department.created.v1',
    'cn.gaoq.erp.department.updated.v1',
    'cn.gaoq.erp.employee.created.v1',
    'cn.gaoq.erp.employee.updated.v1',
    'cn.gaoq.erp.employee.status_changed.v1',
  ]),
  envelope: z.record(z.string(), z.unknown()),
  attempts: z.number().int().min(0).max(ORG_DELIVERY_MAX_ATTEMPTS - 1).safe(),
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

type OrgDeliveryOutcome =
  | 'succeeded'
  | 'retry'
  | 'dead'
  | 'manual_review'
  | 'busy'
  | 'state_unavailable';

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
    private readonly metrics: MetricsService,
  ) {}

  async processBatch(
    channel: OrgDeliveryChannel,
    workerId: string,
    limit = 25,
  ): Promise<number> {
    this.assertWorker(workerId, limit);
    let succeeded = 0;
    for (let index = 0; index < limit; index += 1) {
      const now = new Date();
      const recovered = await this.recoverStale(channel, workerId, now);
      if (recovered !== 'none') {
        if (recovered === 'succeeded') succeeded += 1;
        continue;
      }
      const delivery = await this.claimNext(channel, workerId, now);
      if (delivery === null) break;
      const startedAt = process.hrtime.bigint();
      let reserved = false;
      let platformAccepted = false;
      let versionApplied = false;
      try {
        this.assertClaimedDelivery(delivery, channel);
        if (await this.hasEarlierUnfinished(delivery)) {
          await this.releaseBusy(delivery, workerId, new Date());
          this.recordOutcome(channel, 'busy', startedAt);
          continue;
        }
        const reservation = await this.reserveVersion(delivery, workerId, new Date());
        if (reservation === 'busy') {
          await this.releaseBusy(delivery, workerId, new Date());
          this.recordOutcome(channel, 'busy', startedAt);
          continue;
        }
        if (reservation.kind === 'already_applied') {
          versionApplied = true;
          await this.markSucceeded(delivery, workerId, reservation.externalId, new Date());
          succeeded += 1;
          this.recordOutcome(channel, 'succeeded', startedAt);
          continue;
        }
        reserved = true;
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
        platformAccepted = true;
        await this.commitVersion(delivery, workerId, result, new Date());
        versionApplied = true;
        await this.markSucceeded(delivery, workerId, result.externalId, new Date());
        succeeded += 1;
        this.recordOutcome(channel, 'succeeded', startedAt);
      } catch (error) {
        if (platformAccepted || versionApplied) {
          this.recordOutcome(channel, 'state_unavailable', startedAt);
          throw new Error('ORG_DELIVERY_STATE_UNAVAILABLE', { cause: error });
        }
        if (reserved) await this.releaseVersion(delivery, workerId);
        if (this.isIndeterminatePlatformError(error)) {
          await this.markIndeterminate(delivery, workerId, new Date());
          this.recordOutcome(channel, 'manual_review', startedAt);
          continue;
        }
        if (this.isDependencyPending(error)) {
          await this.markDependencyPending(delivery, workerId, error.code, new Date());
          this.recordOutcome(channel, 'retry', startedAt);
          continue;
        }
        const outcome = await this.markFailed(delivery, workerId, error, new Date());
        this.recordOutcome(channel, outcome, startedAt);
      }
    }
    return succeeded;
  }

  private async claimNext(
    channel: OrgDeliveryChannel,
    workerId: string,
    now: Date,
  ): Promise<ClaimedDelivery | null> {
    const record = await this.deliveries.findOneAndUpdate(
      {
        channel,
        nextAttemptAt: { $lte: now },
        status: 'pending',
      },
      { $set: { status: 'processing', lockedAt: now, lockedBy: workerId } },
      {
        sort: { aggregateType: 1, aggregateVersion: 1, createdAt: 1 },
        returnDocument: 'after',
        runValidators: true,
      },
    ).lean().exec().catch(() => {
      throw new Error('ORG_DELIVERY_STORE_UNAVAILABLE');
    });
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

  /**
   * 过期 processing 可能停在平台已受理、本地未提交的窗口，禁止自动重放。
   * 若版本状态已经提交则只补写成功；否则隔离到人工核验。
   */
  private async recoverStale(
    channel: OrgDeliveryChannel,
    workerId: string,
    now: Date,
  ): Promise<'none' | 'succeeded' | 'quarantined'> {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const record = await this.deliveries.findOneAndUpdate(
      { channel, status: 'processing', lockedAt: { $lt: staleBefore } },
      { $set: { lockedAt: now, lockedBy: workerId } },
      { sort: { lockedAt: 1, createdAt: 1 }, returnDocument: 'after', runValidators: true },
    ).lean().exec().catch(() => {
      throw new Error('ORG_DELIVERY_STORE_UNAVAILABLE');
    });
    if (record === null) return 'none';
    const delivery: ClaimedDelivery = {
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
    const startedAt = process.hrtime.bigint();
    try {
      this.assertClaimedDelivery(delivery, channel);
      const version = await this.versions.findOne(this.versionKey(delivery)).lean().exec();
      if (version !== null && version.appliedVersion >= delivery.aggregateVersion) {
        await this.markSucceeded(delivery, workerId, version.externalId, new Date());
        this.recordOutcome(channel, 'succeeded', startedAt);
        return 'succeeded';
      }
      await this.releaseVersionIfOwned(delivery, workerId);
      await this.markIndeterminate(delivery, workerId, new Date());
      this.recordOutcome(channel, 'manual_review', startedAt);
      return 'quarantined';
    } catch (error) {
      if (error instanceof OrgPushError && error.code === 'ORG_DELIVERY_RECORD_INVALID') {
        await this.releaseVersionIfOwned(delivery, workerId);
        await this.markIndeterminate(delivery, workerId, new Date(), error.code);
        this.recordOutcome(channel, 'manual_review', startedAt);
        return 'quarantined';
      }
      this.recordOutcome(channel, 'state_unavailable', startedAt);
      throw new Error('ORG_DELIVERY_STATE_UNAVAILABLE', { cause: error });
    }
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
    let result: { readonly matchedCount: number };
    try {
      result = await this.versions.updateOne(
        {
          ...this.versionKey(delivery),
          processingVersion: delivery.aggregateVersion,
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
        { timestamps: false, runValidators: true },
      );
    } catch {
      throw new Error('ORG_DELIVERY_STORE_UNAVAILABLE');
    }
    if (result.matchedCount !== 1) throw new Error('ORG_VERSION_RELEASE_LEASE_LOST');
  }

  /** 恢复流程允许版本租约已经提交或被清理；仅在仍归当前 Worker 时释放。 */
  private async releaseVersionIfOwned(
    delivery: ClaimedDelivery,
    workerId: string,
  ): Promise<void> {
    try {
      await this.versions.updateOne(
        {
          ...this.versionKey(delivery),
          processingVersion: delivery.aggregateVersion,
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
        { timestamps: false, runValidators: true },
      );
    } catch {
      throw new Error('ORG_DELIVERY_STORE_UNAVAILABLE');
    }
  }

  private async markSucceeded(
    delivery: ClaimedDelivery,
    workerId: string,
    externalId: string | null,
    now: Date,
  ): Promise<void> {
    await this.writeDelivery(
      delivery,
      workerId,
      {
        status: 'succeeded',
        externalId,
        succeededAt: now,
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: null,
        lastErrorCategory: null,
      },
      'ORG_DELIVERY_SUCCESS_LEASE_LOST',
    );
  }

  private async releaseBusy(
    delivery: ClaimedDelivery,
    workerId: string,
    now: Date,
  ): Promise<void> {
    await this.writeDelivery(
      delivery,
      workerId,
      {
        status: 'pending',
        nextAttemptAt: new Date(now.getTime() + 1_000),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: 'ORG_VERSION_BUSY',
        lastErrorCategory: 'retryable',
      },
      'ORG_DELIVERY_RELEASE_LEASE_LOST',
    );
  }

  private async markFailed(
    delivery: ClaimedDelivery,
    workerId: string,
    error: unknown,
    now: Date,
  ): Promise<'retry' | 'dead' | 'manual_review'> {
    const category = error instanceof OrgPushError
      ? error.category
      : error instanceof z.ZodError ? 'conflict' : 'retryable';
    const code = error instanceof OrgPushError && ERROR_CODE_PATTERN.test(error.code)
      ? error.code
      : error instanceof z.ZodError ? 'ORG_EVENT_INVALID' : 'ORG_PUSH_UNEXPECTED';
    const attempts = Number.isSafeInteger(delivery.attempts) && delivery.attempts >= 0
      ? Math.min(delivery.attempts + 1, ORG_DELIVERY_MAX_ATTEMPTS)
      : ORG_DELIVERY_MAX_ATTEMPTS;
    const terminal = category !== 'retryable' || attempts >= ORG_DELIVERY_MAX_ATTEMPTS;
    const status = terminal ? (category === 'retryable' ? 'dead' : 'manual_review') : 'pending';
    await this.writeDelivery(
      delivery,
      workerId,
      {
        status,
        attempts,
        nextAttemptAt: terminal ? now : calculateNextAttemptAt(attempts, now),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: code,
        lastErrorCategory: category,
      },
      'ORG_DELIVERY_RELEASE_LEASE_LOST',
    );
    return status === 'pending' ? 'retry' : status;
  }

  /** 跨聚合依赖未就绪不消耗业务重试预算，避免部门慢同步把员工任务提前打死。 */
  private async markDependencyPending(
    delivery: ClaimedDelivery,
    workerId: string,
    code: string,
    now: Date,
  ): Promise<void> {
    await this.writeDelivery(
      delivery,
      workerId,
      {
        status: 'pending',
        nextAttemptAt: new Date(now.getTime() + 5_000),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: code,
        lastErrorCategory: 'retryable',
      },
      'ORG_DELIVERY_RELEASE_LEASE_LOST',
    );
  }

  private async markIndeterminate(
    delivery: ClaimedDelivery,
    workerId: string,
    now: Date,
    code = 'ORG_DELIVERY_RESULT_INDETERMINATE',
  ): Promise<void> {
    await this.writeDelivery(
      delivery,
      workerId,
      {
        status: 'manual_review',
        nextAttemptAt: now,
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: code,
        lastErrorCategory: 'conflict',
      },
      'ORG_DELIVERY_RELEASE_LEASE_LOST',
    );
  }

  private async writeDelivery(
    delivery: ClaimedDelivery,
    workerId: string,
    values: Readonly<Record<string, unknown>>,
    leaseErrorCode: string,
  ): Promise<void> {
    let result: { readonly matchedCount: number };
    try {
      result = await this.deliveries.updateOne(
        {
          eventId: delivery.eventId,
          channel: delivery.channel,
          aggregateVersion: delivery.aggregateVersion,
          status: 'processing',
          lockedBy: workerId,
          attempts: delivery.attempts,
        },
        { $set: values },
        { timestamps: false, runValidators: true },
      );
    } catch {
      throw new Error('ORG_DELIVERY_STORE_UNAVAILABLE');
    }
    if (result.matchedCount !== 1) throw new Error(leaseErrorCode);
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

  private assertClaimedDelivery(
    delivery: ClaimedDelivery,
    expectedChannel: OrgDeliveryChannel,
  ): void {
    const parsed = claimedDeliverySchema.safeParse(delivery);
    const expectedAggregate = delivery.eventType.includes('.department.')
      ? 'org.department'
      : delivery.eventType.includes('.employee.')
        ? 'org.employee'
        : null;
    if (
      !parsed.success ||
      delivery.channel !== expectedChannel ||
      expectedAggregate !== delivery.aggregateType
    ) {
      throw new OrgPushError(
        'ORG_DELIVERY_RECORD_INVALID',
        'conflict',
        '组织投递记录无效',
      );
    }
  }

  private isIndeterminatePlatformError(error: unknown): boolean {
    return error instanceof OrgPushError && INDETERMINATE_ERROR_CODES.has(error.code);
  }

  private recordOutcome(
    channel: OrgDeliveryChannel,
    outcome: OrgDeliveryOutcome,
    startedAt: bigint,
  ): void {
    this.metrics.recordOrgDelivery(channel, outcome, elapsedSeconds(startedAt));
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
