import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type {
  AlumniConsent,
  CareCase,
  CareOccasionPreference,
  CareOccasionTask,
  CareTaskEvidence,
} from '../domain/index.js';
import {
  CareAlumniConsentRecord,
  type CareAlumniConsentDocument,
  CareCaseRecord,
  type CareCaseDocument,
  CareOccasionPreferenceRecord,
  type CareOccasionPreferenceDocument,
  CareOccasionTaskRecord,
  type CareOccasionTaskDocument,
  CareOccasionTenantRecord,
  type CareOccasionTenantDocument,
  CareTaskEvidenceRecord,
  type CareTaskEvidenceDocument,
} from './care.schemas.js';

export class CareWriteConflictError extends Error {
  constructor() {
    super('Care 聚合版本冲突');
    this.name = 'CareWriteConflictError';
  }
}

abstract class TenantRepository {
  constructor(protected readonly context: TenantContextService) {}
  protected tenantId(): string { return this.context.getTenantRequired().tenantId; }
  protected assertTenant(value: string): void {
    if (value !== this.tenantId()) throw new Error('Care 仓储拒绝跨租户实体');
  }
}

@Injectable()
export class CareCaseRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(CareCaseRecord.name) private readonly records: Model<CareCaseDocument>,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<CareCase | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : this.toDomain(value);
  }

  async findByEmploymentIds(employmentIds: readonly string[]): Promise<readonly CareCase[]> {
    if (employmentIds.length === 0) return [];
    const values = await this.records
      .find({ tenantId: this.tenantId(), employmentId: { $in: [...employmentIds] } })
      .sort({ createdAt: -1, id: 1 })
      .lean()
      .exec();
    return values.map((value) => this.toDomain(value));
  }

  async insert(careCase: CareCase, session: ClientSession): Promise<void> {
    this.assertTenant(careCase.tenantId);
    await this.records.create([{
      ...careCase, accessDisableAt: new Date(careCase.accessDisableAt),
      createdAt: new Date(careCase.createdAt), updatedAt: new Date(careCase.updatedAt),
    }], { session });
  }

  async replace(careCase: CareCase, expectedVersion: number, session: ClientSession): Promise<void> {
    this.assertTenant(careCase.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: careCase.id, version: expectedVersion },
      { $set: {
        status: careCase.status, approvalInstanceId: careCase.approvalInstanceId,
        handoverEvidenceId: careCase.handoverEvidenceId,
        assetsEvidenceId: careCase.assetsEvidenceId,
        financeEvidenceId: careCase.financeEvidenceId,
        retentionEvidenceId: careCase.retentionEvidenceId,
        executionEvidenceId: careCase.executionEvidenceId,
        orgTerminationEvidenceId: careCase.orgTerminationEvidenceId,
        version: careCase.version, updatedAt: new Date(careCase.updatedAt),
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1) throw new CareWriteConflictError();
  }

  private toDomain(value: CareCaseRecord): CareCase {
    return Object.freeze({
      id: value.id, tenantId: value.tenantId, employeeId: value.employeeId,
      employmentId: value.employmentId, separationType: value.separationType,
      reasonCode: value.reasonCode, lastWorkingDate: value.lastWorkingDate,
      tenantTimeZone: value.tenantTimeZone, accessDisableAt: value.accessDisableAt.toISOString(),
      status: value.status, approvalInstanceId: value.approvalInstanceId,
      handoverEvidenceId: value.handoverEvidenceId, assetsEvidenceId: value.assetsEvidenceId,
      financeEvidenceId: value.financeEvidenceId, retentionEvidenceId: value.retentionEvidenceId,
      executionEvidenceId: value.executionEvidenceId,
      orgTerminationEvidenceId: value.orgTerminationEvidenceId,
      version: value.version, createdAt: value.createdAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
    });
  }
}

@Injectable()
export class CareTaskEvidenceRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(CareTaskEvidenceRecord.name)
    private readonly records: Model<CareTaskEvidenceDocument>,
  ) { super(context); }

  async append(evidence: CareTaskEvidence, session: ClientSession): Promise<void> {
    this.assertTenant(evidence.tenantId);
    await this.records.create([{
      ...evidence, occurredAt: new Date(evidence.occurredAt),
    }], { session });
  }
}

@Injectable()
export class CareAlumniConsentRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(CareAlumniConsentRecord.name)
    private readonly records: Model<CareAlumniConsentDocument>,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<AlumniConsent | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : Object.freeze({
      id: value.id, tenantId: value.tenantId, personId: value.personId,
      careCaseId: value.careCaseId, purpose: value.purpose,
      channels: Object.freeze([...value.channels]), consentVersion: value.consentVersion,
      consentEvidenceId: value.consentEvidenceId,
      grantedAt: value.grantedAt.toISOString(), expiresAt: value.expiresAt.toISOString(),
      withdrawnAt: value.withdrawnAt?.toISOString() ?? null,
      expiredAt: value.expiredAt?.toISOString() ?? null, status: value.status,
      version: value.version,
    });
  }

  async findByCareCaseIds(careCaseIds: readonly string[]): Promise<readonly AlumniConsent[]> {
    if (careCaseIds.length === 0) return [];
    const values = await this.records
      .find({ tenantId: this.tenantId(), careCaseId: { $in: [...careCaseIds] } })
      .sort({ grantedAt: -1, id: 1 })
      .lean()
      .exec();
    return values.map((value) => Object.freeze({
      id: value.id, tenantId: value.tenantId, personId: value.personId,
      careCaseId: value.careCaseId, purpose: value.purpose,
      channels: Object.freeze([...value.channels]), consentVersion: value.consentVersion,
      consentEvidenceId: value.consentEvidenceId,
      grantedAt: value.grantedAt.toISOString(), expiresAt: value.expiresAt.toISOString(),
      withdrawnAt: value.withdrawnAt?.toISOString() ?? null,
      expiredAt: value.expiredAt?.toISOString() ?? null, status: value.status,
      version: value.version,
    }));
  }

  async insert(consent: AlumniConsent, session: ClientSession): Promise<void> {
    this.assertTenant(consent.tenantId);
    await this.records.create([{
      ...consent, channels: [...consent.channels], grantedAt: new Date(consent.grantedAt),
      expiresAt: new Date(consent.expiresAt), withdrawnAt: null, expiredAt: null,
    }], { session });
  }

  async replace(consent: AlumniConsent, expectedVersion: number, session: ClientSession): Promise<void> {
    this.assertTenant(consent.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: consent.id, version: expectedVersion },
      { $set: {
        status: consent.status,
        withdrawnAt: consent.withdrawnAt === null ? null : new Date(consent.withdrawnAt),
        expiredAt: consent.expiredAt === null ? null : new Date(consent.expiredAt),
        version: consent.version,
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1) throw new CareWriteConflictError();
  }
}

@Injectable()
export class CareOccasionPreferenceRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(CareOccasionPreferenceRecord.name)
    private readonly records: Model<CareOccasionPreferenceDocument>,
  ) { super(context); }

  async findByEmployeeId(
    employeeId: string,
    session?: ClientSession,
  ): Promise<CareOccasionPreference | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), employeeId });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : toOccasionPreference(value);
  }

  async findEnabled(
    afterEmployeeId: string | null,
    limit: number,
  ): Promise<readonly CareOccasionPreference[]> {
    const values = await this.records.find({
      tenantId: this.tenantId(),
      unsubscribed: false,
      $or: [{ birthdayEnabled: true }, { anniversaryEnabled: true }],
      ...(afterEmployeeId === null ? {} : { employeeId: { $gt: afterEmployeeId } }),
    }).sort({ employeeId: 1 }).limit(limit).lean().exec();
    return values.map((value) => toOccasionPreference(value));
  }

  async insert(
    preference: CareOccasionPreference,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(preference.tenantId);
    await this.records.create([{
      ...preference,
      preferredChannels: [...preference.preferredChannels],
      createdAt: new Date(preference.createdAt),
      updatedAt: new Date(preference.updatedAt),
    }], { session });
  }

  async replace(
    preference: CareOccasionPreference,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(preference.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), employeeId: preference.employeeId, version: expectedVersion },
      { $set: {
        currentEmploymentId: preference.currentEmploymentId,
        birthdayEnabled: preference.birthdayEnabled,
        anniversaryEnabled: preference.anniversaryEnabled,
        preferredChannels: [...preference.preferredChannels],
        unsubscribed: preference.unsubscribed,
        version: preference.version,
        updatedAt: new Date(preference.updatedAt),
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1) throw new CareWriteConflictError();
  }
}

@Injectable()
export class CareOccasionTaskRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(CareOccasionTaskRecord.name)
    private readonly records: Model<CareOccasionTaskDocument>,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<CareOccasionTask | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : toOccasionTask(value);
  }

  async findByEmployeeId(employeeId: string): Promise<readonly CareOccasionTask[]> {
    const values = await this.records.find({
      tenantId: this.tenantId(),
      employeeId,
    }).sort({ occurrenceYear: -1, occasionType: 1, id: 1 }).limit(20).lean().exec();
    return Object.freeze(values.map((value) => toOccasionTask(value)));
  }

  async upsertPlanned(
    task: CareOccasionTask,
    session: ClientSession,
  ): Promise<{
    readonly task: CareOccasionTask;
    readonly changed: boolean;
  }> {
    this.assertTenant(task.tenantId);
    const naturalKey = {
      tenantId: this.tenantId(),
      employeeId: task.employeeId,
      occasionType: task.occasionType,
      occurrenceYear: task.occurrenceYear,
    };
    const existing = await this.records.findOne(naturalKey).session(session).lean().exec();
    if (existing === null) {
      await this.records.create([toOccasionTaskRecord(task)], { session });
      return Object.freeze({ task, changed: true });
    }
    const reopenable =
      existing.status === 'cancelled' &&
      ['unsubscribed', 'purpose_restricted'].includes(existing.denialCode ?? '');
    if (existing.status !== 'pending' && !reopenable) {
      return Object.freeze({ task: toOccasionTask(existing), changed: false });
    }
    if (
      existing.status === 'pending' &&
      existing.policyVersion === task.policyVersion &&
      existing.sourceDigest === task.sourceDigest &&
      existing.scheduledAt.toISOString() === task.scheduledAt &&
      JSON.stringify(existing.preferredChannels) === JSON.stringify(task.preferredChannels)
    ) return Object.freeze({ task: toOccasionTask(existing), changed: false });
    const result = await this.records.findOneAndUpdate(
      { ...naturalKey, status: existing.status, version: existing.version },
      { $set: {
        employmentId: task.employmentId,
        scheduledAt: new Date(task.scheduledAt),
        templateCode: task.templateCode,
        policyVersion: task.policyVersion,
        preferredChannels: [...task.preferredChannels],
        sourceDigest: task.sourceDigest,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(task.scheduledAt),
        lockedAt: null,
        lockedBy: null,
        denialCode: null,
        deliveryEvidenceId: null,
        deliveredAt: null,
        updatedAt: new Date(task.updatedAt),
      }, $inc: { version: 1 } },
      { session, returnDocument: 'after', timestamps: false, runValidators: true },
    ).lean().exec();
    if (result === null) throw new CareWriteConflictError();
    return Object.freeze({ task: toOccasionTask(result), changed: true });
  }

  async cancelPendingByEmployee(
    employeeId: string,
    denialCode:
      | 'unsubscribed'
      | 'no_authorized_channel'
      | 'purpose_restricted'
      | 'quiet_hours',
    now: Date,
    session: ClientSession,
    allowedTypes: readonly ('birthday' | 'employment_anniversary')[] = [],
  ): Promise<readonly CareOccasionTask[]> {
    const filter = {
      tenantId: this.tenantId(),
      employeeId,
      status: 'pending' as const,
      ...(allowedTypes.length === 0
        ? {}
        : { occasionType: { $nin: [...allowedTypes] } }),
    };
    const pending = await this.records.find(filter).session(session).lean().exec();
    if (pending.length === 0) return Object.freeze([]);
    const result = await this.records.updateMany(
      { ...filter, id: { $in: pending.map((task) => task.id) } },
      { $set: {
        status: 'cancelled',
        denialCode,
        updatedAt: now,
      }, $inc: { version: 1 } },
      { session, timestamps: false, runValidators: true },
    );
    if (result.modifiedCount !== pending.length) throw new CareWriteConflictError();
    return Object.freeze(pending.map((task) => toOccasionTask({
      ...task,
      status: 'cancelled',
      denialCode,
      version: task.version + 1,
      updatedAt: now,
    })));
  }

  async listByEmployeeId(
    employeeId: string,
    limit = 100,
  ): Promise<readonly CareOccasionTask[]> {
    const values = await this.records.find({
      tenantId: this.tenantId(),
      employeeId,
    }).sort({ scheduledAt: -1, id: 1 }).limit(limit).lean().exec();
    return Object.freeze(values.map((value) => toOccasionTask(value)));
  }

  async claimById(
    id: string,
    workerId: string,
    now: Date,
  ): Promise<CareOccasionTask | null> {
    const value = await this.records.findOneAndUpdate(
      {
        tenantId: this.tenantId(),
        id,
        status: 'pending',
        nextAttemptAt: { $lte: now },
        scheduledAt: { $lte: now },
      },
      { $set: {
        status: 'dispatching',
        lockedAt: now,
        lockedBy: workerId,
        updatedAt: now,
      }, $inc: { attempts: 1, version: 1 } },
      { returnDocument: 'after', timestamps: false, runValidators: true },
    ).lean().exec();
    if (value !== null) return toOccasionTask(value);
    const existing = await this.records.findOne({
      tenantId: this.tenantId(),
      id,
      status: 'dispatching',
      lockedBy: workerId,
    }).lean().exec();
    return existing === null ? null : toOccasionTask(existing);
  }

  async replayDeadById(
    id: string,
    now: Date,
    session?: ClientSession,
  ): Promise<CareOccasionTask | null> {
    const query = this.records.findOneAndUpdate(
      { tenantId: this.tenantId(), id, status: 'dead' },
      { $set: {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lockedAt: null,
        lockedBy: null,
        updatedAt: now,
      }, $inc: { version: 1 } },
      { returnDocument: 'after', timestamps: false, runValidators: true },
    );
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : toOccasionTask(value);
  }

  async recoverStaleLocks(now: Date, lockTimeoutMs: number): Promise<number> {
    const cutoff = new Date(now.getTime() - lockTimeoutMs);
    const result = await this.records.updateMany(
      {
        tenantId: this.tenantId(),
        status: 'dispatching',
        lockedAt: { $lte: cutoff },
      },
      { $set: {
        status: 'pending',
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: now,
        updatedAt: now,
      }, $inc: { version: 1 } },
      { timestamps: false, runValidators: true },
    );
    return result.modifiedCount;
  }

  async claimDue(workerId: string, now: Date): Promise<CareOccasionTask | null> {
    const value = await this.records.findOneAndUpdate(
      {
        tenantId: this.tenantId(),
        status: 'pending',
        nextAttemptAt: { $lte: now },
        scheduledAt: { $lte: now },
      },
      { $set: {
        status: 'dispatching',
        lockedAt: now,
        lockedBy: workerId,
        updatedAt: now,
      }, $inc: { attempts: 1, version: 1 } },
      {
        sort: { nextAttemptAt: 1, scheduledAt: 1, id: 1 },
        returnDocument: 'after',
        timestamps: false,
        runValidators: true,
      },
    ).lean().exec();
    return value === null ? null : toOccasionTask(value);
  }

  async replace(
    task: CareOccasionTask,
    expectedVersion: number,
    session?: ClientSession,
  ): Promise<void> {
    this.assertTenant(task.tenantId);
    const query = this.records.updateOne(
      { tenantId: this.tenantId(), id: task.id, version: expectedVersion },
      { $set: {
        status: task.status,
        attempts: task.attempts,
        nextAttemptAt: new Date(task.nextAttemptAt),
        lockedAt: task.lockedAt === null ? null : new Date(task.lockedAt),
        lockedBy: task.lockedBy,
        denialCode: task.denialCode,
        deliveryEvidenceId: task.deliveryEvidenceId,
        deliveredAt: task.deliveredAt === null ? null : new Date(task.deliveredAt),
        version: task.version,
        updatedAt: new Date(task.updatedAt),
      } },
      { timestamps: false, runValidators: true },
    );
    if (session !== undefined) query.session(session);
    const result = await query.exec();
    if (result.matchedCount !== 1) throw new CareWriteConflictError();
  }

  async backlog(): Promise<readonly {
    readonly status: 'pending' | 'dispatching' | 'dead';
    readonly count: number;
    readonly oldestAt: string | null;
  }[]> {
    const values = await this.records.aggregate<{
      _id: 'pending' | 'dispatching' | 'dead';
      count: number;
      oldestAt: Date;
    }>([
      { $match: {
        tenantId: this.tenantId(),
        status: { $in: ['pending', 'dispatching', 'dead'] },
      } },
      { $group: {
        _id: '$status',
        count: { $sum: 1 },
        oldestAt: { $min: '$createdAt' },
      } },
      { $sort: { _id: 1 } },
    ]).exec();
    return values.map((value) => Object.freeze({
      status: value._id,
      count: value.count,
      oldestAt: value.oldestAt?.toISOString() ?? null,
    }));
  }
}

@Injectable()
export class CareOccasionTenantRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(CareOccasionTenantRecord.name)
    private readonly records: Model<CareOccasionTenantDocument>,
  ) {}

  async register(session: ClientSession): Promise<void> {
    const tenantId = this.context.getTenantRequired().tenantId;
    await this.records.updateOne(
      { tenantId },
      { $setOnInsert: { tenantId } },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
  }

  /** 仅供空载荷系统 Worker 枚举；业务访问仍须逐租户进入可信上下文。 */
  async listTenantIds(limit = 10_000): Promise<readonly string[]> {
    const values = await this.records.find({}).sort({ tenantId: 1 }).limit(limit).lean().exec();
    return Object.freeze(values.map((value) => value.tenantId));
  }
}

function toOccasionPreference(
  value: CareOccasionPreferenceRecord,
): CareOccasionPreference {
  return Object.freeze({
    id: value.id,
    tenantId: value.tenantId,
    personId: value.personId,
    employeeId: value.employeeId,
    currentEmploymentId: value.currentEmploymentId,
    birthdayEnabled: value.birthdayEnabled,
    anniversaryEnabled: value.anniversaryEnabled,
    preferredChannels: Object.freeze([...value.preferredChannels]),
    unsubscribed: value.unsubscribed,
    version: value.version,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  });
}

function toOccasionTask(value: CareOccasionTaskRecord): CareOccasionTask {
  return Object.freeze({
    id: value.id,
    tenantId: value.tenantId,
    personId: value.personId,
    employeeId: value.employeeId,
    employmentId: value.employmentId,
    occasionType: value.occasionType,
    occurrenceYear: value.occurrenceYear,
    scheduledAt: value.scheduledAt.toISOString(),
    templateCode: value.templateCode,
    policyVersion: value.policyVersion,
    preferredChannels: Object.freeze([...value.preferredChannels]),
    sourceDigest: value.sourceDigest,
    status: value.status,
    attempts: value.attempts,
    nextAttemptAt: value.nextAttemptAt.toISOString(),
    lockedAt: value.lockedAt?.toISOString() ?? null,
    lockedBy: value.lockedBy,
    denialCode: value.denialCode,
    deliveryEvidenceId: value.deliveryEvidenceId,
    deliveredAt: value.deliveredAt?.toISOString() ?? null,
    version: value.version,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  });
}

function toOccasionTaskRecord(task: CareOccasionTask): Record<string, unknown> {
  return {
    ...task,
    preferredChannels: [...task.preferredChannels],
    scheduledAt: new Date(task.scheduledAt),
    nextAttemptAt: new Date(task.nextAttemptAt),
    lockedAt: task.lockedAt === null ? null : new Date(task.lockedAt),
    deliveredAt: task.deliveredAt === null ? null : new Date(task.deliveredAt),
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  };
}
