import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { AlumniConsent, CareCase, CareTaskEvidence } from '../domain/index.js';
import {
  CareAlumniConsentRecord,
  type CareAlumniConsentDocument,
  CareCaseRecord,
  type CareCaseDocument,
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
