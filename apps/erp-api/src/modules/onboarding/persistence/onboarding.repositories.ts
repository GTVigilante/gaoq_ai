import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { OnboardingInstance, OnboardingTaskEvidence } from '../domain/index.js';
import {
  OnboardingInstanceRecord,
  type OnboardingInstanceDocument,
  OnboardingTaskEvidenceRecord,
  type OnboardingTaskEvidenceDocument,
} from './onboarding.schemas.js';

export class OnboardingWriteConflictError extends Error {
  constructor() {
    super('入职实例版本冲突');
    this.name = 'OnboardingWriteConflictError';
  }
}

@Injectable()
export class OnboardingInstanceRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OnboardingInstanceRecord.name)
    private readonly records: Model<OnboardingInstanceDocument>,
  ) {}

  async findById(id: string, session?: ClientSession): Promise<OnboardingInstance | null> {
    return this.findOne({ tenantId: this.tenantId(), id }, session);
  }

  async findByOfferId(offerId: string, session?: ClientSession): Promise<OnboardingInstance | null> {
    return this.findOne({ tenantId: this.tenantId(), offerId }, session);
  }

  async insert(instance: OnboardingInstance, session: ClientSession): Promise<void> {
    this.assertTenant(instance.tenantId);
    await this.records.create([this.toRecord(instance)], { session });
  }

  async replace(
    instance: OnboardingInstance,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(instance.tenantId);
    const record = this.toRecord(instance);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: instance.id, version: expectedVersion },
      { $set: {
        signedEvidenceId: record.signedEvidenceId,
        identityEvidenceId: record.identityEvidenceId,
        materialsEvidenceId: record.materialsEvidenceId,
        orgAssignmentEvidenceId: record.orgAssignmentEvidenceId,
        trainingEvidenceId: record.trainingEvidenceId,
        orgPositionId: record.orgPositionId,
        status: record.status,
        completionEvidenceId: record.completionEvidenceId,
        employmentId: record.employmentId,
        version: record.version,
        updatedAt: record.updatedAt,
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1) throw new OnboardingWriteConflictError();
  }

  private async findOne(
    filter: Readonly<Record<string, unknown>>,
    session?: ClientSession,
  ): Promise<OnboardingInstance | null> {
    const query = this.records.findOne(filter);
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  private tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  private assertTenant(tenantId: string): void {
    if (tenantId !== this.tenantId()) throw new Error('入职仓储拒绝跨租户实体');
  }

  private toRecord(instance: OnboardingInstance): Record<string, unknown> {
    return {
      ...instance,
      createdAt: new Date(instance.createdAt),
      updatedAt: new Date(instance.updatedAt),
    };
  }

  private toDomain(record: OnboardingInstanceRecord): OnboardingInstance {
    return Object.freeze({
      id: record.id, tenantId: record.tenantId, offerId: record.offerId,
      applicationId: record.applicationId, candidateId: record.candidateId,
      acceptanceEvidenceId: record.acceptanceEvidenceId,
      signedEvidenceId: record.signedEvidenceId, identityEvidenceId: record.identityEvidenceId,
      materialsEvidenceId: record.materialsEvidenceId,
      orgAssignmentEvidenceId: record.orgAssignmentEvidenceId,
      trainingEvidenceId: record.trainingEvidenceId, departmentId: record.departmentId,
      jobLevelId: record.jobLevelId, orgPositionId: record.orgPositionId,
      proposedStartDate: record.proposedStartDate, status: record.status,
      completionEvidenceId: record.completionEvidenceId, employmentId: record.employmentId,
      version: record.version, createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}

@Injectable()
export class OnboardingTaskEvidenceRepository {
  constructor(
    private readonly context: TenantContextService,
    @InjectModel(OnboardingTaskEvidenceRecord.name)
    private readonly records: Model<OnboardingTaskEvidenceDocument>,
  ) {}

  async append(evidence: OnboardingTaskEvidence, session: ClientSession): Promise<void> {
    if (evidence.tenantId !== this.context.getTenantRequired().tenantId) {
      throw new Error('入职证据仓储拒绝跨租户实体');
    }
    await this.records.create([{
      ...evidence,
      occurredAt: new Date(evidence.occurredAt),
    }], { session });
  }
}
