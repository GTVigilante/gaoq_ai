import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { CourseVersion, ExamAttempt, TrainingAssignment } from '../domain/index.js';
import {
  KnowledgeCourseVersionRecord,
  type KnowledgeCourseVersionDocument,
  KnowledgeExamAttemptRecord,
  type KnowledgeExamAttemptDocument,
  KnowledgeOnboardingAttestationRecord,
  type KnowledgeOnboardingAttestationDocument,
  KnowledgeProgressEventRecord,
  type KnowledgeProgressEventDocument,
  KnowledgeTrainingAssignmentRecord,
  type KnowledgeTrainingAssignmentDocument,
} from './knowledge.schemas.js';

export class KnowledgeWriteConflictError extends Error {
  constructor() {
    super('知识与培训版本冲突');
    this.name = 'KnowledgeWriteConflictError';
  }
}

abstract class TenantRepository {
  constructor(protected readonly context: TenantContextService) {}
  protected tenantId(): string { return this.context.getTenantRequired().tenantId; }
  protected assertTenant(value: string): void {
    if (value !== this.tenantId()) throw new Error('Knowledge 仓储拒绝跨租户实体');
  }
}

@Injectable()
export class CourseVersionRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(KnowledgeCourseVersionRecord.name)
    private readonly records: Model<KnowledgeCourseVersionDocument>,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<CourseVersion | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : Object.freeze({
      id: value.id, tenantId: value.tenantId, courseCode: value.courseCode,
      revision: value.revision, title: value.title, contentRef: value.contentRef,
      questionBankRef: value.questionBankRef, questionBankDigest: value.questionBankDigest,
      passingScoreBps: value.passingScoreBps, status: value.status, version: value.version,
      createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(),
    });
  }

  async insert(course: CourseVersion, session: ClientSession): Promise<void> {
    this.assertTenant(course.tenantId);
    await this.records.create([{ ...course,
      createdAt: new Date(course.createdAt), updatedAt: new Date(course.updatedAt),
    }], { session });
  }

  async replace(course: CourseVersion, expectedVersion: number, session: ClientSession): Promise<void> {
    this.assertTenant(course.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: course.id, version: expectedVersion },
      { $set: {
        title: course.title, status: course.status, version: course.version,
        updatedAt: new Date(course.updatedAt),
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1) throw new KnowledgeWriteConflictError();
  }
}

@Injectable()
export class TrainingAssignmentRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(KnowledgeTrainingAssignmentRecord.name)
    private readonly records: Model<KnowledgeTrainingAssignmentDocument>,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<TrainingAssignment | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : this.toDomain(value);
  }

  async findByOnboarding(
    onboardingInstanceId: string,
    session?: ClientSession,
  ): Promise<readonly TrainingAssignment[]> {
    const query = this.records.find({ tenantId: this.tenantId(), onboardingInstanceId }).sort({ id: 1 });
    if (session !== undefined) query.session(session);
    return (await query.lean().exec()).map((value) => this.toDomain(value));
  }

  async insert(assignment: TrainingAssignment, session: ClientSession): Promise<void> {
    this.assertTenant(assignment.tenantId);
    await this.records.create([{ ...assignment,
      createdAt: new Date(assignment.createdAt), updatedAt: new Date(assignment.updatedAt),
    }], { session });
  }

  async replace(
    assignment: TrainingAssignment,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertTenant(assignment.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: assignment.id, version: expectedVersion },
      { $set: {
        status: assignment.status, progressBps: assignment.progressBps,
        passedExamAttemptId: assignment.passedExamAttemptId,
        completionEvidenceId: assignment.completionEvidenceId,
        version: assignment.version, updatedAt: new Date(assignment.updatedAt),
      } },
      { session, timestamps: false, runValidators: true },
    );
    if (result.matchedCount !== 1) throw new KnowledgeWriteConflictError();
  }

  private toDomain(value: KnowledgeTrainingAssignmentRecord): TrainingAssignment {
    return Object.freeze({
      id: value.id, tenantId: value.tenantId, onboardingInstanceId: value.onboardingInstanceId,
      courseVersionId: value.courseVersionId, mandatory: value.mandatory,
      examRequired: value.examRequired, dueDate: value.dueDate, status: value.status,
      progressBps: value.progressBps, passedExamAttemptId: value.passedExamAttemptId,
      completionEvidenceId: value.completionEvidenceId, version: value.version,
      createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(),
    });
  }
}

@Injectable()
export class ExamAttemptRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(KnowledgeExamAttemptRecord.name)
    private readonly records: Model<KnowledgeExamAttemptDocument>,
  ) { super(context); }

  async findById(id: string, session?: ClientSession): Promise<ExamAttempt | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : this.toDomain(value);
  }

  async findBySubmissionRef(
    submissionRef: string,
    session?: ClientSession,
  ): Promise<ExamAttempt | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), submissionRef });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : this.toDomain(value);
  }

  async nextAttemptNumber(assignmentId: string, session: ClientSession): Promise<number> {
    const value = await this.records.findOne({ tenantId: this.tenantId(), assignmentId })
      .sort({ attemptNumber: -1 }).session(session).lean().exec();
    return (value?.attemptNumber ?? 0) + 1;
  }

  async insert(attempt: ExamAttempt, session: ClientSession): Promise<void> {
    this.assertTenant(attempt.tenantId);
    await this.records.create([{ ...attempt, gradedAt: new Date(attempt.gradedAt) }], { session });
  }

  private toDomain(value: KnowledgeExamAttemptRecord): ExamAttempt {
    return Object.freeze({
      id: value.id, tenantId: value.tenantId, assignmentId: value.assignmentId,
      attemptNumber: value.attemptNumber, submissionRef: value.submissionRef,
      questionSetDigest: value.questionSetDigest, gradingEvidenceId: value.gradingEvidenceId,
      scoreBps: value.scoreBps, passed: value.passed, gradedAt: value.gradedAt.toISOString(),
    });
  }
}

@Injectable()
export class KnowledgeEvidenceRepository extends TenantRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(KnowledgeProgressEventRecord.name)
    private readonly progress: Model<KnowledgeProgressEventDocument>,
    @InjectModel(KnowledgeOnboardingAttestationRecord.name)
    private readonly attestations: Model<KnowledgeOnboardingAttestationDocument>,
  ) { super(context); }

  async findProgressEvent(
    source: string,
    sourceEventId: string,
    session: ClientSession,
  ): Promise<{ readonly assignmentId: string; readonly progressBps: number } | null> {
    const value = await this.progress.findOne({
      tenantId: this.tenantId(), source, sourceEventId,
    }).session(session).lean().exec();
    return value === null ? null : {
      assignmentId: value.assignmentId,
      progressBps: value.progressBps,
    };
  }

  async appendProgress(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly assignmentId: string;
    readonly source: string;
    readonly sourceEventId: string;
    readonly progressBps: number;
    readonly occurredAt: string;
  }, session: ClientSession): Promise<void> {
    this.assertTenant(input.tenantId);
    await this.progress.create([{ ...input, occurredAt: new Date(input.occurredAt) }], { session });
  }

  async findAttestation(
    onboardingInstanceId: string,
    session?: ClientSession,
  ): Promise<{ readonly id: string; readonly digest: string } | null> {
    const query = this.attestations.findOne({ tenantId: this.tenantId(), onboardingInstanceId });
    if (session !== undefined) query.session(session);
    const value = await query.lean().exec();
    return value === null ? null : { id: value.id, digest: value.digest };
  }

  async insertAttestation(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly onboardingInstanceId: string;
    readonly digest: string;
    readonly assignmentCount: number;
    readonly attestedAt: string;
  }, session: ClientSession): Promise<void> {
    this.assertTenant(input.tenantId);
    await this.attestations.create([{ ...input, attestedAt: new Date(input.attestedAt) }], { session });
  }
}
