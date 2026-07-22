import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  deepFreezeRecruitment,
  normalizeCandidateEmail,
  normalizeCandidatePhone,
  type Candidate,
  type CandidateApplication,
  type CandidateApplicationStageEvent,
  type RecruitmentInterview,
  type RecruitmentInterviewFeedback,
  type RecruitmentOffer,
  type RecruitmentOfferEvidence,
  type RecruitmentOfferTerms,
  type RecruitmentPosition,
  type RecruitmentRequisition,
  validateRecruitmentOfferTerms,
} from '../domain/index.js';
import {
  RecruitmentDataCryptoService,
  type ProtectedRecruitmentData,
} from './recruitment-data-crypto.service.js';
import {
  CandidateApplicationRecord,
  type CandidateApplicationDocument,
  CandidateApplicationStageRecord,
  type CandidateApplicationStageDocument,
  CandidateConsentEvidenceRecord,
  type CandidateConsentEvidenceDocument,
  RecruitmentCandidateRecord,
  type RecruitmentCandidateDocument,
  RecruitmentInterviewFeedbackRecord,
  type RecruitmentInterviewFeedbackDocument,
  RecruitmentInterviewRecord,
  type RecruitmentInterviewDocument,
  RecruitmentOfferRecord,
  type RecruitmentOfferDocument,
  RecruitmentOfferEvidenceRecord,
  type RecruitmentOfferEvidenceDocument,
  RecruitmentPositionRecord,
  type RecruitmentPositionDocument,
  RecruitmentRequisitionRecord,
  type RecruitmentRequisitionDocument,
} from './recruitment.schemas.js';

export class RecruitmentWriteConflictError extends Error {
  constructor() {
    super('招聘数据版本冲突');
    this.name = 'RecruitmentWriteConflictError';
  }
}

abstract class TenantBoundRecruitmentRepository {
  constructor(protected readonly context: TenantContextService) {}

  protected tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  protected assertTenant(tenantId: string): void {
    if (tenantId !== this.tenantId()) throw new Error('招聘仓储拒绝跨租户实体');
  }
}

@Injectable()
export class RecruitmentCandidateRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(RecruitmentCandidateRecord.name)
    private readonly records: Model<RecruitmentCandidateDocument>,
    private readonly crypto: RecruitmentDataCryptoService,
  ) {
    super(context);
  }

  async findById(id: string, session?: ClientSession): Promise<Candidate | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findByContacts(
    phone: string | null,
    email: string | null,
    session?: ClientSession,
  ): Promise<readonly Candidate[]> {
    const alternatives: Record<string, unknown>[] = [];
    if (phone !== null) alternatives.push({
      phoneBlindIndexes: { $in: this.crypto.blindIndexes(this.tenantId(), 'phone', phone) },
    });
    if (email !== null) alternatives.push({
      emailBlindIndexes: { $in: this.crypto.blindIndexes(this.tenantId(), 'email', email) },
    });
    if (alternatives.length === 0) return [];
    const query = this.records.find({
      tenantId: this.tenantId(), status: { $ne: 'anonymized' }, $or: alternatives,
    });
    if (session !== undefined) query.session(session);
    return (await query.lean().exec()).map((record) => this.toDomain(record));
  }

  async insert(candidate: Candidate, session: ClientSession): Promise<void> {
    this.assertTenant(candidate.tenantId);
    await this.records.create([this.toRecord(candidate)], { session });
  }

  async replace(candidate: Candidate, expectedVersion: number, session: ClientSession): Promise<void> {
    this.assertTenant(candidate.tenantId);
    const record = this.toRecord(candidate);
    const updated = await this.records.updateOne(
      { tenantId: this.tenantId(), id: candidate.id, version: expectedVersion },
      { $set: {
        status: record.status,
        identityKeyId: record.identityKeyId,
        identityIv: record.identityIv,
        identityCiphertext: record.identityCiphertext,
        identityAuthTag: record.identityAuthTag,
        phoneBlindIndexes: record.phoneBlindIndexes,
        emailBlindIndexes: record.emailBlindIndexes,
        consent: record.consent,
        retentionExpiresAt: record.retentionExpiresAt,
        version: record.version,
        updatedAt: record.updatedAt,
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (updated.matchedCount !== 1) throw new RecruitmentWriteConflictError();
  }

  private toRecord(candidate: Candidate): Record<string, unknown> {
    if (candidate.status === 'anonymized') return {
      id: candidate.id, tenantId: candidate.tenantId, status: candidate.status,
      identityKeyId: null, identityIv: null, identityCiphertext: null, identityAuthTag: null,
      phoneBlindIndexes: [], emailBlindIndexes: [], consent: consentRecord(candidate),
      retentionExpiresAt: new Date(candidate.retentionExpiresAt), version: candidate.version,
      createdAt: new Date(candidate.createdAt), updatedAt: new Date(candidate.updatedAt),
    };
    if (candidate.name === null) throw integrityError();
    const protectedData = this.crypto.protect({
      tenantId: candidate.tenantId, resourceType: 'candidate_identity', resourceId: candidate.id,
    }, { name: candidate.name, phone: candidate.phone, email: candidate.email });
    return {
      id: candidate.id, tenantId: candidate.tenantId, status: candidate.status,
      identityKeyId: protectedData.keyId, identityIv: protectedData.iv,
      identityCiphertext: protectedData.ciphertext, identityAuthTag: protectedData.authTag,
      phoneBlindIndexes: candidate.phone === null ? [] :
        this.crypto.blindIndexes(candidate.tenantId, 'phone', candidate.phone),
      emailBlindIndexes: candidate.email === null ? [] :
        this.crypto.blindIndexes(candidate.tenantId, 'email', candidate.email),
      consent: consentRecord(candidate), retentionExpiresAt: new Date(candidate.retentionExpiresAt),
      version: candidate.version, createdAt: new Date(candidate.createdAt),
      updatedAt: new Date(candidate.updatedAt),
    };
  }

  private toDomain(record: RecruitmentCandidateRecord): Candidate {
    if (record.status === 'anonymized') return deepFreezeRecruitment({
      id: record.id, tenantId: record.tenantId, status: record.status,
      name: null, phone: null, email: null, consent: consentDomain(record),
      retentionExpiresAt: record.retentionExpiresAt.toISOString(), version: record.version,
      createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
    });
    const decrypted = this.crypto.unprotect({
      tenantId: record.tenantId, resourceType: 'candidate_identity', resourceId: record.id,
    }, protectedIdentity(record));
    if (!isRecord(decrypted) || typeof decrypted.name !== 'string') throw integrityError();
    if (decrypted.phone !== null && typeof decrypted.phone !== 'string') throw integrityError();
    if (decrypted.email !== null && typeof decrypted.email !== 'string') throw integrityError();
    const phone = decrypted.phone === null ? null : normalizeCandidatePhone(decrypted.phone);
    const email = decrypted.email === null ? null : normalizeCandidateEmail(decrypted.email);
    const name = decrypted.name.normalize('NFKC').trim();
    if (
      name.length < 1 || name.length > 128 || (phone === null && email === null) ||
      !sameStrings(
        record.phoneBlindIndexes,
        phone === null ? [] : this.crypto.blindIndexes(record.tenantId, 'phone', phone),
      ) ||
      !sameStrings(
        record.emailBlindIndexes,
        email === null ? [] : this.crypto.blindIndexes(record.tenantId, 'email', email),
      )
    ) throw integrityError();
    return deepFreezeRecruitment({
      id: record.id, tenantId: record.tenantId, status: record.status,
      name, phone, email,
      consent: consentDomain(record), retentionExpiresAt: record.retentionExpiresAt.toISOString(),
      version: record.version, createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}

@Injectable()
export class CandidateConsentEvidenceRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(CandidateConsentEvidenceRecord.name)
    private readonly records: Model<CandidateConsentEvidenceDocument>,
  ) {
    super(context);
  }

  async appendGranted(candidate: Candidate, actorId: string, session: ClientSession): Promise<void> {
    this.assertTenant(candidate.tenantId);
    await this.records.create([{
      id: candidate.consent.evidenceId, tenantId: candidate.tenantId, candidateId: candidate.id,
      action: 'granted', consentVersion: candidate.consent.version,
      purpose: candidate.consent.purpose, source: candidate.consent.source, actorId,
      occurredAt: new Date(candidate.consent.capturedAt), expiresAt: new Date(candidate.consent.expiresAt),
      migrationEvidenceRef: null, evidenceChecksum: null,
    }], { session });
  }

  async findMigrationEvidenceById(
    id: string,
    session?: ClientSession,
  ): Promise<{ readonly migrationEvidenceRef: string; readonly evidenceChecksum: string } | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id })
      .select('migrationEvidenceRef evidenceChecksum -_id');
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record?.migrationEvidenceRef === null || record?.migrationEvidenceRef === undefined ||
      record.evidenceChecksum === null || record.evidenceChecksum === undefined
      ? null
      : Object.freeze({
          migrationEvidenceRef: record.migrationEvidenceRef,
          evidenceChecksum: record.evidenceChecksum,
        });
  }

  /** 迁移候选人授权只追加最小证明索引；授权与撤回正文均留在同一 WORM 证据。 */
  async appendMigrated(
    candidate: Candidate,
    actorId: string,
    migrationEvidenceRef: string,
    evidenceChecksum: string,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(candidate.tenantId);
    if (candidate.consent.source !== 'manual_import') throw new Error('候选人迁移授权来源无效');
    const common = {
      tenantId: candidate.tenantId,
      candidateId: candidate.id,
      consentVersion: candidate.consent.version,
      purpose: candidate.consent.purpose,
      source: candidate.consent.source,
      actorId,
      expiresAt: new Date(candidate.consent.expiresAt),
      migrationEvidenceRef,
      evidenceChecksum,
    };
    const records: Record<string, unknown>[] = [{
      ...common,
      id: candidate.consent.evidenceId,
      action: 'granted' as const,
      occurredAt: new Date(candidate.consent.capturedAt),
    }];
    if (candidate.consent.withdrawnAt !== null) records.push({
      ...common,
      id: createEventId(new Date(candidate.consent.withdrawnAt)),
      action: 'withdrawn' as const,
      occurredAt: new Date(candidate.consent.withdrawnAt),
    });
    await this.records.create(records, { session });
  }
}

@Injectable()
export class RecruitmentPositionRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(RecruitmentPositionRecord.name)
    private readonly records: Model<RecruitmentPositionDocument>,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<RecruitmentPosition | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : deepFreezeRecruitment({
      id: record.id, tenantId: record.tenantId, requisitionId: record.requisitionId,
      title: record.title, departmentId: record.departmentId, jobLevelId: record.jobLevelId,
      location: record.location, headcount: record.headcount, status: record.status,
      version: record.version, publishedAt: toIso(record.publishedAt), closedAt: toIso(record.closedAt),
      createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
    });
  }

  async insert(position: RecruitmentPosition, session: ClientSession): Promise<void> {
    this.assertTenant(position.tenantId);
    await this.records.create([positionRecord(position)], { session });
  }

  async replace(
    position: RecruitmentPosition,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(position.tenantId);
    const record = positionRecord(position);
    const updated = await this.records.updateOne(
      { tenantId: this.tenantId(), id: position.id, version: expectedVersion },
      { $set: {
        status: record.status, version: record.version, publishedAt: record.publishedAt,
        closedAt: record.closedAt, updatedAt: record.updatedAt,
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (updated.matchedCount !== 1) throw new RecruitmentWriteConflictError();
  }
}

@Injectable()
export class RecruitmentRequisitionRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(RecruitmentRequisitionRecord.name)
    private readonly records: Model<RecruitmentRequisitionDocument>,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<RecruitmentRequisition | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : deepFreezeRecruitment({
      id: record.id, tenantId: record.tenantId, departmentId: record.departmentId,
      positionTitle: record.positionTitle, headcount: record.headcount,
      justification: record.justification, status: record.status,
      approvalInstanceId: record.approvalInstanceId,
      approvalHistoryId: record.approvalHistoryId ?? null,
      version: record.version,
      createdBy: record.createdBy, createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }

  async insert(requisition: RecruitmentRequisition, session: ClientSession): Promise<void> {
    this.assertTenant(requisition.tenantId);
    await this.records.create([requisitionRecord(requisition)], { session });
  }

  async replace(
    requisition: RecruitmentRequisition,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(requisition.tenantId);
    const record = requisitionRecord(requisition);
    const updated = await this.records.updateOne(
      { tenantId: this.tenantId(), id: requisition.id, version: expectedVersion },
      { $set: {
        status: record.status, approvalInstanceId: record.approvalInstanceId,
        approvalHistoryId: record.approvalHistoryId,
        version: record.version, updatedAt: record.updatedAt,
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (updated.matchedCount !== 1) throw new RecruitmentWriteConflictError();
  }
}

@Injectable()
export class CandidateApplicationRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(CandidateApplicationRecord.name)
    private readonly records: Model<CandidateApplicationDocument>,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<CandidateApplication | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : applicationDomain(record);
  }

  async insert(application: CandidateApplication, session: ClientSession): Promise<void> {
    this.assertTenant(application.tenantId);
    await this.records.create([applicationRecord(application)], { session });
  }

  async insertMigrated(
    application: CandidateApplication,
    migrationEvidenceRef: string,
    migrationEvidenceChecksum: string,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(application.tenantId);
    await this.records.create([{
      ...applicationRecord(application), migrationEvidenceRef, migrationEvidenceChecksum,
    }], { session });
  }

  async findMigrationEvidenceById(
    id: string,
    session?: ClientSession,
  ): Promise<{
    readonly migrationEvidenceRef: string;
    readonly migrationEvidenceChecksum: string;
  } | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id })
      .select('migrationEvidenceRef migrationEvidenceChecksum -_id');
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record?.migrationEvidenceRef === null || record?.migrationEvidenceRef === undefined ||
      record.migrationEvidenceChecksum === null || record.migrationEvidenceChecksum === undefined
      ? null
      : Object.freeze({
          migrationEvidenceRef: record.migrationEvidenceRef,
          migrationEvidenceChecksum: record.migrationEvidenceChecksum,
        });
  }

  async replace(
    application: CandidateApplication,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(application.tenantId);
    const record = applicationRecord(application);
    const updated = await this.records.updateOne(
      { tenantId: this.tenantId(), id: application.id, version: expectedVersion },
      { $set: {
        stage: record.stage, active: record.active,
        completedInterviewId: record.completedInterviewId, offerId: record.offerId,
        acceptanceEvidenceId: record.acceptanceEvidenceId,
        onboardingInstanceId: record.onboardingInstanceId, employmentId: record.employmentId,
        version: record.version, endedAt: record.endedAt, updatedAt: record.updatedAt,
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (updated.matchedCount !== 1) throw new RecruitmentWriteConflictError();
  }
}

@Injectable()
export class CandidateApplicationStageRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(CandidateApplicationStageRecord.name)
    private readonly records: Model<CandidateApplicationStageDocument>,
  ) { super(context); }

  async append(event: CandidateApplicationStageEvent, session: ClientSession): Promise<void> {
    this.assertTenant(event.tenantId);
    await this.records.create([{
      id: createEventId(new Date(event.occurredAt)), tenantId: event.tenantId,
      applicationId: event.applicationId, from: event.from, to: event.to, actorId: event.actorId,
      reasonCode: event.reasonCode, evidenceId: event.evidenceId,
      resultingVersion: event.resultingVersion, occurredAt: new Date(event.occurredAt),
    }], { session });
  }
}

@Injectable()
export class RecruitmentInterviewRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(RecruitmentInterviewRecord.name)
    private readonly records: Model<RecruitmentInterviewDocument>,
    private readonly crypto: RecruitmentDataCryptoService,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<RecruitmentInterview | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    if (record === null) return null;
    const logistics = this.crypto.unprotect({
      tenantId: record.tenantId, resourceType: 'interview_location', resourceId: record.id,
    }, {
      keyId: record.logisticsKeyId, iv: record.logisticsIv,
      ciphertext: record.logisticsCiphertext, authTag: record.logisticsAuthTag,
    });
    if (
      !isRecord(logistics) || typeof logistics.location !== 'string' ||
      logistics.mode !== record.mode
    ) throw integrityError();
    return deepFreezeRecruitment({
      id: record.id, tenantId: record.tenantId, applicationId: record.applicationId,
      roundNumber: record.roundNumber, mode: record.mode,
      startsAt: record.startsAt.toISOString(), endsAt: record.endsAt.toISOString(),
      timezone: record.timezone, interviewerIds: [...record.interviewerIds],
      location: logistics.location, status: record.status, version: record.version,
      completedAt: toIso(record.completedAt), cancelledAt: toIso(record.cancelledAt),
      createdBy: record.createdBy, createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }

  async insert(interview: RecruitmentInterview, session: ClientSession): Promise<void> {
    await this.insertWithMigrationEvidence(interview, null, null, session);
  }

  async insertMigrated(
    interview: RecruitmentInterview,
    migrationEvidenceRef: string,
    migrationEvidenceChecksum: string,
    session: ClientSession,
  ): Promise<void> {
    await this.insertWithMigrationEvidence(
      interview, migrationEvidenceRef, migrationEvidenceChecksum, session,
    );
  }

  async findMigrationEvidenceById(
    id: string,
    session?: ClientSession,
  ): Promise<{
    readonly migrationEvidenceRef: string;
    readonly migrationEvidenceChecksum: string;
  } | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id })
      .select('migrationEvidenceRef migrationEvidenceChecksum -_id');
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record?.migrationEvidenceRef === null || record?.migrationEvidenceRef === undefined ||
      record.migrationEvidenceChecksum === null ||
      record.migrationEvidenceChecksum === undefined
      ? null
      : {
          migrationEvidenceRef: record.migrationEvidenceRef,
          migrationEvidenceChecksum: record.migrationEvidenceChecksum,
        };
  }

  private async insertWithMigrationEvidence(
    interview: RecruitmentInterview,
    migrationEvidenceRef: string | null,
    migrationEvidenceChecksum: string | null,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(interview.tenantId);
    const protectedData = this.crypto.protect({
      tenantId: interview.tenantId, resourceType: 'interview_location', resourceId: interview.id,
    }, { mode: interview.mode, location: interview.location });
    await this.records.create([{
      id: interview.id, tenantId: interview.tenantId, applicationId: interview.applicationId,
      roundNumber: interview.roundNumber, mode: interview.mode,
      startsAt: new Date(interview.startsAt), endsAt: new Date(interview.endsAt),
      timezone: interview.timezone, interviewerIds: [...interview.interviewerIds],
      logisticsKeyId: protectedData.keyId, logisticsIv: protectedData.iv,
      logisticsCiphertext: protectedData.ciphertext, logisticsAuthTag: protectedData.authTag,
      status: interview.status, version: interview.version,
      completedAt: interview.completedAt === null ? null : new Date(interview.completedAt),
      cancelledAt: interview.cancelledAt === null ? null : new Date(interview.cancelledAt),
      createdBy: interview.createdBy,
      migrationEvidenceRef, migrationEvidenceChecksum,
      createdAt: new Date(interview.createdAt), updatedAt: new Date(interview.updatedAt),
    }], { session });
  }

  async replace(
    interview: RecruitmentInterview,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(interview.tenantId);
    const updated = await this.records.updateOne(
      { tenantId: this.tenantId(), id: interview.id, version: expectedVersion },
      { $set: {
        status: interview.status, version: interview.version,
        completedAt: interview.completedAt === null ? null : new Date(interview.completedAt),
        cancelledAt: interview.cancelledAt === null ? null : new Date(interview.cancelledAt),
        updatedAt: new Date(interview.updatedAt),
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (updated.matchedCount !== 1) throw new RecruitmentWriteConflictError();
  }
}

@Injectable()
export class RecruitmentInterviewFeedbackRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(RecruitmentInterviewFeedbackRecord.name)
    private readonly records: Model<RecruitmentInterviewFeedbackDocument>,
    private readonly crypto: RecruitmentDataCryptoService,
  ) { super(context); }

  async append(feedback: RecruitmentInterviewFeedback, session: ClientSession): Promise<void> {
    this.assertTenant(feedback.tenantId);
    const protectedData = this.crypto.protect({
      tenantId: feedback.tenantId, resourceType: 'interview_feedback', resourceId: feedback.id,
    }, {
      recommendation: feedback.recommendation, score: feedback.score, notes: feedback.notes,
    });
    await this.records.create([{
      id: feedback.id, tenantId: feedback.tenantId, interviewId: feedback.interviewId,
      interviewerId: feedback.interviewerId,
      evaluationKeyId: protectedData.keyId, evaluationIv: protectedData.iv,
      evaluationCiphertext: protectedData.ciphertext, evaluationAuthTag: protectedData.authTag,
      submittedAt: new Date(feedback.submittedAt),
    }], { session });
  }

  async findInterviewerIds(
    interviewId: string,
    session?: ClientSession,
  ): Promise<readonly string[]> {
    const query = this.records.find(
      { tenantId: this.tenantId(), interviewId },
      { interviewerId: 1, _id: 0 },
    );
    if (session !== undefined) query.session(session);
    const records = await query.lean().exec();
    return Object.freeze(records.map((record) => record.interviewerId));
  }

  async findByInterview(
    interviewId: string,
    session?: ClientSession,
  ): Promise<readonly RecruitmentInterviewFeedback[]> {
    const query = this.records.find({ tenantId: this.tenantId(), interviewId })
      .sort({ submittedAt: 1, id: 1 });
    if (session !== undefined) query.session(session);
    const records = await query.lean().exec();
    return Object.freeze(records.map((record) => {
      const evaluation = this.crypto.unprotect({
        tenantId: record.tenantId,
        resourceType: 'interview_feedback',
        resourceId: record.id,
      }, {
        keyId: record.evaluationKeyId,
        iv: record.evaluationIv,
        ciphertext: record.evaluationCiphertext,
        authTag: record.evaluationAuthTag,
      });
      if (!isInterviewFeedbackEvaluation(evaluation)) throw integrityError();
      return deepFreezeRecruitment({
        id: record.id,
        tenantId: record.tenantId,
        interviewId: record.interviewId,
        interviewerId: record.interviewerId,
        recommendation: evaluation.recommendation,
        score: evaluation.score,
        notes: evaluation.notes,
        submittedAt: record.submittedAt.toISOString(),
      });
    }));
  }
}

@Injectable()
export class RecruitmentOfferRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(RecruitmentOfferRecord.name)
    private readonly records: Model<RecruitmentOfferDocument>,
    private readonly crypto: RecruitmentDataCryptoService,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<RecruitmentOffer | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    if (record === null) return null;
    const value = this.crypto.unprotect({
      tenantId: record.tenantId, resourceType: 'offer_terms', resourceId: record.id,
    }, {
      keyId: record.termsKeyId, iv: record.termsIv,
      ciphertext: record.termsCiphertext, authTag: record.termsAuthTag,
    });
    if (!isOfferTerms(value)) throw integrityError();
    let terms: RecruitmentOfferTerms;
    try {
      terms = validateRecruitmentOfferTerms(value);
    } catch {
      throw integrityError();
    }
    return deepFreezeRecruitment({
      id: record.id, tenantId: record.tenantId, applicationId: record.applicationId,
      candidateId: record.candidateId, positionId: record.positionId,
      completedInterviewId: record.completedInterviewId, terms,
      expiresAt: record.expiresAt.toISOString(),
      retentionExpiresAt: record.retentionExpiresAt.toISOString(), status: record.status,
      approvalInstanceId: record.approvalInstanceId, sendRequestId: record.sendRequestId,
      sentEvidenceId: record.sentEvidenceId,
      acceptanceEvidenceId: record.acceptanceEvidenceId, esignFlowId: record.esignFlowId,
      signedEvidenceId: record.signedEvidenceId, version: record.version,
      createdBy: record.createdBy, createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }

  async insert(offer: RecruitmentOffer, session: ClientSession): Promise<void> {
    this.assertTenant(offer.tenantId);
    const protectedData = this.crypto.protect({
      tenantId: offer.tenantId, resourceType: 'offer_terms', resourceId: offer.id,
    }, offer.terms);
    await this.records.create([{
      id: offer.id, tenantId: offer.tenantId, applicationId: offer.applicationId,
      candidateId: offer.candidateId, positionId: offer.positionId,
      completedInterviewId: offer.completedInterviewId,
      termsKeyId: protectedData.keyId, termsIv: protectedData.iv,
      termsCiphertext: protectedData.ciphertext, termsAuthTag: protectedData.authTag,
      expiresAt: new Date(offer.expiresAt), retentionExpiresAt: new Date(offer.retentionExpiresAt),
      status: offer.status, approvalInstanceId: offer.approvalInstanceId,
      sendRequestId: offer.sendRequestId, sentEvidenceId: offer.sentEvidenceId,
      acceptanceEvidenceId: offer.acceptanceEvidenceId, esignFlowId: offer.esignFlowId,
      signedEvidenceId: offer.signedEvidenceId, version: offer.version,
      createdBy: offer.createdBy, createdAt: new Date(offer.createdAt),
      updatedAt: new Date(offer.updatedAt),
    }], { session });
  }

  async replace(
    offer: RecruitmentOffer,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(offer.tenantId);
    const updated = await this.records.updateOne(
      { tenantId: this.tenantId(), id: offer.id, version: expectedVersion },
      { $set: {
        status: offer.status, approvalInstanceId: offer.approvalInstanceId,
        sendRequestId: offer.sendRequestId, sentEvidenceId: offer.sentEvidenceId,
        acceptanceEvidenceId: offer.acceptanceEvidenceId, esignFlowId: offer.esignFlowId,
        signedEvidenceId: offer.signedEvidenceId, version: offer.version,
        retentionExpiresAt: new Date(offer.retentionExpiresAt),
        updatedAt: new Date(offer.updatedAt),
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (updated.matchedCount !== 1) throw new RecruitmentWriteConflictError();
  }
}

@Injectable()
export class RecruitmentOfferEvidenceRepository extends TenantBoundRecruitmentRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(RecruitmentOfferEvidenceRecord.name)
    private readonly records: Model<RecruitmentOfferEvidenceDocument>,
  ) { super(context); }

  async append(evidence: RecruitmentOfferEvidence, session: ClientSession): Promise<void> {
    this.assertTenant(evidence.tenantId);
    await this.records.create([{
      ...evidence,
      occurredAt: new Date(evidence.occurredAt),
      recordedAt: new Date(evidence.recordedAt),
    }], { session });
  }
}

function consentRecord(candidate: Candidate): Record<string, unknown> {
  return {
    evidenceId: candidate.consent.evidenceId, version: candidate.consent.version,
    purpose: candidate.consent.purpose, source: candidate.consent.source,
    capturedAt: new Date(candidate.consent.capturedAt), expiresAt: new Date(candidate.consent.expiresAt),
    withdrawnAt: candidate.consent.withdrawnAt === null ? null : new Date(candidate.consent.withdrawnAt),
  };
}

function consentDomain(record: RecruitmentCandidateRecord): Candidate['consent'] {
  return deepFreezeRecruitment({
    evidenceId: record.consent.evidenceId, version: record.consent.version,
    purpose: record.consent.purpose, source: record.consent.source,
    capturedAt: record.consent.capturedAt.toISOString(), expiresAt: record.consent.expiresAt.toISOString(),
    withdrawnAt: toIso(record.consent.withdrawnAt),
  });
}

function protectedIdentity(record: RecruitmentCandidateRecord): ProtectedRecruitmentData {
  if (
    record.identityKeyId === null || record.identityIv === null ||
    record.identityCiphertext === null || record.identityAuthTag === null
  ) throw integrityError();
  return {
    keyId: record.identityKeyId, iv: record.identityIv,
    ciphertext: record.identityCiphertext, authTag: record.identityAuthTag,
  };
}

function applicationRecord(application: CandidateApplication): Record<string, unknown> {
  return {
    ...application,
    active: !['hired', 'rejected', 'withdrawn'].includes(application.stage),
    appliedAt: new Date(application.appliedAt),
    endedAt: application.endedAt === null ? null : new Date(application.endedAt),
    createdAt: new Date(application.appliedAt), updatedAt: new Date(application.updatedAt),
  };
}

function positionRecord(position: RecruitmentPosition): Record<string, unknown> {
  return {
    ...position,
    publishedAt: position.publishedAt === null ? null : new Date(position.publishedAt),
    closedAt: position.closedAt === null ? null : new Date(position.closedAt),
    createdAt: new Date(position.createdAt), updatedAt: new Date(position.updatedAt),
  };
}

function requisitionRecord(requisition: RecruitmentRequisition): Record<string, unknown> {
  return {
    ...requisition,
    createdAt: new Date(requisition.createdAt), updatedAt: new Date(requisition.updatedAt),
  };
}

function applicationDomain(record: CandidateApplicationRecord): CandidateApplication {
  return deepFreezeRecruitment({
    id: record.id, tenantId: record.tenantId, candidateId: record.candidateId,
    positionId: record.positionId, consentEvidenceId: record.consentEvidenceId,
    sourceChannel: record.sourceChannel, stage: record.stage,
    completedInterviewId: record.completedInterviewId, offerId: record.offerId,
    acceptanceEvidenceId: record.acceptanceEvidenceId,
    onboardingInstanceId: record.onboardingInstanceId, employmentId: record.employmentId,
    version: record.version, appliedAt: record.appliedAt.toISOString(),
    endedAt: toIso(record.endedAt), updatedAt: record.updatedAt.toISOString(),
  });
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOfferTerms(value: unknown): value is RecruitmentOfferTerms {
  if (!isRecord(value)) return false;
  return value.currency === 'CNY' &&
    typeof value.monthlyBaseSalaryMinor === 'number' &&
    typeof value.salaryMonths === 'number' &&
    typeof value.annualVariableTargetMinor === 'number' &&
    typeof value.signingBonusMinor === 'number' &&
    typeof value.proposedStartDate === 'string' &&
    typeof value.probationMonths === 'number' &&
    typeof value.employmentType === 'string' &&
    typeof value.workLocation === 'string' &&
    typeof value.benefitsSummary === 'string';
}

function isInterviewFeedbackEvaluation(value: unknown): value is Pick<
  RecruitmentInterviewFeedback,
  'recommendation' | 'score' | 'notes'
> {
  if (!isRecord(value)) return false;
  return ['strong_hire', 'hire', 'no_hire', 'strong_no_hire'].includes(
    String(value.recommendation),
  ) && Number.isSafeInteger(value.score) && Number(value.score) >= 1 &&
    Number(value.score) <= 5 && typeof value.notes === 'string';
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function integrityError(): Error {
  return new Error('RECRUITMENT_DATA_INTEGRITY_INVALID');
}
