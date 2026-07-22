import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type {
  ImportApprovalLegacyHistoryFromMigrationInput,
  ImportApprovalActiveActionFromMigration,
  ImportApprovalTemplateFromMigrationInput,
} from '../../approval/application/approval-application.service.js';
import {
  validateAndFreezeApprovalTemplateDefinition,
  type ApprovalCondition,
  type ApprovalFormData,
  type ApprovalFormValue,
  type ApprovalScalar,
  type ApprovalTemplateDefinition,
} from '../../approval/domain/index.js';
import { OrgApplicationService } from '../../org/application/org-application.service.js';
import type { ImportEmploymentFromMigrationInput } from '../../org/application/org-application.service.js';
import {
  RecruitmentManagementService,
  type ImportRecruitmentPositionFromMigrationInput,
  type ImportRecruitmentRequisitionFromMigrationInput,
} from '../../recruitment/application/recruitment-management.service.js';
import {
  RecruitmentApplicationService,
  type ImportRecruitmentCandidateFromMigrationInput,
  type ImportRecruitmentApplicationBaselineFromMigrationInput,
} from '../../recruitment/application/recruitment-application.service.js';
import {
  RecruitmentInterviewService,
  type ImportRecruitmentInterviewFromMigrationInput,
} from '../../recruitment/application/recruitment-interview.service.js';
import {
  RecruitmentOfferService,
  type ImportRecruitmentOfferFromMigrationInput,
} from '../../recruitment/application/recruitment-offer.service.js';
import {
  AttendanceApplicationService,
  type ImportAttendanceSourceFactFromMigrationInput,
} from '../../attendance/application/attendance-application.service.js';
import type {
  CreateDepartmentDto,
  CreateEmployeeDto,
  CreateJobLevelDto,
  CreatePositionDto,
} from '../../org/application/org.dto.js';
import type {
  ApplyDataMigrationRecordDto,
  CreateDataMigrationRunDto,
  DataMigrationEvidenceQueryDto,
} from '../data-migration.dto.js';
import {
  canonicalJson,
  dataMigrationChecksum,
  digest,
  EMPTY_MIGRATION_CHECKSUM,
  migrationSourceFactHash,
  roll,
} from '../data-migration-checksum.js';
import {
  DATA_MIGRATION_SCOPE_WRITE_SCOPE,
  isEntityInMigrationScope,
  type DataMigrationScope,
} from '../data-migration-contract.js';
import {
  DataMigrationAssociationRecord,
  type DataMigrationAssociationDocument,
  DataMigrationAttachmentRecord,
  type DataMigrationAttachmentDocument,
  DataMigrationItemRecord,
  type DataMigrationItemDocument,
  DataMigrationMappingRecord,
  type DataMigrationMappingDocument,
  DataMigrationRunRecord,
  type DataMigrationRunDocument,
} from '../persistence/data-migration.schemas.js';

interface MappingView {
  readonly tenantId: string;
  readonly sourceSystem: string;
  readonly entityType: ApplyDataMigrationRecordDto['entityType'];
  readonly sourceRecordId: string;
  readonly sourceVersion: string;
  readonly payloadHash: string;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetHash: string;
  readonly lastRunId: string;
  readonly lastSequence: number;
}

export interface DataMigrationReport {
  readonly runId: string;
  readonly sourceSystem: string;
  readonly mode: 'full' | 'incremental';
  readonly scope: DataMigrationScope;
  readonly status: 'running' | 'completed' | 'failed';
  readonly expectedSourceCount: number;
  readonly checkpoint: number;
  readonly counts: { readonly applied: number; readonly duplicate: number; readonly rejected: number };
  readonly sourceChecksum: string;
  readonly expectedSourceChecksum: string;
  readonly targetChecksum: string;
  readonly associationCount: number;
  readonly unresolvedAssociationCount: number;
  readonly attachmentCount: number;
  readonly pendingAttachmentCount: number;
  readonly differences: readonly {
    readonly code: string; readonly severity: 'critical' | 'high'; readonly count: number;
  }[];
  readonly phaseSixEligible: boolean;
}

export interface DataMigrationEvidencePage {
  readonly runId: string;
  readonly kind: DataMigrationEvidenceQueryDto['kind'];
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly nextCursor: string | null;
  readonly pageChecksum: string;
}

/** 可重放迁移控制面；迁移账本直写本模块集合，目标数据只经领域应用服务。 */
@Injectable()
export class DataMigrationService {
  constructor(
    private readonly context: TenantContextService,
    private readonly organization: OrgApplicationService,
    @InjectModel(DataMigrationRunRecord.name) private readonly runs: Model<DataMigrationRunDocument>,
    @InjectModel(DataMigrationItemRecord.name) private readonly items: Model<DataMigrationItemDocument>,
    @InjectModel(DataMigrationMappingRecord.name)
    private readonly mappings: Model<DataMigrationMappingDocument>,
    @InjectModel(DataMigrationAssociationRecord.name)
    private readonly associations: Model<DataMigrationAssociationDocument>,
    @InjectModel(DataMigrationAttachmentRecord.name)
    private readonly attachments: Model<DataMigrationAttachmentDocument>,
    @Inject(ApprovalApplicationService)
    private readonly approvals?: ApprovalApplicationService,
    @Inject(RecruitmentManagementService)
    private readonly recruitment?: RecruitmentManagementService,
    @Inject(RecruitmentApplicationService)
    private readonly recruitmentCandidates?: RecruitmentApplicationService,
    @Inject(RecruitmentInterviewService)
    private readonly recruitmentInterviews?: RecruitmentInterviewService,
    @Inject(RecruitmentOfferService)
    private readonly recruitmentOffers?: RecruitmentOfferService,
    @Inject(AttendanceApplicationService)
    private readonly attendance?: AttendanceApplicationService,
  ) {}

  async start(input: CreateDataMigrationRunDto) {
    this.assertExecutor(input.scope);
    const tenantId = this.context.getTenantRequired().tenantId;
    const run = Object.freeze({
      id: createEventId(), tenantId, sourceSystem: input.sourceSystem, mode: input.mode,
      sourceRunId: input.sourceRunId,
      scope: input.scope, expectedSourceCount: input.expectedSourceCount,
      expectedSourceChecksum: input.expectedSourceChecksum,
      sourceChecksum: EMPTY_MIGRATION_CHECKSUM, targetChecksum: EMPTY_MIGRATION_CHECKSUM,
      checkpoint: 0, status: 'running' as const, completedAt: null,
    });
    try {
      await this.runs.create(run);
      return publicRun(run);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await this.runs.findOne({
        tenantId, sourceSystem: input.sourceSystem, sourceRunId: input.sourceRunId,
      }).lean().exec();
      if (existing === null || existing.expectedSourceChecksum !== input.expectedSourceChecksum ||
        existing.expectedSourceCount !== input.expectedSourceCount || existing.mode !== input.mode ||
        existing.scope !== input.scope) throw new ConflictException({
        code: 'DATA_MIGRATION_SOURCE_RUN_REUSED', message: '来源运行标识已绑定不同快照',
      });
      return publicRun(existing);
    }
  }

  async apply(runId: string, input: ApplyDataMigrationRecordDto) {
    this.assertExecutor();
    assertUniqueEvidence(input);
    if (digest(canonicalJson(input.payload)) !== input.payloadHash) {
      throw new BadRequestException({
        code: 'DATA_MIGRATION_PAYLOAD_HASH_MISMATCH', message: '来源记录校验和不匹配',
      });
    }
    const tenantId = this.context.getTenantRequired().tenantId;
    const run = await this.requireRunningRun(tenantId, runId);
    this.assertExecutor(run.scope);
    const sourceFactHash = migrationSourceFactHash(input);
    if (input.sequence > run.expectedSourceCount) throw new BadRequestException({
      code: 'DATA_MIGRATION_SEQUENCE_OUT_OF_RANGE', message: '来源序号超过声明记录数',
    });
    assertEntityInScope(run.scope, input.entityType);
    const existing = await this.items.findOne({ tenantId, runId, sequence: input.sequence }).lean().exec();
    if (existing !== null) {
      if (existing.sourceFactHash !== sourceFactHash) {
        throw new ConflictException({
          code: 'DATA_MIGRATION_SEQUENCE_REUSED', message: '同一序号已被不同来源记录占用',
        });
      }
      await this.preflightEvidence(run, input);
      await this.persistEvidence(run, input);
      await this.advanceCheckpoint(run, existing);
      return publicItem(existing);
    }
    if (input.sequence !== run.checkpoint + 1) throw new ConflictException({
      code: 'DATA_MIGRATION_CHECKPOINT_GAP', message: '必须从当前检查点的下一条继续',
    });
    await this.preflightEvidence(run, input);

    const mapping = await this.mappings.findOne({
      tenantId, sourceSystem: run.sourceSystem,
      entityType: input.entityType, sourceRecordId: input.sourceRecordId,
    }).lean().exec() as MappingView | null;
    let outcome: {
      status: 'applied' | 'duplicate' | 'rejected'; targetId: string | null;
      targetVersion: number | null; targetHash: string | null; rejectionCode: string | null;
    };
    try {
      outcome = await this.applyOrReplay(run, input, mapping);
    } catch (error) {
      const code = rejectionCode(error);
      if (code === null) throw error;
      outcome = {
        status: 'rejected', targetId: null, targetVersion: null, targetHash: null,
        rejectionCode: code,
      };
    }
    const item = {
      id: createEventId(), tenantId, runId, sequence: input.sequence,
      sourceRecordId: input.sourceRecordId, sourceVersion: input.sourceVersion,
      entityType: input.entityType, payloadHash: input.payloadHash, sourceFactHash,
      ...outcome, associationCount: input.associationSourceIds.length,
      attachmentCount: input.attachments.length,
    };
    await this.persistEvidence(run, input);
    await this.items.create(item);
    await this.advanceCheckpoint(run, item);
    return publicItem(item);
  }

  async complete(runId: string): Promise<DataMigrationReport> {
    this.assertExecutor();
    const tenantId = this.context.getTenantRequired().tenantId;
    const run = await this.requireRunningRun(tenantId, runId);
    this.assertExecutor(run.scope);
    if (run.checkpoint !== run.expectedSourceCount) throw new ConflictException({
      code: 'DATA_MIGRATION_SOURCE_INCOMPLETE', message: '来源记录尚未全部处理',
    });
    const report = await this.buildReport(run);
    const status = report.phaseSixEligible ? 'completed' : 'failed';
    const updated = await this.runs.findOneAndUpdate(
      { tenantId, id: runId, status: 'running', checkpoint: run.checkpoint },
      { $set: { status, completedAt: new Date() } },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (updated === null) throw new ConflictException({
      code: 'DATA_MIGRATION_RUN_STATE_CHANGED', message: '迁移运行状态已变化',
    });
    return this.buildReport(updated);
  }

  async report(runId: string): Promise<DataMigrationReport> {
    this.assertReader();
    const tenantId = this.context.getTenantRequired().tenantId;
    const run = await this.runs.findOne({ tenantId, id: runId }).lean().exec();
    if (run === null) throw new NotFoundException({
      code: 'DATA_MIGRATION_RUN_NOT_FOUND', message: '迁移运行不存在',
    });
    return this.buildReport(run);
  }

  async evidence(
    runId: string,
    query: DataMigrationEvidenceQueryDto,
  ): Promise<DataMigrationEvidencePage> {
    this.assertEvidenceReader();
    const tenantId = this.context.getTenantRequired().tenantId;
    const run = await this.runs.findOne({ tenantId, id: runId }).lean().exec();
    if (run === null) throw new NotFoundException({
      code: 'DATA_MIGRATION_RUN_NOT_FOUND', message: '迁移运行不存在',
    });
    if (run.status === 'running') throw new ConflictException({
      code: 'DATA_MIGRATION_EVIDENCE_RUN_NOT_FROZEN',
      message: '迁移运行结束后才能导出完整证据',
    });
    const cursor = decodeEvidenceCursor(query.kind, query.cursor);
    const page = query.kind === 'items'
      ? await this.itemEvidencePage(tenantId, runId, query.limit, cursor)
      : query.kind === 'associations'
        ? await this.associationEvidencePage(tenantId, runId, query.limit, cursor)
        : await this.attachmentEvidencePage(tenantId, runId, query.limit, cursor);
    const body = {
      runId, kind: query.kind, records: Object.freeze([...page.records]),
      nextCursor: page.nextCursor,
    };
    return Object.freeze({ ...body, pageChecksum: digest(canonicalJson(body)) });
  }

  private async itemEvidencePage(
    tenantId: string,
    runId: string,
    limit: number,
    cursor: EvidenceCursor | null,
  ): Promise<EvidencePageResult> {
    const records = await this.items.find({
      tenantId, runId,
      ...(cursor === null ? {} : { sequence: { $gt: cursor.sequence } }),
    }).sort({ sequence: 1 }).limit(limit + 1).lean().exec();
    const page = records.slice(0, limit).map(itemEvidenceRecord);
    const last = page.at(-1);
    return {
      records: page,
      nextCursor: records.length <= limit || last === undefined
        ? null : encodeEvidenceCursor({ kind: 'items', sequence: Number(last.sequence) }),
    };
  }

  private async associationEvidencePage(
    tenantId: string,
    runId: string,
    limit: number,
    cursor: EvidenceCursor | null,
  ): Promise<EvidencePageResult> {
    const records = await this.associations.find({
      tenantId, runId,
      ...(cursor === null ? {} : { $or: [
        { sequence: { $gt: cursor.sequence } },
        {
          sequence: cursor.sequence,
          relationship: { $gt: cursor.tieOne as DataMigrationAssociationRecord['relationship'] },
        },
        {
          sequence: cursor.sequence,
          relationship: cursor.tieOne as DataMigrationAssociationRecord['relationship'],
          sourceAssociationId: { $gt: cursor.tieTwo },
        },
      ] }),
    }).sort({ sequence: 1, relationship: 1, sourceAssociationId: 1 })
      .limit(limit + 1).lean().exec();
    const page = records.slice(0, limit).map(associationEvidenceRecord);
    const last = page.at(-1);
    return {
      records: page,
      nextCursor: records.length <= limit || last === undefined ? null : encodeEvidenceCursor({
        kind: 'associations', sequence: Number(last.sequence),
        tieOne: String(last.relationship), tieTwo: String(last.sourceAssociationId),
      }),
    };
  }

  private async attachmentEvidencePage(
    tenantId: string,
    runId: string,
    limit: number,
    cursor: EvidenceCursor | null,
  ): Promise<EvidencePageResult> {
    const records = await this.attachments.find({
      tenantId, runId,
      ...(cursor === null ? {} : { $or: [
        { sequence: { $gt: cursor.sequence } },
        {
          sequence: cursor.sequence,
          sourceAttachmentId: { $gt: cursor.tieOne },
        },
      ] }),
    }).sort({ sequence: 1, sourceAttachmentId: 1 }).limit(limit + 1).lean().exec();
    const page = records.slice(0, limit).map(attachmentEvidenceRecord);
    const last = page.at(-1);
    return {
      records: page,
      nextCursor: records.length <= limit || last === undefined ? null : encodeEvidenceCursor({
        kind: 'attachments', sequence: Number(last.sequence),
        tieOne: String(last.sourceAttachmentId),
      }),
    };
  }

  private async applyOrReplay(
    run: DataMigrationRunRecord,
    input: ApplyDataMigrationRecordDto,
    mapping: MappingView | null,
  ) {
    await this.validateInput(run, input);
    if (mapping !== null && mapping.payloadHash === input.payloadHash) {
      return {
        status: mapping.lastRunId === run.id && mapping.lastSequence === input.sequence
          ? 'applied' as const : 'duplicate' as const,
        targetId: mapping.targetId, targetVersion: mapping.targetVersion,
        targetHash: mapping.targetHash, rejectionCode: null,
      };
    }
    const applied = await this.dispatch(run, input, mapping);
    await this.mappings.findOneAndUpdate(
      {
        tenantId: run.tenantId, sourceSystem: run.sourceSystem,
        entityType: input.entityType, sourceRecordId: input.sourceRecordId,
      },
      { $set: {
        sourceVersion: input.sourceVersion, payloadHash: input.payloadHash,
        targetId: applied.id, targetVersion: applied.version, targetHash: applied.hash,
        lastRunId: run.id, lastSequence: input.sequence,
      }, $setOnInsert: {
        tenantId: run.tenantId, sourceSystem: run.sourceSystem,
        entityType: input.entityType, sourceRecordId: input.sourceRecordId,
      } },
      { upsert: true, returnDocument: 'after', runValidators: true },
    ).lean().exec();
    return {
      status: 'applied' as const, targetId: applied.id, targetVersion: applied.version,
      targetHash: applied.hash, rejectionCode: null,
    };
  }

  private async validateInput(
    run: DataMigrationRunRecord,
    input: ApplyDataMigrationRecordDto,
  ): Promise<void> {
    if (input.entityType === 'org.department') {
      const payload = departmentPayload(input.payload);
      const expected = payload.parentSourceId === null ? [] : [payload.parentSourceId];
      assertAssociations(input.associationSourceIds, expected);
      if (payload.parentSourceId !== null) {
        await this.requireMapping(run, 'org.department', payload.parentSourceId);
      }
      return;
    }
    if (input.entityType === 'org.position') positionPayload(input.payload);
    else if (input.entityType === 'org.job_level') jobLevelPayload(input.payload);
    else if (input.entityType === 'org.employee') {
      const payload = employeePayload(input.payload);
      assertAssociations(input.associationSourceIds, employeeAssociationIds(payload));
      await Promise.all(employeeAssociationSpecs(payload).map(async (association) =>
        this.requireMapping(run, association.entityType, association.sourceAssociationId)));
      return;
    } else if (input.entityType === 'org.employment') {
      const payload = employmentPayload(input.payload);
      assertAssociations(input.associationSourceIds, [payload.employeeSourceId]);
      await this.requireMapping(run, 'org.employee', payload.employeeSourceId);
      return;
    } else if (input.entityType === 'approval.history') {
      const payload = approvalLegacyHistoryPayload(input.payload);
      const specs = approvalLegacyHistoryAssociationSpecs(payload);
      assertAssociations(
        input.associationSourceIds,
        [...new Set(specs.map((spec) => spec.sourceAssociationId))],
      );
      const evidence = input.attachments.find((attachment) =>
        attachment.sourceAttachmentId === payload.historyEvidenceSourceAttachmentId);
      if (input.attachments.length !== 1 || evidence?.checksum !== payload.historyEvidenceChecksum) {
        throw new Error('DATA_MIGRATION_HISTORY_EVIDENCE_REQUIRED');
      }
      await Promise.all(uniqueAssociationTargets(specs).map(async (spec) =>
        this.requireMapping(run, spec.entityType, spec.sourceAssociationId)));
      return;
    } else if (input.entityType === 'approval.instance') {
      const payload = approvalActiveInstancePayload(input.payload);
      const specs = approvalActiveInstanceAssociationSpecs(payload);
      assertAssociations(
        input.associationSourceIds,
        [...new Set(specs.map((spec) => spec.sourceAssociationId))],
      );
      const evidence = input.attachments.find((attachment) =>
        attachment.sourceAttachmentId === payload.activityEvidenceSourceAttachmentId);
      if (input.attachments.length !== 1 || evidence?.checksum !== payload.activityEvidenceChecksum) {
        throw new Error('DATA_MIGRATION_ACTIVE_APPROVAL_EVIDENCE_REQUIRED');
      }
      await Promise.all(uniqueAssociationTargets(specs).map(async (spec) =>
        this.requireMapping(run, spec.entityType, spec.sourceAssociationId)));
      return;
    } else if (input.entityType === 'recruitment.requisition') {
      const payload = recruitmentRequisitionPayload(input.payload);
      const specs = recruitmentRequisitionAssociationSpecs(payload);
      assertAssociations(
        input.associationSourceIds,
        [...new Set(specs.map((spec) => spec.sourceAssociationId))],
      );
      assertGovernanceEvidence(input, payload);
      await Promise.all(uniqueAssociationTargets(specs).map(async (spec) =>
        this.requireMapping(run, spec.entityType, spec.sourceAssociationId)));
      return;
    } else if (input.entityType === 'recruitment.position') {
      const payload = recruitmentPositionPayload(input.payload);
      const specs = recruitmentPositionAssociationSpecs(payload);
      assertAssociations(
        input.associationSourceIds,
        [...new Set(specs.map((spec) => spec.sourceAssociationId))],
      );
      assertGovernanceEvidence(input, payload);
      await Promise.all(uniqueAssociationTargets(specs).map(async (spec) =>
        this.requireMapping(run, spec.entityType, spec.sourceAssociationId)));
      return;
    } else if (input.entityType === 'recruitment.candidate') {
      const payload = recruitmentCandidatePayload(input.payload);
      assertAssociations(input.associationSourceIds, []);
      const evidence = input.attachments.find((attachment) =>
        attachment.sourceAttachmentId === payload.candidateEvidenceSourceAttachmentId);
      if (input.attachments.length !== 1 ||
        evidence?.checksum !== payload.candidateEvidenceChecksum) {
        throw new Error('DATA_MIGRATION_CANDIDATE_EVIDENCE_REQUIRED');
      }
      return;
    } else if (input.entityType === 'recruitment.application') {
      const payload = recruitmentApplicationPayload(input.payload);
      const specs = recruitmentApplicationAssociationSpecs(payload);
      assertAssociations(
        input.associationSourceIds,
        specs.map((spec) => spec.sourceAssociationId),
      );
      const evidence = input.attachments.find((attachment) =>
        attachment.sourceAttachmentId === payload.applicationEvidenceSourceAttachmentId);
      if (input.attachments.length !== 1 ||
        evidence?.checksum !== payload.applicationEvidenceChecksum) {
        throw new Error('DATA_MIGRATION_APPLICATION_EVIDENCE_REQUIRED');
      }
      await Promise.all(specs.map(async (spec) =>
        this.requireMapping(run, spec.entityType, spec.sourceAssociationId)));
      return;
    } else if (input.entityType === 'recruitment.interview') {
      const payload = recruitmentInterviewPayload(input.payload);
      const specs = recruitmentInterviewAssociationSpecs(payload);
      assertAssociations(
        input.associationSourceIds,
        [...new Set(specs.map((spec) => spec.sourceAssociationId))],
      );
      const evidence = input.attachments.find((attachment) =>
        attachment.sourceAttachmentId === payload.interviewEvidenceSourceAttachmentId);
      if (input.attachments.length !== 1 ||
        evidence?.checksum !== payload.interviewEvidenceChecksum) {
        throw new Error('DATA_MIGRATION_INTERVIEW_EVIDENCE_REQUIRED');
      }
      await Promise.all(uniqueAssociationTargets(specs).map(async (spec) =>
        this.requireMapping(run, spec.entityType, spec.sourceAssociationId)));
      return;
    } else if (input.entityType === 'recruitment.offer') {
      const payload = recruitmentOfferPayload(input.payload);
      const specs = recruitmentOfferAssociationSpecs(payload);
      assertAssociations(
        input.associationSourceIds,
        [...new Set(specs.map((spec) => spec.sourceAssociationId))],
      );
      const evidence = input.attachments.find((attachment) =>
        attachment.sourceAttachmentId === payload.offerEvidenceSourceAttachmentId);
      if (input.attachments.length !== 1 ||
        evidence?.checksum !== payload.offerEvidenceChecksum) {
        throw new Error('DATA_MIGRATION_OFFER_EVIDENCE_REQUIRED');
      }
      await Promise.all(uniqueAssociationTargets(specs).map(async (spec) =>
        this.requireMapping(run, spec.entityType, spec.sourceAssociationId)));
      return;
    } else if (input.entityType === 'attendance.source_fact') {
      const payload = attendanceSourceFactPayload(input.payload);
      assertAssociations(input.associationSourceIds, [payload.employeeSourceId]);
      const evidence = input.attachments.find((attachment) =>
        attachment.sourceAttachmentId === payload.sourceEvidenceSourceAttachmentId);
      if (input.attachments.length !== 1 ||
        evidence?.checksum !== payload.sourceEvidenceChecksum) {
        throw new Error('DATA_MIGRATION_ATTENDANCE_SOURCE_EVIDENCE_REQUIRED');
      }
      await this.requireMapping(run, 'org.employee', payload.employeeSourceId);
      return;
    } else {
      const payload = approvalTemplatePayload(input.payload);
      const specs = approvalTemplateAssociationSpecs(payload);
      assertAssociations(
        input.associationSourceIds,
        [...new Set(specs.map((spec) => spec.sourceAssociationId))],
      );
      const governanceEvidenceAttached = payload.governanceEvidenceSourceAttachmentId !== null &&
        input.attachments.some((attachment) =>
          attachment.sourceAttachmentId === payload.governanceEvidenceSourceAttachmentId);
      if ((payload.status === 'draft' && payload.governanceEvidenceSourceAttachmentId !== null) ||
        (payload.status !== 'draft' && !governanceEvidenceAttached)) {
        throw new Error('DATA_MIGRATION_GOVERNANCE_EVIDENCE_REQUIRED');
      }
      await Promise.all(specs.map(async (spec) =>
        this.requireMapping(run, spec.entityType, spec.sourceAssociationId)));
      return;
    }
    assertAssociations(input.associationSourceIds, []);
  }

  private async dispatch(
    run: DataMigrationRunRecord,
    input: ApplyDataMigrationRecordDto,
    mapping: MappingView | null,
  ): Promise<{ readonly id: string; readonly version: number; readonly hash: string }> {
    const key = `migration:${run.id}:${input.sequence}:${input.payloadHash.slice(0, 16)}`;
    if (input.entityType === 'org.department') {
      const payload = departmentPayload(input.payload);
      assertAssociations(
        input.associationSourceIds,
        payload.parentSourceId === null ? [] : [payload.parentSourceId],
      );
      const parentId = payload.parentSourceId === null
        ? null : (await this.requireMapping(run, 'org.department', payload.parentSourceId)).targetId;
      const command: CreateDepartmentDto = {
        code: payload.code, name: payload.name, status: payload.status,
        parentId, managerId: null, sortOrder: payload.sortOrder,
      };
      const result = mapping === null
        ? await this.organization.createDepartment(key, command)
        : await this.organization.updateDepartment(
          mapping.targetId, mapping.targetVersion, key, command,
        );
      return target(result.department);
    }
    if (input.entityType === 'org.position') {
      assertAssociations(input.associationSourceIds, []);
      const command = positionPayload(input.payload);
      const result = mapping === null
        ? await this.organization.createPosition(key, command)
        : await this.organization.updatePosition(mapping.targetId, mapping.targetVersion, key, command);
      return target(result.position);
    }
    if (input.entityType === 'org.job_level') {
      const command = jobLevelPayload(input.payload);
      assertAssociations(input.associationSourceIds, []);
      const result = mapping === null
        ? await this.organization.createJobLevel(key, command)
        : await this.organization.updateJobLevel(
          mapping.targetId, mapping.targetVersion, key, command,
        );
      return target(result.jobLevel);
    }
    if (input.entityType === 'org.employee') {
      const payload = employeePayload(input.payload);
      const command = await this.employeeCommand(run, payload);
      const result = mapping === null
        ? await this.organization.createEmployee(key, command)
        : await this.organization.synchronizeEmployeeFromMigration(
          mapping.targetId, mapping.targetVersion, key, command,
        );
      return target(result.employee);
    }
    if (input.entityType === 'org.employment') {
      const payload = employmentPayload(input.payload);
      const employeeId = (await this.requireMapping(
        run, 'org.employee', payload.employeeSourceId,
      )).targetId;
      const result = await this.organization.importEmploymentFromMigration(key, {
        ...payload,
        employeeId,
      });
      return target(result.employment);
    }
    if (input.entityType === 'approval.history') {
      const payload = approvalLegacyHistoryPayload(input.payload);
      if (this.approvals === undefined) throw new Error('迁移审批适配器未装配');
      const templateId = (await this.requireMapping(
        run,
        'approval.template',
        payload.templateSourceId,
      )).targetId;
      const initiatorEmployeeId = (await this.requireMapping(
        run,
        'org.employee',
        payload.initiatorEmployeeSourceId,
      )).targetId;
      const result = await this.approvals.importLegacyHistoryFromMigration(key, {
        templateId,
        templateCode: payload.templateCode,
        templateRevision: payload.templateRevision,
        initiatorEmployeeId,
        outcome: payload.outcome,
        completedAt: payload.completedAt,
        archivedAt: payload.archivedAt,
        migrationEvidenceRef:
          `erp://data-migrations/runs/${run.id}/attachments/${payload.historyEvidenceSourceAttachmentId}`,
        evidenceChecksum: payload.historyEvidenceChecksum,
      });
      return target(result.history);
    }
    if (input.entityType === 'approval.instance') {
      const payload = approvalActiveInstancePayload(input.payload);
      if (this.approvals === undefined) throw new Error('迁移审批适配器未装配');
      const mappingCache = new Map<string, Promise<string>>();
      const targetId = (
        entityType: 'org.employee' | 'org.department',
        sourceId: string,
      ): Promise<string> => cachedTargetId(mappingCache, entityType, sourceId, async () =>
        (await this.requireMapping(run, entityType, sourceId)).targetId);
      const templateId = await cachedTargetId(
        mappingCache,
        'approval.template',
        payload.templateSourceId,
        async () => (await this.requireMapping(
          run,
          'approval.template',
          payload.templateSourceId,
        )).targetId,
      );
      const employeeId = (sourceId: string): Promise<string> =>
        targetId('org.employee', sourceId);
      const formData = await mapActiveApprovalFormData(payload, targetId);
      const result = await this.approvals.importActiveInstanceFromMigration(key, {
        templateId,
        templateCode: payload.templateCode,
        templateRevision: payload.templateRevision,
        title: payload.title,
        initiatorEmployeeId: await employeeId(payload.initiatorEmployeeSourceId),
        formData,
        mappedFormReferenceFields: payload.formReferenceFields.map((field) => ({
          fieldKey: field.fieldKey,
          entityType: field.entityType,
        })),
        resolvedNodes: await Promise.all(payload.resolvedNodes.map(async (node) => ({
          nodeId: node.nodeId,
          actorEmployeeIds: await Promise.all(node.actorEmployeeSourceIds.map(employeeId)),
        }))),
        actions: await Promise.all(payload.actions.map(async (action) =>
          mapActiveApprovalAction(action, employeeId))),
        expectedStatus: payload.expectedStatus,
        expectedVersion: payload.expectedVersion,
        expectedCurrentNodeId: payload.expectedCurrentNodeId,
        expectedPendingApproverEmployeeIds: await Promise.all(
          payload.expectedPendingApproverEmployeeSourceIds.map(employeeId),
        ),
        createdAt: payload.createdAt,
        submittedAt: payload.submittedAt,
        updatedAt: payload.updatedAt,
        migrationEvidenceRef:
          `erp://data-migrations/runs/${run.id}/attachments/${payload.activityEvidenceSourceAttachmentId}`,
        evidenceChecksum: payload.activityEvidenceChecksum,
      });
      return target(result.instance);
    }
    if (input.entityType === 'recruitment.requisition') {
      const payload = recruitmentRequisitionPayload(input.payload);
      if (this.recruitment === undefined) throw new Error('迁移招聘适配器未装配');
      const departmentId = (await this.requireMapping(
        run,
        'org.department',
        payload.departmentSourceId,
      )).targetId;
      const createdByEmployeeId = (await this.requireMapping(
        run,
        'org.employee',
        payload.createdByEmployeeSourceId,
      )).targetId;
      const approvalReferenceId = payload.approvalReferenceType === null ||
        payload.approvalReferenceSourceId === null
        ? null
        : (await this.requireMapping(
            run,
            payload.approvalReferenceType,
            payload.approvalReferenceSourceId,
          )).targetId;
      const result = await this.recruitment.importRequisitionFromMigration(key, {
        targetId: mapping?.targetId ?? null,
        departmentId,
        positionTitle: payload.positionTitle,
        headcount: payload.headcount,
        justification: payload.justification,
        status: payload.status,
        approvalReferenceType: payload.approvalReferenceType === 'approval.instance'
          ? 'approval_instance'
          : payload.approvalReferenceType === 'approval.history'
            ? 'legacy_history'
            : null,
        approvalReferenceId,
        version: payload.version,
        createdByEmployeeId,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      });
      return target(result.requisition);
    }
    if (input.entityType === 'recruitment.position') {
      const payload = recruitmentPositionPayload(input.payload);
      if (this.recruitment === undefined) throw new Error('迁移招聘适配器未装配');
      const [requisitionId, departmentId, jobLevelId] = await Promise.all([
        this.requireMapping(run, 'recruitment.requisition', payload.requisitionSourceId),
        this.requireMapping(run, 'org.department', payload.departmentSourceId),
        this.requireMapping(run, 'org.job_level', payload.jobLevelSourceId),
      ]);
      const result = await this.recruitment.importPositionFromMigration(key, {
        targetId: mapping?.targetId ?? null,
        requisitionId: requisitionId.targetId,
        departmentId: departmentId.targetId,
        jobLevelId: jobLevelId.targetId,
        title: payload.title,
        location: payload.location,
        headcount: payload.headcount,
        status: payload.status,
        version: payload.version,
        publishedAt: payload.publishedAt,
        closedAt: payload.closedAt,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      });
      return target(result.position);
    }
    if (input.entityType === 'recruitment.candidate') {
      const payload = recruitmentCandidatePayload(input.payload);
      if (this.recruitmentCandidates === undefined) throw new Error('迁移候选人适配器未装配');
      const result = await this.recruitmentCandidates.importCandidateFromMigration(key, {
        targetId: mapping?.targetId ?? null,
        status: payload.status,
        name: payload.name,
        phone: payload.phone,
        email: payload.email,
        consentVersion: payload.consentVersion,
        consentPurpose: payload.consentPurpose,
        consentCapturedAt: payload.consentCapturedAt,
        consentExpiresAt: payload.consentExpiresAt,
        consentWithdrawnAt: payload.consentWithdrawnAt,
        retentionExpiresAt: payload.retentionExpiresAt,
        version: payload.version,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        migrationEvidenceRef:
          `erp://data-migrations/runs/${run.id}/attachments/${payload.candidateEvidenceSourceAttachmentId}`,
        evidenceChecksum: payload.candidateEvidenceChecksum,
      });
      return target(result.candidate);
    }
    if (input.entityType === 'recruitment.application') {
      const payload = recruitmentApplicationPayload(input.payload);
      if (this.recruitmentCandidates === undefined) throw new Error('迁移招聘申请适配器未装配');
      const [candidate, position] = await Promise.all([
        this.requireMapping(run, 'recruitment.candidate', payload.candidateSourceId),
        this.requireMapping(run, 'recruitment.position', payload.positionSourceId),
      ]);
      const result = await this.recruitmentCandidates.importApplicationBaselineFromMigration(key, {
        targetId: mapping?.targetId ?? null,
        candidateId: candidate.targetId,
        positionId: position.targetId,
        sourceChannel: payload.sourceChannel,
        actions: payload.actions,
        expectedStage: payload.expectedStage,
        expectedVersion: payload.expectedVersion,
        appliedAt: payload.appliedAt,
        endedAt: payload.endedAt,
        updatedAt: payload.updatedAt,
        migrationEvidenceRef:
          `erp://data-migrations/runs/${run.id}/attachments/${payload.applicationEvidenceSourceAttachmentId}`,
        evidenceChecksum: payload.applicationEvidenceChecksum,
      });
      return target(result.application);
    }
    if (input.entityType === 'recruitment.interview') {
      const payload = recruitmentInterviewPayload(input.payload);
      if (this.recruitmentInterviews === undefined) {
        throw new Error('迁移招聘面试适配器未装配');
      }
      const employeeMappings = new Map<string, Promise<string>>();
      const resolveEmployee = (sourceId: string): Promise<string> => cachedTargetId(
        employeeMappings,
        'org.employee',
        sourceId,
        async () => (await this.requireMapping(run, 'org.employee', sourceId)).targetId,
      );
      const applicationId = (await this.requireMapping(
        run, 'recruitment.application', payload.applicationSourceId,
      )).targetId;
      const interviewerIds = await Promise.all(
        payload.interviewerEmployeeSourceIds.map(resolveEmployee),
      );
      const feedback = await Promise.all(payload.feedback.map(async (item) => ({
        interviewerId: await resolveEmployee(item.interviewerEmployeeSourceId),
        recommendation: item.recommendation,
        score: item.score,
        notes: item.notes,
        submittedAt: item.submittedAt,
      })));
      const result = await this.recruitmentInterviews.importInterviewFromMigration(key, {
        targetId: mapping?.targetId ?? null,
        applicationId,
        roundNumber: payload.roundNumber,
        mode: payload.mode,
        startsAt: payload.startsAt,
        endsAt: payload.endsAt,
        timezone: payload.timezone,
        interviewerIds,
        location: payload.location,
        createdByEmployeeId: await resolveEmployee(payload.createdByEmployeeSourceId),
        feedback,
        expectedStatus: payload.expectedStatus,
        expectedVersion: payload.expectedVersion,
        completedAt: payload.completedAt,
        cancelledAt: payload.cancelledAt,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        migrationEvidenceRef:
          `erp://data-migrations/runs/${run.id}/attachments/${payload.interviewEvidenceSourceAttachmentId}`,
        evidenceChecksum: payload.interviewEvidenceChecksum,
      });
      return target(result.interview);
    }
    if (input.entityType === 'recruitment.offer') {
      const payload = recruitmentOfferPayload(input.payload);
      if (this.recruitmentOffers === undefined) throw new Error('迁移招聘 Offer 适配器未装配');
      const [application, interview, createdBy, approval] = await Promise.all([
        this.requireMapping(run, 'recruitment.application', payload.applicationSourceId),
        this.requireMapping(run, 'recruitment.interview', payload.completedInterviewSourceId),
        this.requireMapping(run, 'org.employee', payload.createdByEmployeeSourceId),
        payload.approvalReferenceType === null || payload.approvalReferenceSourceId === null
          ? Promise.resolve(null)
          : this.requireMapping(
              run, payload.approvalReferenceType, payload.approvalReferenceSourceId,
            ),
      ]);
      const result = await this.recruitmentOffers.importOfferFromMigration(key, {
        targetId: mapping?.targetId ?? null,
        applicationId: application.targetId,
        completedInterviewId: interview.targetId,
        createdByEmployeeId: createdBy.targetId,
        terms: payload.terms,
        expiresAt: payload.expiresAt,
        retentionExpiresAt: payload.retentionExpiresAt,
        status: payload.status,
        approvalReferenceType: payload.approvalReferenceType === 'approval.instance'
          ? 'approval_instance'
          : payload.approvalReferenceType === 'approval.history'
            ? 'legacy_history'
            : null,
        approvalReferenceId: approval?.targetId ?? null,
        sendRequested: payload.sendRequested,
        sentProof: payload.sentProof,
        decisionProof: payload.decisionProof,
        signedProof: payload.signedProof,
        version: payload.version,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        applicationBaselineVersion: payload.applicationBaselineVersion,
        applicationBaselineUpdatedAt: payload.applicationBaselineUpdatedAt,
        applicationActions: payload.applicationActions,
        expectedApplicationStage: payload.expectedApplicationStage,
        expectedApplicationVersion: payload.expectedApplicationVersion,
        applicationEndedAt: payload.applicationEndedAt,
        applicationUpdatedAt: payload.applicationUpdatedAt,
        migrationEvidenceRef:
          `erp://data-migrations/runs/${run.id}/attachments/${payload.offerEvidenceSourceAttachmentId}`,
        evidenceChecksum: payload.offerEvidenceChecksum,
      });
      return target(result.offer);
    }
    if (input.entityType === 'attendance.source_fact') {
      const payload = attendanceSourceFactPayload(input.payload);
      if (this.attendance === undefined) throw new Error('迁移考勤源事实适配器未装配');
      const employee = await this.requireMapping(run, 'org.employee', payload.employeeSourceId);
      const result = await this.attendance.importSourceFactFromMigration(key, {
        targetId: mapping?.targetId ?? null,
        employeeId: employee.targetId,
        providerCode: payload.providerCode,
        externalEventId: payload.externalEventId,
        factType: payload.factType,
        occurredAt: payload.occurredAt,
        timeZone: payload.timeZone,
        impact: payload.impact,
        sourceObservedAt: payload.sourceObservedAt,
        createdAt: payload.createdAt,
        migrationEvidenceRef:
          `erp://data-migrations/runs/${run.id}/attachments/${payload.sourceEvidenceSourceAttachmentId}`,
        evidenceChecksum: payload.sourceEvidenceChecksum,
      });
      return target(result.fact);
    }
    const payload = approvalTemplatePayload(input.payload);
    if (this.approvals === undefined) throw new Error('迁移审批适配器未装配');
    const employeeId = async (sourceId: string): Promise<string> =>
      (await this.requireMapping(run, 'org.employee', sourceId)).targetId;
    const definition = await mapApprovalTemplateDefinition(
      payload.definition,
      async (entityType, sourceId) =>
        (await this.requireMapping(run, entityType, sourceId)).targetId,
    );
    const result = await this.approvals.importTemplateFromMigration(key, {
      code: payload.code,
      name: payload.name,
      riskLevel: payload.riskLevel,
      revision: payload.revision,
      status: payload.status,
      definition,
      createdByEmployeeId: await employeeId(payload.createdByEmployeeSourceId),
      updatedByEmployeeId: await employeeId(payload.updatedByEmployeeSourceId),
      approvedByEmployeeId: payload.approvedByEmployeeSourceId === null
        ? null
        : await employeeId(payload.approvedByEmployeeSourceId),
      publishedAt: payload.publishedAt,
      retiredAt: payload.retiredAt,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    });
    return target(result.template);
  }

  private async employeeCommand(
    run: DataMigrationRunRecord,
    payload: EmployeeMigrationPayload,
  ): Promise<CreateEmployeeDto> {
    const departmentIds = await Promise.all(payload.departmentSourceIds.map(async (sourceId) =>
      (await this.requireMapping(run, 'org.department', sourceId)).targetId));
    const positionIds = await Promise.all(payload.positionSourceIds.map(async (sourceId) =>
      (await this.requireMapping(run, 'org.position', sourceId)).targetId));
    const primaryDepartmentId = (await this.requireMapping(
      run, 'org.department', payload.primaryDepartmentSourceId,
    )).targetId;
    const jobLevelId = payload.jobLevelSourceId === null ? null : (await this.requireMapping(
      run, 'org.job_level', payload.jobLevelSourceId,
    )).targetId;
    return {
      employeeNo: payload.employeeNo, displayName: payload.displayName, status: payload.status,
      departmentIds, primaryDepartmentId, positionIds, jobLevelId,
    };
  }

  private async requireMapping(
    run: DataMigrationRunRecord,
    entityType: ApplyDataMigrationRecordDto['entityType'],
    sourceRecordId: string,
  ): Promise<MappingView> {
    const mapping = await this.mappings.findOne({
      tenantId: run.tenantId, sourceSystem: run.sourceSystem, entityType, sourceRecordId,
    }).lean().exec() as MappingView | null;
    if (mapping === null) throw new Error('DATA_MIGRATION_ASSOCIATION_MISSING');
    return mapping;
  }

  private async preflightEvidence(
    run: DataMigrationRunRecord,
    input: ApplyDataMigrationRecordDto,
  ): Promise<void> {
    for (const attachment of input.attachments) {
      const existing = await this.attachments.findOne({
        tenantId: run.tenantId, runId: run.id,
        sourceAttachmentId: attachment.sourceAttachmentId,
      }).lean().exec();
      if (existing !== null &&
        (existing.sequence !== input.sequence || existing.checksum !== attachment.checksum)) {
        throw new ConflictException({
          code: 'DATA_MIGRATION_ATTACHMENT_REUSED',
          message: '同一来源附件标识已绑定不同记录或校验和',
        });
      }
    }
  }

  private async persistEvidence(
    run: DataMigrationRunRecord,
    input: ApplyDataMigrationRecordDto,
  ): Promise<void> {
    const evidence = associationEvidence(input);
    for (const association of evidence) {
      const mapping = association.entityType === null
        ? null
        : await this.mappings.findOne({
          tenantId: run.tenantId, sourceSystem: run.sourceSystem,
          entityType: association.entityType,
          sourceRecordId: association.sourceAssociationId,
        }).lean().exec() as MappingView | null;
      await this.associations.findOneAndUpdate(
        {
          tenantId: run.tenantId, runId: run.id, sequence: input.sequence,
          relationship: association.relationship,
          sourceAssociationId: association.sourceAssociationId,
        },
        {
          $setOnInsert: {
            id: createEventId(), tenantId: run.tenantId, runId: run.id,
            sequence: input.sequence, relationship: association.relationship,
            sourceAssociationId: association.sourceAssociationId,
          },
          $set: {
            targetId: mapping?.targetId ?? null,
            status: mapping === null ? 'missing' : 'resolved',
          },
        },
        { upsert: true, returnDocument: 'after', runValidators: true },
      ).lean().exec();
    }
    for (const attachment of input.attachments) {
      try {
        await this.attachments.updateOne(
          {
            tenantId: run.tenantId, runId: run.id, sequence: input.sequence,
            sourceAttachmentId: attachment.sourceAttachmentId, checksum: attachment.checksum,
          },
          { $setOnInsert: {
            id: createEventId(), tenantId: run.tenantId, runId: run.id,
            sequence: input.sequence, sourceAttachmentId: attachment.sourceAttachmentId,
            checksum: attachment.checksum, status: 'pending', attempts: 0,
            processingStartedAt: null, targetEvidenceId: null, rejectionCode: null,
          } },
          { upsert: true, runValidators: true },
        ).exec();
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        throw new ConflictException({
          code: 'DATA_MIGRATION_ATTACHMENT_REUSED',
          message: '同一来源附件标识已绑定不同记录或校验和',
        });
      }
    }
  }

  private async advanceCheckpoint(
    run: DataMigrationRunRecord,
    item: Pick<DataMigrationItemRecord,
      'sequence' | 'sourceFactHash' | 'status' | 'targetHash' | 'rejectionCode'>,
  ): Promise<void> {
    if (item.sequence <= run.checkpoint) return;
    const sourceChecksum = roll(run.sourceChecksum, item.sequence, item.sourceFactHash);
    const targetFact = item.targetHash ?? digest(`rejected:${item.rejectionCode ?? 'UNKNOWN'}`);
    const targetChecksum = roll(run.targetChecksum, item.sequence, targetFact);
    const result = await this.runs.updateOne(
      { tenantId: run.tenantId, id: run.id, status: 'running', checkpoint: item.sequence - 1 },
      { $set: { checkpoint: item.sequence, sourceChecksum, targetChecksum } },
      { runValidators: true },
    ).exec();
    if (result.modifiedCount !== 1) throw new ConflictException({
      code: 'DATA_MIGRATION_CHECKPOINT_RACE', message: '迁移检查点已由其它执行者推进',
    });
  }

  private async buildReport(run: DataMigrationRunRecord): Promise<DataMigrationReport> {
    const [grouped, associationStatuses, attachmentStatuses] = await Promise.all([
      this.items.aggregate<{
        _id: DataMigrationItemRecord['status']; count: number;
      }>([
        { $match: { tenantId: run.tenantId, runId: run.id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
      this.associations.aggregate<{ _id: DataMigrationAssociationRecord['status']; count: number }>([
        { $match: { tenantId: run.tenantId, runId: run.id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
      this.attachments.aggregate<{ _id: DataMigrationAttachmentRecord['status']; count: number }>([
        { $match: { tenantId: run.tenantId, runId: run.id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
    ]);
    const count = (status: DataMigrationItemRecord['status']) =>
      grouped.find((entry) => entry._id === status)?.count ?? 0;
    const associationCount = associationStatuses.reduce((sum, entry) => sum + entry.count, 0);
    const unresolvedAssociationCount = associationStatuses
      .find((entry) => entry._id === 'missing')?.count ?? 0;
    const attachmentCount = attachmentStatuses.reduce((sum, entry) => sum + entry.count, 0);
    const pendingAttachmentCount = ['pending', 'processing'].reduce(
      (sum, status) => sum + (attachmentStatuses.find((entry) => entry._id === status)?.count ?? 0),
      0,
    );
    const rejectedAttachmentCount = attachmentStatuses
      .find((entry) => entry._id === 'rejected')?.count ?? 0;
    const differences = [
      ...(run.checkpoint === run.expectedSourceCount ? [] : [{
        code: 'SOURCE_COUNT_MISMATCH', severity: 'critical' as const,
        count: Math.abs(run.expectedSourceCount - run.checkpoint),
      }]),
      ...(run.sourceChecksum === run.expectedSourceChecksum ? [] : [{
        code: 'SOURCE_CHECKSUM_MISMATCH', severity: 'critical' as const, count: 1,
      }]),
      ...(count('rejected') === 0 ? [] : [{
        code: 'REJECTED_RECORDS', severity: 'critical' as const, count: count('rejected'),
      }]),
      ...(unresolvedAssociationCount === 0 ? [] : [{
        code: 'ASSOCIATION_UNRESOLVED', severity: 'critical' as const,
        count: unresolvedAssociationCount,
      }]),
      ...(pendingAttachmentCount === 0 ? [] : [{
        code: 'ATTACHMENT_MIGRATION_PENDING', severity: 'high' as const,
        count: pendingAttachmentCount,
      }]),
      ...(rejectedAttachmentCount === 0 ? [] : [{
        code: 'ATTACHMENT_MIGRATION_REJECTED', severity: 'critical' as const,
        count: rejectedAttachmentCount,
      }]),
    ];
    return Object.freeze({
      runId: run.id, sourceSystem: run.sourceSystem, mode: run.mode, scope: run.scope,
      status: run.status, expectedSourceCount: run.expectedSourceCount, checkpoint: run.checkpoint,
      counts: Object.freeze({
        applied: count('applied'), duplicate: count('duplicate'), rejected: count('rejected'),
      }),
      sourceChecksum: run.sourceChecksum, expectedSourceChecksum: run.expectedSourceChecksum,
      targetChecksum: run.targetChecksum, associationCount, unresolvedAssociationCount,
      attachmentCount, pendingAttachmentCount,
      differences: Object.freeze(differences), phaseSixEligible: differences.length === 0,
    });
  }

  private async requireRunningRun(tenantId: string, runId: string) {
    const run = await this.runs.findOne({ tenantId, id: runId }).lean().exec();
    if (run === null) throw new NotFoundException({
      code: 'DATA_MIGRATION_RUN_NOT_FOUND', message: '迁移运行不存在',
    });
    if (run.status !== 'running') throw new ConflictException({
      code: 'DATA_MIGRATION_RUN_NOT_RUNNING', message: '迁移运行已结束',
    });
    return run;
  }

  private assertExecutor(scope?: DataMigrationScope): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      (scope !== undefined &&
        !actor.scopes.includes(DATA_MIGRATION_SCOPE_WRITE_SCOPE[scope]))) {
      throw new ForbiddenException({
      code: 'DATA_MIGRATION_EXECUTOR_FORBIDDEN', message: '当前身份无权执行数据迁移',
      });
    }
  }

  private assertReader(): void {
    if (!this.context.getActorRequired().scopes.includes('erp:migration:read')) {
      throw new ForbiddenException({
        code: 'DATA_MIGRATION_READER_FORBIDDEN', message: '当前身份无权读取迁移报告',
      });
    }
  }

  private assertEvidenceReader(): void {
    const scopes = this.context.getActorRequired().scopes;
    if (!scopes.includes('erp:migration:read') ||
      !scopes.includes('erp:migration:evidence:export')) throw new ForbiddenException({
      code: 'DATA_MIGRATION_EVIDENCE_FORBIDDEN', message: '当前身份无权导出迁移证据',
    });
  }
}

interface EvidenceCursor {
  readonly kind: DataMigrationEvidenceQueryDto['kind'];
  readonly sequence: number;
  readonly tieOne: string;
  readonly tieTwo: string;
}

interface EvidencePageResult {
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly nextCursor: string | null;
}

function encodeEvidenceCursor(
  input: Omit<EvidenceCursor, 'tieOne' | 'tieTwo'> &
    Partial<Pick<EvidenceCursor, 'tieOne' | 'tieTwo'>>,
): string {
  return Buffer.from(canonicalJson({
    kind: input.kind,
    sequence: input.sequence,
    tieOne: input.tieOne ?? '',
    tieTwo: input.tieTwo ?? '',
  }), 'utf8').toString('base64url');
}

function decodeEvidenceCursor(
  kind: DataMigrationEvidenceQueryDto['kind'],
  value: string | undefined,
): EvidenceCursor | null {
  if (value === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('shape');
    }
    const cursor = decoded as Record<string, unknown>;
    if (Object.keys(cursor).sort().join('|') !== 'kind|sequence|tieOne|tieTwo' ||
      cursor.kind !== kind || !Number.isSafeInteger(cursor.sequence) ||
      Number(cursor.sequence) < 1 || typeof cursor.tieOne !== 'string' ||
      typeof cursor.tieTwo !== 'string' ||
      (kind === 'items' && (cursor.tieOne !== '' || cursor.tieTwo !== '')) ||
      (kind === 'associations' &&
        (!ASSOCIATION_RELATIONSHIP_SET.has(cursor.tieOne) ||
          !SOURCE_ID_PATTERN.test(cursor.tieTwo))) ||
      (kind === 'attachments' &&
        (!SOURCE_ID_PATTERN.test(cursor.tieOne) || cursor.tieTwo !== ''))) {
      throw new Error('value');
    }
    return {
      kind,
      sequence: Number(cursor.sequence),
      tieOne: cursor.tieOne,
      tieTwo: cursor.tieTwo,
    };
  } catch {
    throw new BadRequestException({
      code: 'DATA_MIGRATION_EVIDENCE_CURSOR_INVALID', message: '迁移证据游标非法',
    });
  }
}

function itemEvidenceRecord(item: DataMigrationItemRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: item.id,
    sequence: item.sequence,
    sourceRecordId: item.sourceRecordId,
    sourceVersion: item.sourceVersion,
    entityType: item.entityType,
    payloadHash: item.payloadHash,
    sourceFactHash: item.sourceFactHash,
    status: item.status,
    targetId: item.targetId,
    targetVersion: item.targetVersion,
    targetHash: item.targetHash,
    rejectionCode: item.rejectionCode,
    associationCount: item.associationCount,
    attachmentCount: item.attachmentCount,
  });
}

function associationEvidenceRecord(
  item: DataMigrationAssociationRecord,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: item.id,
    sequence: item.sequence,
    relationship: item.relationship,
    sourceAssociationId: item.sourceAssociationId,
    targetId: item.targetId,
    status: item.status,
  });
}

function attachmentEvidenceRecord(
  item: DataMigrationAttachmentRecord,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: item.id,
    sequence: item.sequence,
    sourceAttachmentId: item.sourceAttachmentId,
    checksum: item.checksum,
    status: item.status,
    attempts: item.attempts,
    targetEvidenceId: item.targetEvidenceId,
    rejectionCode: item.rejectionCode,
  });
}

function publicRun(run: Pick<DataMigrationRunRecord,
  'id' | 'sourceSystem' | 'sourceRunId' | 'mode' | 'scope' | 'status' | 'checkpoint'
>) {
  return Object.freeze({
    id: run.id, sourceSystem: run.sourceSystem, sourceRunId: run.sourceRunId, mode: run.mode,
    scope: run.scope, status: run.status, checkpoint: run.checkpoint,
  });
}

function publicItem(item: Pick<DataMigrationItemRecord,
  'sequence' | 'sourceRecordId' | 'entityType' | 'status' | 'targetId' | 'targetVersion' | 'rejectionCode'
>) {
  return Object.freeze({
    sequence: item.sequence, sourceRecordId: item.sourceRecordId, entityType: item.entityType,
    status: item.status, targetId: item.targetId, targetVersion: item.targetVersion,
    rejectionCode: item.rejectionCode,
  });
}

function departmentPayload(value: Readonly<Record<string, unknown>>): {
  code: string; name: string; status: 'active' | 'inactive'; parentSourceId: string | null; sortOrder: number;
} {
  exactKeys(value, ['code', 'name', 'parentSourceId', 'sortOrder', 'status']);
  const status = value.status;
  if (typeof value.code !== 'string' || typeof value.name !== 'string' ||
    !['active', 'inactive'].includes(String(status)) ||
    (value.parentSourceId !== null && typeof value.parentSourceId !== 'string') ||
    !Number.isSafeInteger(value.sortOrder) || Number(value.sortOrder) < 0) throw invalidPayload();
  return {
    code: value.code, name: value.name, status: status as 'active' | 'inactive',
    parentSourceId: value.parentSourceId, sortOrder: Number(value.sortOrder),
  };
}

function positionPayload(value: Readonly<Record<string, unknown>>): CreatePositionDto {
  exactKeys(value, ['code', 'name', 'status']);
  if (typeof value.code !== 'string' || typeof value.name !== 'string' ||
    !['active', 'inactive'].includes(String(value.status))) throw invalidPayload();
  return { code: value.code, name: value.name, status: value.status as 'active' | 'inactive' };
}

function jobLevelPayload(value: Readonly<Record<string, unknown>>): CreateJobLevelDto {
  exactKeys(value, ['code', 'name', 'rank', 'track']);
  if (typeof value.code !== 'string' || typeof value.name !== 'string' ||
    !['professional', 'management'].includes(String(value.track)) ||
    !Number.isSafeInteger(value.rank) || Number(value.rank) < 1 || Number(value.rank) > 30) {
    throw invalidPayload();
  }
  return {
    code: value.code, name: value.name,
    track: value.track as 'professional' | 'management', rank: Number(value.rank),
  };
}

interface EmployeeMigrationPayload {
  readonly employeeNo: string;
  readonly displayName: string;
  readonly status: 'probation' | 'active' | 'suspended' | 'terminated';
  readonly departmentSourceIds: readonly string[];
  readonly primaryDepartmentSourceId: string;
  readonly positionSourceIds: readonly string[];
  readonly jobLevelSourceId: string | null;
}

type AssociationRelationship = DataMigrationAssociationRecord['relationship'];
type AssociationTargetType =
  | 'org.department'
  | 'org.position'
  | 'org.job_level'
  | 'org.employee'
  | 'approval.template'
  | 'approval.instance'
  | 'approval.history'
  | 'recruitment.requisition'
  | 'recruitment.position'
  | 'recruitment.candidate'
  | 'recruitment.application'
  | 'recruitment.interview';
interface AssociationEvidence {
  readonly relationship: AssociationRelationship;
  readonly sourceAssociationId: string;
  readonly entityType: AssociationTargetType | null;
}

function uniqueAssociationTargets(
  specs: readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[],
): readonly { readonly entityType: AssociationTargetType; readonly sourceAssociationId: string }[] {
  const unique = new Map<string, {
    readonly entityType: AssociationTargetType; readonly sourceAssociationId: string;
  }>();
  for (const spec of specs) unique.set(
    `${spec.entityType}:${spec.sourceAssociationId}`,
    { entityType: spec.entityType, sourceAssociationId: spec.sourceAssociationId },
  );
  return [...unique.values()];
}

function cachedTargetId(
  cache: Map<string, Promise<string>>,
  entityType: AssociationTargetType,
  sourceId: string,
  load: () => Promise<string>,
): Promise<string> {
  const key = `${entityType}:${sourceId}`;
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const pending = load();
  cache.set(key, pending);
  return pending;
}

function employeePayload(value: Readonly<Record<string, unknown>>): EmployeeMigrationPayload {
  exactKeys(value, [
    'departmentSourceIds', 'displayName', 'employeeNo', 'jobLevelSourceId',
    'positionSourceIds', 'primaryDepartmentSourceId', 'status',
  ]);
  const departments = stringSourceIds(value.departmentSourceIds, 1, 100);
  const positions = stringSourceIds(value.positionSourceIds, 0, 100);
  if (typeof value.employeeNo !== 'string' || typeof value.displayName !== 'string' ||
    !['probation', 'active', 'suspended', 'terminated'].includes(String(value.status)) ||
    typeof value.primaryDepartmentSourceId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.primaryDepartmentSourceId) ||
    (value.jobLevelSourceId !== null &&
      (typeof value.jobLevelSourceId !== 'string' || !SOURCE_ID_PATTERN.test(value.jobLevelSourceId))) ||
    !departments.includes(value.primaryDepartmentSourceId)) throw invalidPayload();
  return {
    employeeNo: value.employeeNo,
    displayName: value.displayName,
    status: value.status as EmployeeMigrationPayload['status'],
    departmentSourceIds: departments,
    primaryDepartmentSourceId: value.primaryDepartmentSourceId,
    positionSourceIds: positions,
    jobLevelSourceId: value.jobLevelSourceId,
  };
}

function stringSourceIds(value: unknown, minimum: number, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum ||
    value.some((item) => typeof item !== 'string' || !SOURCE_ID_PATTERN.test(item)) ||
    new Set(value).size !== value.length) throw invalidPayload();
  return value as string[];
}

function employeeAssociationSpecs(
  payload: EmployeeMigrationPayload,
): readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  return [
    ...payload.departmentSourceIds.map((sourceAssociationId) => ({
      relationship: 'department' as const,
      sourceAssociationId,
      entityType: 'org.department' as const,
    })),
    {
      relationship: 'primary_department' as const,
      sourceAssociationId: payload.primaryDepartmentSourceId,
      entityType: 'org.department' as const,
    },
    ...payload.positionSourceIds.map((sourceAssociationId) => ({
      relationship: 'position' as const,
      sourceAssociationId,
      entityType: 'org.position' as const,
    })),
    ...(payload.jobLevelSourceId === null ? [] : [{
      relationship: 'job_level' as const,
      sourceAssociationId: payload.jobLevelSourceId,
      entityType: 'org.job_level' as const,
    }]),
  ];
}

function employeeAssociationIds(payload: EmployeeMigrationPayload): readonly string[] {
  return [...new Set(employeeAssociationSpecs(payload).map((item) => item.sourceAssociationId))];
}

type EmploymentMigrationPayload = Omit<ImportEmploymentFromMigrationInput, 'employeeId'> & {
  readonly employeeSourceId: string;
};

function employmentPayload(
  value: Readonly<Record<string, unknown>>,
): EmploymentMigrationPayload {
  exactKeys(value, [
    'effectiveFrom', 'effectiveTo', 'employeeSourceId', 'identityEvidenceId',
    'offerId', 'onboardingCompletionEvidenceId', 'onboardingInstanceId',
    'signedEvidenceId', 'sourcePersonId', 'status', 'terminationCareCaseId',
    'terminationEvidenceId', 'terminationExecutionEvidenceId',
  ]);
  const requiredIds = [
    value.employeeSourceId, value.identityEvidenceId, value.offerId,
    value.onboardingCompletionEvidenceId, value.onboardingInstanceId,
    value.signedEvidenceId, value.sourcePersonId,
  ];
  const optionalIds = [
    value.terminationCareCaseId,
    value.terminationEvidenceId,
    value.terminationExecutionEvidenceId,
  ];
  if (requiredIds.some((item) => typeof item !== 'string' || !SOURCE_ID_PATTERN.test(item)) ||
    optionalIds.some((item) => item !== null &&
      (typeof item !== 'string' || !SOURCE_ID_PATTERN.test(item))) ||
    !['probation', 'active', 'suspended', 'resigned'].includes(String(value.status)) ||
    typeof value.effectiveFrom !== 'string' ||
    (value.effectiveTo !== null && typeof value.effectiveTo !== 'string')) throw invalidPayload();
  return {
    employeeSourceId: value.employeeSourceId as string,
    sourcePersonId: value.sourcePersonId as string,
    identityEvidenceId: value.identityEvidenceId as string,
    onboardingInstanceId: value.onboardingInstanceId as string,
    onboardingCompletionEvidenceId: value.onboardingCompletionEvidenceId as string,
    offerId: value.offerId as string,
    signedEvidenceId: value.signedEvidenceId as string,
    status: value.status as EmploymentMigrationPayload['status'],
    effectiveFrom: value.effectiveFrom,
    effectiveTo: value.effectiveTo,
    terminationCareCaseId: value.terminationCareCaseId as string | null,
    terminationExecutionEvidenceId: value.terminationExecutionEvidenceId as string | null,
    terminationEvidenceId: value.terminationEvidenceId as string | null,
  };
}

type ApprovalTemplateMigrationPayload = Omit<
  ImportApprovalTemplateFromMigrationInput,
  'createdByEmployeeId' | 'updatedByEmployeeId' | 'approvedByEmployeeId'
> & {
  readonly createdByEmployeeSourceId: string;
  readonly updatedByEmployeeSourceId: string;
  readonly approvedByEmployeeSourceId: string | null;
  readonly governanceEvidenceSourceAttachmentId: string | null;
};

type ApprovalLegacyHistoryMigrationPayload = Omit<
  ImportApprovalLegacyHistoryFromMigrationInput,
  'templateId' | 'initiatorEmployeeId' | 'migrationEvidenceRef' | 'evidenceChecksum'
> & {
  readonly templateSourceId: string;
  readonly initiatorEmployeeSourceId: string;
  readonly historyEvidenceSourceAttachmentId: string;
  readonly historyEvidenceChecksum: string;
};

function approvalLegacyHistoryPayload(
  value: Readonly<Record<string, unknown>>,
): ApprovalLegacyHistoryMigrationPayload {
  exactKeys(value, [
    'archivedAt', 'completedAt', 'historyEvidenceChecksum',
    'historyEvidenceSourceAttachmentId', 'initiatorEmployeeSourceId', 'outcome',
    'templateCode', 'templateRevision', 'templateSourceId',
  ]);
  const sourceIds = [
    value.templateSourceId,
    value.initiatorEmployeeSourceId,
    value.historyEvidenceSourceAttachmentId,
  ];
  if (sourceIds.some((item) => typeof item !== 'string' || !SOURCE_ID_PATTERN.test(item)) ||
    typeof value.templateCode !== 'string' ||
    !Number.isSafeInteger(value.templateRevision) || Number(value.templateRevision) < 1 ||
    !['approved', 'rejected', 'withdrawn'].includes(String(value.outcome)) ||
    !isStrictUtcIso(value.completedAt) ||
    (value.archivedAt !== null && !isStrictUtcIso(value.archivedAt)) ||
    typeof value.historyEvidenceChecksum !== 'string' ||
    !HASH_PATTERN.test(value.historyEvidenceChecksum)) throw invalidPayload();
  if (value.archivedAt !== null &&
    Date.parse(value.archivedAt) < Date.parse(value.completedAt)) {
    throw invalidPayload();
  }
  return {
    templateSourceId: value.templateSourceId as string,
    templateCode: value.templateCode,
    templateRevision: Number(value.templateRevision),
    initiatorEmployeeSourceId: value.initiatorEmployeeSourceId as string,
    outcome: value.outcome as ApprovalLegacyHistoryMigrationPayload['outcome'],
    completedAt: value.completedAt,
    archivedAt: value.archivedAt,
    historyEvidenceSourceAttachmentId: value.historyEvidenceSourceAttachmentId as string,
    historyEvidenceChecksum: value.historyEvidenceChecksum,
  };
}

function approvalLegacyHistoryAssociationSpecs(
  payload: ApprovalLegacyHistoryMigrationPayload,
): readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  return Object.freeze([
    {
      relationship: 'template',
      sourceAssociationId: payload.templateSourceId,
      entityType: 'approval.template',
    },
    {
      relationship: 'initiator',
      sourceAssociationId: payload.initiatorEmployeeSourceId,
      entityType: 'org.employee',
    },
  ]);
}

interface ApprovalActiveFormReference {
  readonly fieldKey: string;
  readonly entityType: 'org.employee' | 'org.department';
}

interface ApprovalActiveResolvedNode {
  readonly nodeId: string;
  readonly actorEmployeeSourceIds: readonly string[];
}

type ApprovalActiveMigrationAction =
  | {
      readonly type: 'submitted'; readonly actorEmployeeSourceId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'decided'; readonly actorEmployeeSourceId: string;
      readonly principalApproverEmployeeSourceId: string;
      readonly outcome: 'approved' | 'rejected'; readonly occurredAt: string;
    }
  | {
      readonly type: 'approver_transferred'; readonly actorEmployeeSourceId: string;
      readonly fromApproverEmployeeSourceId: string;
      readonly toApproverEmployeeSourceId: string; readonly occurredAt: string;
    }
  | {
      readonly type: 'approver_added'; readonly actorEmployeeSourceId: string;
      readonly approverEmployeeSourceId: string; readonly occurredAt: string;
    };

interface ApprovalActiveInstanceMigrationPayload {
  readonly templateSourceId: string;
  readonly templateCode: string;
  readonly templateRevision: number;
  readonly title: string;
  readonly initiatorEmployeeSourceId: string;
  readonly formData: ApprovalFormData;
  readonly formReferenceFields: readonly ApprovalActiveFormReference[];
  readonly resolvedNodes: readonly ApprovalActiveResolvedNode[];
  readonly actions: readonly ApprovalActiveMigrationAction[];
  readonly expectedStatus: 'draft' | 'running';
  readonly expectedVersion: number;
  readonly expectedCurrentNodeId: string | null;
  readonly expectedPendingApproverEmployeeSourceIds: readonly string[];
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
  readonly activityEvidenceSourceAttachmentId: string;
  readonly activityEvidenceChecksum: string;
}

function approvalActiveInstancePayload(
  value: Readonly<Record<string, unknown>>,
): ApprovalActiveInstanceMigrationPayload {
  exactKeys(value, [
    'actions', 'activityEvidenceChecksum', 'activityEvidenceSourceAttachmentId',
    'createdAt', 'expectedCurrentNodeId', 'expectedPendingApproverEmployeeSourceIds',
    'expectedStatus', 'expectedVersion', 'formData', 'formReferenceFields',
    'initiatorEmployeeSourceId', 'resolvedNodes', 'submittedAt', 'templateCode',
    'templateRevision', 'templateSourceId', 'title', 'updatedAt',
  ]);
  if (typeof value.templateSourceId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.templateSourceId) ||
    typeof value.initiatorEmployeeSourceId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.initiatorEmployeeSourceId) ||
    typeof value.activityEvidenceSourceAttachmentId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.activityEvidenceSourceAttachmentId) ||
    typeof value.activityEvidenceChecksum !== 'string' ||
    !HASH_PATTERN.test(value.activityEvidenceChecksum) ||
    typeof value.templateCode !== 'string' || !APPROVAL_CODE_PATTERN.test(value.templateCode) ||
    !Number.isSafeInteger(value.templateRevision) || Number(value.templateRevision) < 1 ||
    typeof value.title !== 'string' || value.title.trim().length < 1 || value.title.length > 256 ||
    !['draft', 'running'].includes(String(value.expectedStatus)) ||
    !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 ||
    (value.expectedCurrentNodeId !== null &&
      (typeof value.expectedCurrentNodeId !== 'string' ||
        !FIELD_KEY_PATTERN.test(value.expectedCurrentNodeId))) ||
    !isStrictUtcIso(value.createdAt) || !isStrictUtcIso(value.updatedAt) ||
    (value.submittedAt !== null && !isStrictUtcIso(value.submittedAt)) ||
    !isMigrationFormData(value.formData)) throw invalidPayload();
  const formReferenceFields = activeFormReferenceFields(value.formReferenceFields, value.formData);
  const resolvedNodes = activeResolvedNodes(value.resolvedNodes);
  const actions = activeMigrationActions(value.actions);
  const expectedPending = stringSourceIds(
    value.expectedPendingApproverEmployeeSourceIds,
    0,
    100,
  );
  return {
    templateSourceId: value.templateSourceId,
    templateCode: value.templateCode,
    templateRevision: Number(value.templateRevision),
    title: value.title,
    initiatorEmployeeSourceId: value.initiatorEmployeeSourceId,
    formData: value.formData,
    formReferenceFields,
    resolvedNodes,
    actions,
    expectedStatus: value.expectedStatus as 'draft' | 'running',
    expectedVersion: Number(value.expectedVersion),
    expectedCurrentNodeId: value.expectedCurrentNodeId,
    expectedPendingApproverEmployeeSourceIds: expectedPending,
    createdAt: value.createdAt,
    submittedAt: value.submittedAt,
    updatedAt: value.updatedAt,
    activityEvidenceSourceAttachmentId: value.activityEvidenceSourceAttachmentId,
    activityEvidenceChecksum: value.activityEvidenceChecksum,
  };
}

function activeFormReferenceFields(
  value: unknown,
  formData: ApprovalFormData,
): readonly ApprovalActiveFormReference[] {
  if (!Array.isArray(value) || value.length > 100) throw invalidPayload();
  const fields = value.map((item) => {
    if (!isPlainMigrationObject(item)) throw invalidPayload();
    exactKeys(item, ['entityType', 'fieldKey']);
    const fieldValue = typeof item.fieldKey === 'string' ? formData[item.fieldKey] : undefined;
    if (typeof item.fieldKey !== 'string' || !FIELD_KEY_PATTERN.test(item.fieldKey) ||
      !['org.employee', 'org.department'].includes(String(item.entityType)) ||
      typeof fieldValue !== 'string' || !SOURCE_ID_PATTERN.test(fieldValue)) throw invalidPayload();
    return {
      fieldKey: item.fieldKey,
      entityType: item.entityType as ApprovalActiveFormReference['entityType'],
    };
  });
  if (new Set(fields.map((field) => field.fieldKey)).size !== fields.length) throw invalidPayload();
  return fields;
}

function activeResolvedNodes(value: unknown): readonly ApprovalActiveResolvedNode[] {
  if (!Array.isArray(value) || value.length > 50) throw invalidPayload();
  const nodes = value.map((item) => {
    if (!isPlainMigrationObject(item)) throw invalidPayload();
    exactKeys(item, ['actorEmployeeSourceIds', 'nodeId']);
    if (typeof item.nodeId !== 'string' || !FIELD_KEY_PATTERN.test(item.nodeId)) {
      throw invalidPayload();
    }
    return {
      nodeId: item.nodeId,
      actorEmployeeSourceIds: stringSourceIds(item.actorEmployeeSourceIds, 0, 100),
    };
  });
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) throw invalidPayload();
  return nodes;
}

function activeMigrationActions(value: unknown): readonly ApprovalActiveMigrationAction[] {
  if (!Array.isArray(value) || value.length > 500) throw invalidPayload();
  return value.map((item) => activeMigrationAction(item));
}

function activeMigrationAction(value: unknown): ApprovalActiveMigrationAction {
  if (!isPlainMigrationObject(value) || typeof value.type !== 'string' ||
    typeof value.actorEmployeeSourceId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.actorEmployeeSourceId) ||
    !isStrictUtcIso(value.occurredAt)) throw invalidPayload();
  if (value.type === 'submitted') {
    exactKeys(value, ['actorEmployeeSourceId', 'occurredAt', 'type']);
    return {
      type: value.type,
      actorEmployeeSourceId: value.actorEmployeeSourceId,
      occurredAt: value.occurredAt,
    };
  }
  if (value.type === 'decided') {
    exactKeys(value, [
      'actorEmployeeSourceId', 'occurredAt', 'outcome',
      'principalApproverEmployeeSourceId', 'type',
    ]);
    if (typeof value.principalApproverEmployeeSourceId !== 'string' ||
      !SOURCE_ID_PATTERN.test(value.principalApproverEmployeeSourceId) ||
      !['approved', 'rejected'].includes(String(value.outcome))) throw invalidPayload();
    return {
      type: value.type,
      actorEmployeeSourceId: value.actorEmployeeSourceId,
      principalApproverEmployeeSourceId: value.principalApproverEmployeeSourceId,
      outcome: value.outcome as 'approved' | 'rejected',
      occurredAt: value.occurredAt,
    };
  }
  if (value.type === 'approver_transferred') {
    exactKeys(value, [
      'actorEmployeeSourceId', 'fromApproverEmployeeSourceId', 'occurredAt',
      'toApproverEmployeeSourceId', 'type',
    ]);
    if (typeof value.fromApproverEmployeeSourceId !== 'string' ||
      !SOURCE_ID_PATTERN.test(value.fromApproverEmployeeSourceId) ||
      typeof value.toApproverEmployeeSourceId !== 'string' ||
      !SOURCE_ID_PATTERN.test(value.toApproverEmployeeSourceId)) throw invalidPayload();
    return {
      type: value.type,
      actorEmployeeSourceId: value.actorEmployeeSourceId,
      fromApproverEmployeeSourceId: value.fromApproverEmployeeSourceId,
      toApproverEmployeeSourceId: value.toApproverEmployeeSourceId,
      occurredAt: value.occurredAt,
    };
  }
  if (value.type === 'approver_added') {
    exactKeys(value, [
      'actorEmployeeSourceId', 'approverEmployeeSourceId', 'occurredAt', 'type',
    ]);
    if (typeof value.approverEmployeeSourceId !== 'string' ||
      !SOURCE_ID_PATTERN.test(value.approverEmployeeSourceId)) throw invalidPayload();
    return {
      type: value.type,
      actorEmployeeSourceId: value.actorEmployeeSourceId,
      approverEmployeeSourceId: value.approverEmployeeSourceId,
      occurredAt: value.occurredAt,
    };
  }
  throw invalidPayload();
}

function approvalActiveInstanceAssociationSpecs(
  payload: ApprovalActiveInstanceMigrationPayload,
): readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  const specs: (AssociationEvidence & { readonly entityType: AssociationTargetType })[] = [
    {
      relationship: 'template', sourceAssociationId: payload.templateSourceId,
      entityType: 'approval.template',
    },
    {
      relationship: 'initiator', sourceAssociationId: payload.initiatorEmployeeSourceId,
      entityType: 'org.employee',
    },
  ];
  for (const field of payload.formReferenceFields) specs.push({
    relationship: field.entityType === 'org.employee' ? 'form_employee' : 'form_department',
    sourceAssociationId: payload.formData[field.fieldKey] as string,
    entityType: field.entityType,
  });
  for (const node of payload.resolvedNodes) {
    for (const sourceAssociationId of node.actorEmployeeSourceIds) specs.push({
      relationship: 'resolved_approver', sourceAssociationId, entityType: 'org.employee',
    });
  }
  for (const action of payload.actions) specs.push(...activeActionAssociationSpecs(action));
  for (const sourceAssociationId of payload.expectedPendingApproverEmployeeSourceIds) specs.push({
    relationship: 'expected_pending_approver', sourceAssociationId, entityType: 'org.employee',
  });
  const unique = new Map<string, typeof specs[number]>();
  for (const spec of specs) unique.set(
    `${spec.relationship}:${spec.entityType}:${spec.sourceAssociationId}`,
    spec,
  );
  return [...unique.values()];
}

function activeActionAssociationSpecs(
  action: ApprovalActiveMigrationAction,
): (AssociationEvidence & { readonly entityType: 'org.employee' })[] {
  const specs: (AssociationEvidence & { readonly entityType: 'org.employee' })[] = [{
    relationship: 'action_actor',
    sourceAssociationId: action.actorEmployeeSourceId,
    entityType: 'org.employee',
  }];
  if (action.type === 'decided') specs.push({
    relationship: 'principal_approver',
    sourceAssociationId: action.principalApproverEmployeeSourceId,
    entityType: 'org.employee',
  });
  else if (action.type === 'approver_transferred') specs.push(
    {
      relationship: 'transfer_from', sourceAssociationId: action.fromApproverEmployeeSourceId,
      entityType: 'org.employee',
    },
    {
      relationship: 'transfer_to', sourceAssociationId: action.toApproverEmployeeSourceId,
      entityType: 'org.employee',
    },
  );
  else if (action.type === 'approver_added') specs.push({
    relationship: 'added_approver', sourceAssociationId: action.approverEmployeeSourceId,
    entityType: 'org.employee',
  });
  return specs;
}

async function mapActiveApprovalFormData(
  payload: ApprovalActiveInstanceMigrationPayload,
  resolve: (
    entityType: 'org.employee' | 'org.department',
    sourceId: string,
  ) => Promise<string>,
): Promise<ApprovalFormData> {
  const formData = structuredClone(payload.formData) as Record<string, ApprovalFormValue>;
  await Promise.all(payload.formReferenceFields.map(async (field) => {
    const sourceId = formData[field.fieldKey];
    if (typeof sourceId !== 'string') throw invalidPayload();
    formData[field.fieldKey] = await resolve(field.entityType, sourceId);
  }));
  return formData;
}

async function mapActiveApprovalAction(
  action: ApprovalActiveMigrationAction,
  employeeId: (sourceId: string) => Promise<string>,
): Promise<ImportApprovalActiveActionFromMigration> {
  const actorEmployeeId = await employeeId(action.actorEmployeeSourceId);
  if (action.type === 'submitted') return {
    type: action.type,
    actorEmployeeId,
    occurredAt: action.occurredAt,
  };
  if (action.type === 'decided') return {
    type: action.type,
    actorEmployeeId,
    principalApproverEmployeeId: await employeeId(action.principalApproverEmployeeSourceId),
    outcome: action.outcome,
    occurredAt: action.occurredAt,
  };
  if (action.type === 'approver_transferred') return {
    type: action.type,
    actorEmployeeId,
    fromApproverEmployeeId: await employeeId(action.fromApproverEmployeeSourceId),
    toApproverEmployeeId: await employeeId(action.toApproverEmployeeSourceId),
    occurredAt: action.occurredAt,
  };
  return {
    type: action.type,
    actorEmployeeId,
    approverEmployeeId: await employeeId(action.approverEmployeeSourceId),
    occurredAt: action.occurredAt,
  };
}

interface RecruitmentRequisitionMigrationPayload {
  readonly departmentSourceId: string;
  readonly positionTitle: string;
  readonly headcount: number;
  readonly justification: string;
  readonly status: ImportRecruitmentRequisitionFromMigrationInput['status'];
  readonly approvalReferenceType: 'approval.instance' | 'approval.history' | null;
  readonly approvalReferenceSourceId: string | null;
  readonly version: number;
  readonly createdByEmployeeSourceId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly governanceEvidenceSourceAttachmentId: string;
  readonly governanceEvidenceChecksum: string;
}

function recruitmentRequisitionPayload(
  value: Readonly<Record<string, unknown>>,
): RecruitmentRequisitionMigrationPayload {
  exactKeys(value, [
    'approvalReferenceSourceId', 'approvalReferenceType', 'createdAt',
    'createdByEmployeeSourceId', 'departmentSourceId', 'governanceEvidenceChecksum',
    'governanceEvidenceSourceAttachmentId', 'headcount', 'justification',
    'positionTitle', 'status', 'updatedAt', 'version',
  ]);
  const sourceIds = [
    value.departmentSourceId,
    value.createdByEmployeeSourceId,
    value.governanceEvidenceSourceAttachmentId,
  ];
  if (sourceIds.some((item) => typeof item !== 'string' || !SOURCE_ID_PATTERN.test(item)) ||
    (value.approvalReferenceSourceId !== null &&
      (typeof value.approvalReferenceSourceId !== 'string' ||
        !SOURCE_ID_PATTERN.test(value.approvalReferenceSourceId))) ||
    typeof value.positionTitle !== 'string' || value.positionTitle.trim().length < 1 ||
    value.positionTitle.length > 128 ||
    typeof value.justification !== 'string' || value.justification.trim().length < 1 ||
    value.justification.length > 4_096 ||
    !Number.isSafeInteger(value.headcount) || Number(value.headcount) < 1 ||
    Number(value.headcount) > 10_000 ||
    !['draft', 'pending_approval', 'approved', 'rejected', 'closed'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
    !isStrictUtcIso(value.createdAt) || !isStrictUtcIso(value.updatedAt) ||
    typeof value.governanceEvidenceChecksum !== 'string' ||
    !HASH_PATTERN.test(value.governanceEvidenceChecksum)) throw invalidPayload();
  const expectedReferenceType = value.status === 'draft'
    ? null
    : value.status === 'pending_approval'
      ? 'approval.instance'
      : 'approval.history';
  if (value.approvalReferenceType !== expectedReferenceType ||
    (expectedReferenceType === null) !== (value.approvalReferenceSourceId === null)) {
    throw invalidPayload();
  }
  return {
    departmentSourceId: value.departmentSourceId as string,
    positionTitle: value.positionTitle,
    headcount: Number(value.headcount),
    justification: value.justification,
    status: value.status as RecruitmentRequisitionMigrationPayload['status'],
    approvalReferenceType: expectedReferenceType,
    approvalReferenceSourceId: value.approvalReferenceSourceId,
    version: Number(value.version),
    createdByEmployeeSourceId: value.createdByEmployeeSourceId as string,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    governanceEvidenceSourceAttachmentId:
      value.governanceEvidenceSourceAttachmentId as string,
    governanceEvidenceChecksum: value.governanceEvidenceChecksum,
  };
}

function recruitmentRequisitionAssociationSpecs(
  payload: RecruitmentRequisitionMigrationPayload,
): readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  return [
    {
      relationship: 'department', sourceAssociationId: payload.departmentSourceId,
      entityType: 'org.department',
    },
    {
      relationship: 'created_by', sourceAssociationId: payload.createdByEmployeeSourceId,
      entityType: 'org.employee',
    },
    ...(payload.approvalReferenceType === null || payload.approvalReferenceSourceId === null
      ? []
      : [{
          relationship: payload.approvalReferenceType === 'approval.instance'
            ? 'approval_instance' as const
            : 'approval_history' as const,
          sourceAssociationId: payload.approvalReferenceSourceId,
          entityType: payload.approvalReferenceType,
        }]),
  ];
}

interface RecruitmentPositionMigrationPayload {
  readonly requisitionSourceId: string;
  readonly departmentSourceId: string;
  readonly jobLevelSourceId: string;
  readonly title: string;
  readonly location: string;
  readonly headcount: number;
  readonly status: ImportRecruitmentPositionFromMigrationInput['status'];
  readonly version: number;
  readonly publishedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly governanceEvidenceSourceAttachmentId: string;
  readonly governanceEvidenceChecksum: string;
}

function recruitmentPositionPayload(
  value: Readonly<Record<string, unknown>>,
): RecruitmentPositionMigrationPayload {
  exactKeys(value, [
    'closedAt', 'createdAt', 'departmentSourceId', 'governanceEvidenceChecksum',
    'governanceEvidenceSourceAttachmentId', 'headcount', 'jobLevelSourceId', 'location',
    'publishedAt', 'requisitionSourceId', 'status', 'title', 'updatedAt', 'version',
  ]);
  const sourceIds = [
    value.requisitionSourceId,
    value.departmentSourceId,
    value.jobLevelSourceId,
    value.governanceEvidenceSourceAttachmentId,
  ];
  if (sourceIds.some((item) => typeof item !== 'string' || !SOURCE_ID_PATTERN.test(item)) ||
    typeof value.title !== 'string' || value.title.trim().length < 1 || value.title.length > 128 ||
    typeof value.location !== 'string' || value.location.trim().length < 1 ||
    value.location.length > 128 ||
    !Number.isSafeInteger(value.headcount) || Number(value.headcount) < 1 ||
    Number(value.headcount) > 10_000 ||
    !['draft', 'open', 'paused', 'closed'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
    !isStrictUtcIso(value.createdAt) || !isStrictUtcIso(value.updatedAt) ||
    (value.publishedAt !== null && !isStrictUtcIso(value.publishedAt)) ||
    (value.closedAt !== null && !isStrictUtcIso(value.closedAt)) ||
    typeof value.governanceEvidenceChecksum !== 'string' ||
    !HASH_PATTERN.test(value.governanceEvidenceChecksum)) throw invalidPayload();
  return {
    requisitionSourceId: value.requisitionSourceId as string,
    departmentSourceId: value.departmentSourceId as string,
    jobLevelSourceId: value.jobLevelSourceId as string,
    title: value.title,
    location: value.location,
    headcount: Number(value.headcount),
    status: value.status as RecruitmentPositionMigrationPayload['status'],
    version: Number(value.version),
    publishedAt: value.publishedAt,
    closedAt: value.closedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    governanceEvidenceSourceAttachmentId:
      value.governanceEvidenceSourceAttachmentId as string,
    governanceEvidenceChecksum: value.governanceEvidenceChecksum,
  };
}

function recruitmentPositionAssociationSpecs(
  payload: RecruitmentPositionMigrationPayload,
): readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  return Object.freeze([
    {
      relationship: 'requisition', sourceAssociationId: payload.requisitionSourceId,
      entityType: 'recruitment.requisition',
    },
    {
      relationship: 'department', sourceAssociationId: payload.departmentSourceId,
      entityType: 'org.department',
    },
    {
      relationship: 'job_level', sourceAssociationId: payload.jobLevelSourceId,
      entityType: 'org.job_level',
    },
  ]);
}

type RecruitmentCandidateMigrationPayload = Omit<
  ImportRecruitmentCandidateFromMigrationInput,
  'targetId' | 'migrationEvidenceRef' | 'evidenceChecksum'
> & {
  readonly candidateEvidenceSourceAttachmentId: string;
  readonly candidateEvidenceChecksum: string;
};

function recruitmentCandidatePayload(
  value: Readonly<Record<string, unknown>>,
): RecruitmentCandidateMigrationPayload {
  exactKeys(value, [
    'candidateEvidenceChecksum', 'candidateEvidenceSourceAttachmentId', 'consentCapturedAt',
    'consentExpiresAt', 'consentPurpose', 'consentVersion', 'consentWithdrawnAt',
    'createdAt', 'email', 'name', 'phone', 'retentionExpiresAt', 'status', 'updatedAt', 'version',
  ]);
  const nullableIdentity = [value.name, value.phone, value.email];
  if (typeof value.candidateEvidenceSourceAttachmentId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.candidateEvidenceSourceAttachmentId) ||
    typeof value.candidateEvidenceChecksum !== 'string' ||
    !HASH_PATTERN.test(value.candidateEvidenceChecksum) ||
    !['active', 'consent_withdrawn', 'anonymized'].includes(String(value.status)) ||
    nullableIdentity.some((item) => item !== null && typeof item !== 'string') ||
    typeof value.consentVersion !== 'string' || typeof value.consentPurpose !== 'string' ||
    !isStrictUtcIso(value.consentCapturedAt) || !isStrictUtcIso(value.consentExpiresAt) ||
    (value.consentWithdrawnAt !== null && !isStrictUtcIso(value.consentWithdrawnAt)) ||
    !isStrictUtcIso(value.retentionExpiresAt) || !isStrictUtcIso(value.createdAt) ||
    !isStrictUtcIso(value.updatedAt) || !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1) throw invalidPayload();
  return {
    status: value.status as RecruitmentCandidateMigrationPayload['status'],
    name: value.name as string | null,
    phone: value.phone as string | null,
    email: value.email as string | null,
    consentVersion: value.consentVersion,
    consentPurpose: value.consentPurpose,
    consentCapturedAt: value.consentCapturedAt,
    consentExpiresAt: value.consentExpiresAt,
    consentWithdrawnAt: value.consentWithdrawnAt,
    retentionExpiresAt: value.retentionExpiresAt,
    version: Number(value.version),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    candidateEvidenceSourceAttachmentId:
      value.candidateEvidenceSourceAttachmentId,
    candidateEvidenceChecksum: value.candidateEvidenceChecksum,
  };
}

type RecruitmentApplicationMigrationPayload = Omit<
  ImportRecruitmentApplicationBaselineFromMigrationInput,
  'targetId' | 'candidateId' | 'positionId' | 'migrationEvidenceRef' | 'evidenceChecksum'
> & {
  readonly candidateSourceId: string;
  readonly positionSourceId: string;
  readonly applicationEvidenceSourceAttachmentId: string;
  readonly applicationEvidenceChecksum: string;
};

function recruitmentApplicationPayload(
  value: Readonly<Record<string, unknown>>,
): RecruitmentApplicationMigrationPayload {
  exactKeys(value, [
    'actions', 'appliedAt', 'applicationEvidenceChecksum',
    'applicationEvidenceSourceAttachmentId', 'candidateSourceId', 'endedAt',
    'expectedStage', 'expectedVersion', 'positionSourceId', 'sourceChannel', 'updatedAt',
  ]);
  if (typeof value.candidateSourceId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.candidateSourceId) ||
    typeof value.positionSourceId !== 'string' || !SOURCE_ID_PATTERN.test(value.positionSourceId) ||
    typeof value.applicationEvidenceSourceAttachmentId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.applicationEvidenceSourceAttachmentId) ||
    typeof value.applicationEvidenceChecksum !== 'string' ||
    !HASH_PATTERN.test(value.applicationEvidenceChecksum) ||
    typeof value.sourceChannel !== 'string' || !APPROVAL_CODE_PATTERN.test(value.sourceChannel) ||
    !['applied', 'screening', 'interview', 'rejected', 'withdrawn']
      .includes(String(value.expectedStage)) ||
    !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 ||
    !isStrictUtcIso(value.appliedAt) || !isStrictUtcIso(value.updatedAt) ||
    (value.endedAt !== null && !isStrictUtcIso(value.endedAt)) || !Array.isArray(value.actions) ||
    value.actions.length > 20) throw invalidPayload();
  const actions = value.actions.map((action) => recruitmentApplicationAction(action));
  return {
    candidateSourceId: value.candidateSourceId,
    positionSourceId: value.positionSourceId,
    sourceChannel: value.sourceChannel,
    actions,
    expectedStage:
      value.expectedStage as RecruitmentApplicationMigrationPayload['expectedStage'],
    expectedVersion: Number(value.expectedVersion),
    appliedAt: value.appliedAt,
    endedAt: value.endedAt,
    updatedAt: value.updatedAt,
    applicationEvidenceSourceAttachmentId: value.applicationEvidenceSourceAttachmentId,
    applicationEvidenceChecksum: value.applicationEvidenceChecksum,
  };
}

function recruitmentApplicationAction(
  value: unknown,
): RecruitmentApplicationMigrationPayload['actions'][number] {
  if (!isPlainMigrationObject(value)) throw invalidPayload();
  exactKeys(value, ['occurredAt', 'reasonCode', 'targetStage']);
  if (!['screening', 'interview', 'rejected', 'withdrawn'].includes(String(value.targetStage)) ||
    (value.reasonCode !== null &&
      (typeof value.reasonCode !== 'string' || !APPROVAL_CODE_PATTERN.test(value.reasonCode))) ||
    !isStrictUtcIso(value.occurredAt)) throw invalidPayload();
  return {
    targetStage: value.targetStage as RecruitmentApplicationMigrationPayload['actions'][number]['targetStage'],
    reasonCode: value.reasonCode,
    occurredAt: value.occurredAt,
  };
}

function recruitmentApplicationAssociationSpecs(
  payload: RecruitmentApplicationMigrationPayload,
): readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  return Object.freeze([
    {
      relationship: 'candidate', sourceAssociationId: payload.candidateSourceId,
      entityType: 'recruitment.candidate',
    },
    {
      relationship: 'position', sourceAssociationId: payload.positionSourceId,
      entityType: 'recruitment.position',
    },
  ]);
}

type RecruitmentInterviewMigrationPayload = Omit<
  ImportRecruitmentInterviewFromMigrationInput,
  | 'targetId'
  | 'applicationId'
  | 'interviewerIds'
  | 'createdByEmployeeId'
  | 'feedback'
  | 'migrationEvidenceRef'
  | 'evidenceChecksum'
> & {
  readonly applicationSourceId: string;
  readonly interviewerEmployeeSourceIds: readonly string[];
  readonly createdByEmployeeSourceId: string;
  readonly feedback: readonly {
    readonly interviewerEmployeeSourceId: string;
    readonly recommendation: ImportRecruitmentInterviewFromMigrationInput['feedback'][number]['recommendation'];
    readonly score: number;
    readonly notes: string;
    readonly submittedAt: string;
  }[];
  readonly interviewEvidenceSourceAttachmentId: string;
  readonly interviewEvidenceChecksum: string;
};

function recruitmentInterviewPayload(
  value: Readonly<Record<string, unknown>>,
): RecruitmentInterviewMigrationPayload {
  exactKeys(value, [
    'applicationSourceId', 'cancelledAt', 'completedAt', 'createdAt',
    'createdByEmployeeSourceId', 'endsAt', 'expectedStatus', 'expectedVersion', 'feedback',
    'interviewEvidenceChecksum', 'interviewEvidenceSourceAttachmentId',
    'interviewerEmployeeSourceIds', 'location', 'mode', 'roundNumber', 'startsAt',
    'timezone', 'updatedAt',
  ]);
  const interviewerEmployeeSourceIds = stringSourceIds(
    value.interviewerEmployeeSourceIds, 1, 20,
  );
  if (typeof value.applicationSourceId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.applicationSourceId) ||
    typeof value.createdByEmployeeSourceId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.createdByEmployeeSourceId) ||
    typeof value.interviewEvidenceSourceAttachmentId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.interviewEvidenceSourceAttachmentId) ||
    typeof value.interviewEvidenceChecksum !== 'string' ||
    !HASH_PATTERN.test(value.interviewEvidenceChecksum) ||
    !Number.isSafeInteger(value.roundNumber) || Number(value.roundNumber) < 1 ||
    Number(value.roundNumber) > 100 ||
    !['phone', 'video', 'onsite'].includes(String(value.mode)) ||
    typeof value.timezone !== 'string' ||
    !/^(?:UTC|[A-Za-z_]+\/[A-Za-z0-9_+.-]+)$/.test(value.timezone) ||
    typeof value.location !== 'string' || value.location.trim().length < 1 ||
    value.location.length > 2_048 ||
    !['scheduled', 'completed', 'cancelled'].includes(String(value.expectedStatus)) ||
    !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 ||
    !isStrictUtcIso(value.startsAt) || !isStrictUtcIso(value.endsAt) ||
    !isStrictUtcIso(value.createdAt) || !isStrictUtcIso(value.updatedAt) ||
    (value.completedAt !== null && !isStrictUtcIso(value.completedAt)) ||
    (value.cancelledAt !== null && !isStrictUtcIso(value.cancelledAt)) ||
    !Array.isArray(value.feedback) || value.feedback.length > 20) throw invalidPayload();
  const feedback = value.feedback.map((item) => recruitmentInterviewFeedbackPayload(item));
  if (new Set(interviewerEmployeeSourceIds).size !== interviewerEmployeeSourceIds.length ||
    feedback.some((item) =>
      !interviewerEmployeeSourceIds.includes(item.interviewerEmployeeSourceId)) ||
    new Set(feedback.map((item) => item.interviewerEmployeeSourceId)).size !== feedback.length) {
    throw invalidPayload();
  }
  return {
    applicationSourceId: value.applicationSourceId,
    roundNumber: Number(value.roundNumber),
    mode: value.mode as RecruitmentInterviewMigrationPayload['mode'],
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    timezone: value.timezone,
    interviewerEmployeeSourceIds,
    location: value.location,
    createdByEmployeeSourceId: value.createdByEmployeeSourceId,
    feedback,
    expectedStatus: value.expectedStatus as RecruitmentInterviewMigrationPayload['expectedStatus'],
    expectedVersion: Number(value.expectedVersion),
    completedAt: value.completedAt,
    cancelledAt: value.cancelledAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    interviewEvidenceSourceAttachmentId: value.interviewEvidenceSourceAttachmentId,
    interviewEvidenceChecksum: value.interviewEvidenceChecksum,
  };
}

function recruitmentInterviewFeedbackPayload(
  value: unknown,
): RecruitmentInterviewMigrationPayload['feedback'][number] {
  if (!isPlainMigrationObject(value)) throw invalidPayload();
  exactKeys(value, [
    'interviewerEmployeeSourceId', 'notes', 'recommendation', 'score', 'submittedAt',
  ]);
  if (typeof value.interviewerEmployeeSourceId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.interviewerEmployeeSourceId) ||
    !['strong_hire', 'hire', 'no_hire', 'strong_no_hire']
      .includes(String(value.recommendation)) ||
    !Number.isSafeInteger(value.score) || Number(value.score) < 1 || Number(value.score) > 5 ||
    typeof value.notes !== 'string' || value.notes.trim().length < 1 ||
    value.notes.length > 8_192 || !isStrictUtcIso(value.submittedAt)) throw invalidPayload();
  return {
    interviewerEmployeeSourceId: value.interviewerEmployeeSourceId,
    recommendation: value.recommendation as RecruitmentInterviewMigrationPayload['feedback'][number]['recommendation'],
    score: Number(value.score),
    notes: value.notes,
    submittedAt: value.submittedAt,
  };
}

function recruitmentInterviewAssociationSpecs(
  payload: RecruitmentInterviewMigrationPayload,
): readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  return Object.freeze([
    {
      relationship: 'application',
      sourceAssociationId: payload.applicationSourceId,
      entityType: 'recruitment.application',
    },
    {
      relationship: 'created_by',
      sourceAssociationId: payload.createdByEmployeeSourceId,
      entityType: 'org.employee',
    },
    ...payload.interviewerEmployeeSourceIds.map((sourceAssociationId) => ({
      relationship: 'interviewer' as const,
      sourceAssociationId,
      entityType: 'org.employee' as const,
    })),
  ]);
}

type RecruitmentOfferMigrationPayload = Omit<
  ImportRecruitmentOfferFromMigrationInput,
  | 'targetId'
  | 'applicationId'
  | 'completedInterviewId'
  | 'createdByEmployeeId'
  | 'approvalReferenceType'
  | 'approvalReferenceId'
  | 'migrationEvidenceRef'
  | 'evidenceChecksum'
> & {
  readonly applicationSourceId: string;
  readonly completedInterviewSourceId: string;
  readonly createdByEmployeeSourceId: string;
  readonly approvalReferenceType: 'approval.instance' | 'approval.history' | null;
  readonly approvalReferenceSourceId: string | null;
  readonly offerEvidenceSourceAttachmentId: string;
  readonly offerEvidenceChecksum: string;
};

function recruitmentOfferPayload(
  value: Readonly<Record<string, unknown>>,
): RecruitmentOfferMigrationPayload {
  exactKeys(value, [
    'applicationActions', 'applicationBaselineUpdatedAt', 'applicationBaselineVersion',
    'applicationEndedAt', 'applicationSourceId', 'applicationUpdatedAt',
    'approvalReferenceSourceId', 'approvalReferenceType', 'completedInterviewSourceId',
    'createdAt', 'createdByEmployeeSourceId', 'decisionProof', 'expectedApplicationStage',
    'expectedApplicationVersion', 'expiresAt', 'offerEvidenceChecksum',
    'offerEvidenceSourceAttachmentId', 'retentionExpiresAt', 'sendRequested', 'sentProof',
    'signedProof', 'status', 'terms', 'updatedAt', 'version',
  ]);
  const sourceIds = [
    value.applicationSourceId, value.completedInterviewSourceId,
    value.createdByEmployeeSourceId, value.offerEvidenceSourceAttachmentId,
  ];
  if (sourceIds.some((item) => typeof item !== 'string' || !SOURCE_ID_PATTERN.test(item)) ||
    (value.approvalReferenceSourceId !== null &&
      (typeof value.approvalReferenceSourceId !== 'string' ||
        !SOURCE_ID_PATTERN.test(value.approvalReferenceSourceId))) ||
    !['draft', 'pending_approval', 'approved', 'rejected', 'sending', 'sent', 'accepted',
      'declined', 'expired', 'cancelled', 'signed'].includes(String(value.status)) ||
    typeof value.sendRequested !== 'boolean' ||
    !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
    !Number.isSafeInteger(value.applicationBaselineVersion) ||
    Number(value.applicationBaselineVersion) < 1 ||
    !Number.isSafeInteger(value.expectedApplicationVersion) ||
    Number(value.expectedApplicationVersion) < 1 ||
    !['interview', 'offer_approval', 'offer_sent', 'offer_accepted', 'rejected', 'withdrawn']
      .includes(String(value.expectedApplicationStage)) ||
    !isStrictUtcIso(value.expiresAt) || !isStrictUtcIso(value.retentionExpiresAt) ||
    !isStrictUtcIso(value.createdAt) || !isStrictUtcIso(value.updatedAt) ||
    !isStrictUtcIso(value.applicationBaselineUpdatedAt) ||
    !isStrictUtcIso(value.applicationUpdatedAt) ||
    (value.applicationEndedAt !== null && !isStrictUtcIso(value.applicationEndedAt)) ||
    typeof value.offerEvidenceChecksum !== 'string' ||
    !HASH_PATTERN.test(value.offerEvidenceChecksum) || !Array.isArray(value.applicationActions) ||
    value.applicationActions.length > 5 || !isPlainMigrationObject(value.terms)) {
    throw invalidPayload();
  }
  const expectedApprovalType = value.status === 'draft'
    ? null
    : value.status === 'pending_approval'
      ? 'approval.instance'
      : 'approval.history';
  if (value.approvalReferenceType !== expectedApprovalType ||
    (expectedApprovalType === null) !== (value.approvalReferenceSourceId === null)) {
    throw invalidPayload();
  }
  return {
    applicationSourceId: value.applicationSourceId as string,
    completedInterviewSourceId: value.completedInterviewSourceId as string,
    createdByEmployeeSourceId: value.createdByEmployeeSourceId as string,
    terms: recruitmentOfferTermsPayload(value.terms),
    expiresAt: value.expiresAt,
    retentionExpiresAt: value.retentionExpiresAt,
    status: value.status as RecruitmentOfferMigrationPayload['status'],
    approvalReferenceType: expectedApprovalType,
    approvalReferenceSourceId: value.approvalReferenceSourceId,
    sendRequested: value.sendRequested,
    sentProof: recruitmentOfferProofPayload(value.sentProof),
    decisionProof: recruitmentOfferDecisionProofPayload(value.decisionProof),
    signedProof: recruitmentOfferProofPayload(value.signedProof),
    version: Number(value.version),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    applicationBaselineVersion: Number(value.applicationBaselineVersion),
    applicationBaselineUpdatedAt: value.applicationBaselineUpdatedAt,
    applicationActions: value.applicationActions.map(recruitmentOfferApplicationAction),
    expectedApplicationStage:
      value.expectedApplicationStage as RecruitmentOfferMigrationPayload['expectedApplicationStage'],
    expectedApplicationVersion: Number(value.expectedApplicationVersion),
    applicationEndedAt: value.applicationEndedAt,
    applicationUpdatedAt: value.applicationUpdatedAt,
    offerEvidenceSourceAttachmentId: value.offerEvidenceSourceAttachmentId as string,
    offerEvidenceChecksum: value.offerEvidenceChecksum,
  };
}

function recruitmentOfferTermsPayload(
  value: Readonly<Record<string, unknown>>,
): ImportRecruitmentOfferFromMigrationInput['terms'] {
  exactKeys(value, [
    'annualVariableTargetMinor', 'benefitsSummary', 'currency', 'employmentType',
    'monthlyBaseSalaryMinor', 'probationMonths', 'proposedStartDate', 'salaryMonths',
    'signingBonusMinor', 'workLocation',
  ]);
  if (value.currency !== 'CNY' ||
    !Number.isSafeInteger(value.monthlyBaseSalaryMinor) ||
    Number(value.monthlyBaseSalaryMinor) < 1 ||
    !Number.isSafeInteger(value.annualVariableTargetMinor) ||
    Number(value.annualVariableTargetMinor) < 0 ||
    !Number.isSafeInteger(value.signingBonusMinor) || Number(value.signingBonusMinor) < 0 ||
    !Number.isSafeInteger(value.salaryMonths) || Number(value.salaryMonths) < 1 ||
    Number(value.salaryMonths) > 24 || !Number.isSafeInteger(value.probationMonths) ||
    Number(value.probationMonths) < 0 || Number(value.probationMonths) > 12 ||
    typeof value.proposedStartDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.proposedStartDate) ||
    typeof value.employmentType !== 'string' ||
    !APPROVAL_CODE_PATTERN.test(value.employmentType) ||
    typeof value.workLocation !== 'string' || value.workLocation.trim().length < 1 ||
    value.workLocation.length > 256 || typeof value.benefitsSummary !== 'string' ||
    value.benefitsSummary.trim().length < 1 || value.benefitsSummary.length > 4_096) {
    throw invalidPayload();
  }
  return {
    currency: 'CNY',
    monthlyBaseSalaryMinor: Number(value.monthlyBaseSalaryMinor),
    salaryMonths: Number(value.salaryMonths),
    annualVariableTargetMinor: Number(value.annualVariableTargetMinor),
    signingBonusMinor: Number(value.signingBonusMinor),
    proposedStartDate: value.proposedStartDate,
    probationMonths: Number(value.probationMonths),
    employmentType: value.employmentType,
    workLocation: value.workLocation,
    benefitsSummary: value.benefitsSummary,
  };
}

function recruitmentOfferProofPayload(
  value: unknown,
): { readonly proofHash: string; readonly occurredAt: string } | null {
  if (value === null) return null;
  if (!isPlainMigrationObject(value)) throw invalidPayload();
  exactKeys(value, ['occurredAt', 'proofHash']);
  if (typeof value.proofHash !== 'string' || !HASH_PATTERN.test(value.proofHash) ||
    !isStrictUtcIso(value.occurredAt)) throw invalidPayload();
  return { proofHash: value.proofHash, occurredAt: value.occurredAt };
}

function recruitmentOfferDecisionProofPayload(
  value: unknown,
): ImportRecruitmentOfferFromMigrationInput['decisionProof'] {
  if (value === null) return null;
  if (!isPlainMigrationObject(value)) throw invalidPayload();
  exactKeys(value, ['decision', 'occurredAt', 'proofHash']);
  if (!['accepted', 'declined'].includes(String(value.decision)) ||
    typeof value.proofHash !== 'string' || !HASH_PATTERN.test(value.proofHash) ||
    !isStrictUtcIso(value.occurredAt)) throw invalidPayload();
  return {
    decision: value.decision as 'accepted' | 'declined',
    proofHash: value.proofHash,
    occurredAt: value.occurredAt,
  };
}

function recruitmentOfferApplicationAction(
  value: unknown,
): RecruitmentOfferMigrationPayload['applicationActions'][number] {
  if (!isPlainMigrationObject(value)) throw invalidPayload();
  exactKeys(value, ['occurredAt', 'reasonCode', 'targetStage']);
  if (!['offer_approval', 'offer_sent', 'offer_accepted', 'rejected', 'withdrawn']
    .includes(String(value.targetStage)) ||
    (value.reasonCode !== null &&
      (typeof value.reasonCode !== 'string' || !APPROVAL_CODE_PATTERN.test(value.reasonCode))) ||
    !isStrictUtcIso(value.occurredAt)) throw invalidPayload();
  return {
    targetStage: value.targetStage as RecruitmentOfferMigrationPayload['applicationActions'][number]['targetStage'],
    reasonCode: value.reasonCode,
    occurredAt: value.occurredAt,
  };
}

function recruitmentOfferAssociationSpecs(
  payload: RecruitmentOfferMigrationPayload,
): readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  return Object.freeze([
    {
      relationship: 'application', sourceAssociationId: payload.applicationSourceId,
      entityType: 'recruitment.application',
    },
    {
      relationship: 'interview', sourceAssociationId: payload.completedInterviewSourceId,
      entityType: 'recruitment.interview',
    },
    {
      relationship: 'created_by', sourceAssociationId: payload.createdByEmployeeSourceId,
      entityType: 'org.employee',
    },
    ...(payload.approvalReferenceType === null || payload.approvalReferenceSourceId === null
      ? []
      : [{
          relationship: payload.approvalReferenceType === 'approval.instance'
            ? 'approval_instance' as const
            : 'approval_history' as const,
          sourceAssociationId: payload.approvalReferenceSourceId,
          entityType: payload.approvalReferenceType,
        }]),
  ]);
}

type AttendanceSourceFactMigrationPayload = Omit<
  ImportAttendanceSourceFactFromMigrationInput,
  'targetId' | 'employeeId' | 'migrationEvidenceRef' | 'evidenceChecksum'
> & {
  readonly employeeSourceId: string;
  readonly sourceEvidenceSourceAttachmentId: string;
  readonly sourceEvidenceChecksum: string;
};

function attendanceSourceFactPayload(
  value: Readonly<Record<string, unknown>>,
): AttendanceSourceFactMigrationPayload {
  exactKeys(value, [
    'createdAt', 'employeeSourceId', 'externalEventId', 'factType', 'impact',
    'occurredAt', 'providerCode', 'sourceEvidenceChecksum',
    'sourceEvidenceSourceAttachmentId', 'sourceObservedAt', 'timeZone',
  ]);
  if (typeof value.employeeSourceId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.employeeSourceId) ||
    typeof value.sourceEvidenceSourceAttachmentId !== 'string' ||
    !SOURCE_ID_PATTERN.test(value.sourceEvidenceSourceAttachmentId) ||
    typeof value.providerCode !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(value.providerCode) ||
    typeof value.externalEventId !== 'string' ||
    !/^[\x20-\x7e]{1,256}$/.test(value.externalEventId) ||
    !['punch_in', 'punch_out', 'shift', 'leave', 'overtime', 'travel']
      .includes(String(value.factType)) ||
    typeof value.timeZone !== 'string' || value.timeZone.length < 1 || value.timeZone.length > 64 ||
    !isStrictUtcIso(value.occurredAt) || !isStrictUtcIso(value.sourceObservedAt) ||
    !isStrictUtcIso(value.createdAt) || typeof value.sourceEvidenceChecksum !== 'string' ||
    !HASH_PATTERN.test(value.sourceEvidenceChecksum) || !isPlainMigrationObject(value.impact)) {
    throw invalidPayload();
  }
  exactKeys(value.impact, [
    'absentMinutes', 'leaveMinutes', 'overtimeMinutes', 'workedMinutes',
  ]);
  const minutes = [
    value.impact.workedMinutes, value.impact.leaveMinutes,
    value.impact.overtimeMinutes, value.impact.absentMinutes,
  ];
  if (minutes.some((minute) => !Number.isSafeInteger(minute) || Number(minute) < 0 ||
    Number(minute) > 44_640)) throw invalidPayload();
  return {
    employeeSourceId: value.employeeSourceId,
    providerCode: value.providerCode,
    externalEventId: value.externalEventId,
    factType: value.factType as AttendanceSourceFactMigrationPayload['factType'],
    occurredAt: value.occurredAt,
    timeZone: value.timeZone,
    impact: {
      workedMinutes: Number(value.impact.workedMinutes),
      leaveMinutes: Number(value.impact.leaveMinutes),
      overtimeMinutes: Number(value.impact.overtimeMinutes),
      absentMinutes: Number(value.impact.absentMinutes),
    },
    sourceObservedAt: value.sourceObservedAt,
    createdAt: value.createdAt,
    sourceEvidenceSourceAttachmentId: value.sourceEvidenceSourceAttachmentId,
    sourceEvidenceChecksum: value.sourceEvidenceChecksum,
  };
}

function assertGovernanceEvidence(
  input: ApplyDataMigrationRecordDto,
  payload: {
    readonly governanceEvidenceSourceAttachmentId: string;
    readonly governanceEvidenceChecksum: string;
  },
): void {
  const evidence = input.attachments.find((attachment) =>
    attachment.sourceAttachmentId === payload.governanceEvidenceSourceAttachmentId);
  if (input.attachments.length !== 1 ||
    evidence?.checksum !== payload.governanceEvidenceChecksum) {
    throw new Error('DATA_MIGRATION_RECRUITMENT_GOVERNANCE_EVIDENCE_REQUIRED');
  }
}

function approvalTemplatePayload(
  value: Readonly<Record<string, unknown>>,
): ApprovalTemplateMigrationPayload {
  exactKeys(value, [
    'approvedByEmployeeSourceId', 'code', 'createdAt', 'createdByEmployeeSourceId',
    'definition', 'governanceEvidenceSourceAttachmentId', 'name', 'publishedAt',
    'retiredAt', 'revision', 'riskLevel',
    'status', 'updatedAt', 'updatedByEmployeeSourceId',
  ]);
  const requiredIds = [value.createdByEmployeeSourceId, value.updatedByEmployeeSourceId];
  if (requiredIds.some((item) => typeof item !== 'string' || !SOURCE_ID_PATTERN.test(item)) ||
    (value.approvedByEmployeeSourceId !== null &&
      (typeof value.approvedByEmployeeSourceId !== 'string' ||
        !SOURCE_ID_PATTERN.test(value.approvedByEmployeeSourceId))) ||
    (value.governanceEvidenceSourceAttachmentId !== null &&
      (typeof value.governanceEvidenceSourceAttachmentId !== 'string' ||
        !SOURCE_ID_PATTERN.test(value.governanceEvidenceSourceAttachmentId))) ||
    typeof value.code !== 'string' || typeof value.name !== 'string' ||
    !['R1', 'R2'].includes(String(value.riskLevel)) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
    !['draft', 'published', 'retired'].includes(String(value.status)) ||
    typeof value.definition !== 'object' || value.definition === null ||
    Array.isArray(value.definition) ||
    (value.publishedAt !== null && typeof value.publishedAt !== 'string') ||
    (value.retiredAt !== null && typeof value.retiredAt !== 'string') ||
    typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw invalidPayload();
  }
  return {
    code: value.code,
    name: value.name,
    riskLevel: value.riskLevel as 'R1' | 'R2',
    revision: Number(value.revision),
    status: value.status as ApprovalTemplateMigrationPayload['status'],
    definition: validateAndFreezeApprovalTemplateDefinition(
      value.definition as ApprovalTemplateMigrationPayload['definition'],
    ),
    createdByEmployeeSourceId: value.createdByEmployeeSourceId as string,
    updatedByEmployeeSourceId: value.updatedByEmployeeSourceId as string,
    approvedByEmployeeSourceId: value.approvedByEmployeeSourceId,
    governanceEvidenceSourceAttachmentId:
      value.governanceEvidenceSourceAttachmentId,
    publishedAt: value.publishedAt,
    retiredAt: value.retiredAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function approvalTemplateAssociationSpecs(
  payload: ApprovalTemplateMigrationPayload,
): readonly (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  const specs: (AssociationEvidence & { readonly entityType: AssociationTargetType })[] = [
    {
      relationship: 'created_by', sourceAssociationId: payload.createdByEmployeeSourceId,
      entityType: 'org.employee',
    },
    {
      relationship: 'updated_by', sourceAssociationId: payload.updatedByEmployeeSourceId,
      entityType: 'org.employee',
    },
    ...(payload.approvedByEmployeeSourceId === null ? [] : [{
      relationship: 'approved_by' as const,
      sourceAssociationId: payload.approvedByEmployeeSourceId,
      entityType: 'org.employee' as const,
    }]),
  ];
  for (const node of payload.definition.nodes) {
    if (node.resolver.type === 'employees') {
      for (const sourceAssociationId of node.resolver.employeeIds) specs.push({
        relationship: 'fixed_approver', sourceAssociationId, entityType: 'org.employee',
      });
    }
    if (node.condition !== undefined) {
      specs.push(...approvalConditionAssociationSpecs(payload.definition, node.condition));
    }
  }
  const unique = new Map<string, typeof specs[number]>();
  for (const spec of specs) {
    unique.set(`${spec.relationship}:${spec.entityType}:${spec.sourceAssociationId}`, spec);
  }
  return [...unique.values()];
}

function approvalConditionAssociationSpecs(
  definition: ApprovalTemplateDefinition,
  condition: ApprovalCondition,
): (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  switch (condition.op) {
    case 'and':
    case 'or':
      return condition.conditions.flatMap((nested) =>
        approvalConditionAssociationSpecs(definition, nested));
    case 'not':
      return approvalConditionAssociationSpecs(definition, condition.condition);
    case 'eq':
    case 'ne':
      return conditionReferenceSpecs(
        definition,
        condition.field,
        Array.isArray(condition.value) ? condition.value : [condition.value],
      );
    case 'in':
      return conditionReferenceSpecs(definition, condition.field, condition.values);
    default:
      return [];
  }
}

function conditionReferenceSpecs(
  definition: ApprovalTemplateDefinition,
  fieldKey: string,
  values: readonly unknown[],
): (AssociationEvidence & { readonly entityType: AssociationTargetType })[] {
  const field = definition.fields.find((candidate) => candidate.key === fieldKey);
  const entityType = field?.type === 'employee'
    ? 'org.employee' as const
    : field?.type === 'department'
      ? 'org.department' as const
      : null;
  if (entityType === null) return [];
  return values.filter((value): value is string => typeof value === 'string').map(
    (sourceAssociationId) => ({
      relationship: entityType === 'org.employee' ? 'condition_employee' : 'condition_department',
      sourceAssociationId,
      entityType,
    }),
  );
}

async function mapApprovalTemplateDefinition(
  definition: ApprovalTemplateDefinition,
  resolve: (entityType: AssociationTargetType, sourceId: string) => Promise<string>,
): Promise<ApprovalTemplateDefinition> {
  const fieldTypes = new Map(definition.fields.map((field) => [field.key, field.type]));
  return {
    fields: definition.fields.map((field) => structuredClone(field)),
    nodes: await Promise.all(definition.nodes.map(async (node) => ({
      ...structuredClone(node),
      resolver: node.resolver.type === 'employees'
        ? {
            type: 'employees' as const,
            employeeIds: await Promise.all(node.resolver.employeeIds.map(async (sourceId) =>
              resolve('org.employee', sourceId))),
          }
        : structuredClone(node.resolver),
      ...(node.condition === undefined ? {} : {
        condition: await mapApprovalCondition(node.condition, fieldTypes, resolve),
      }),
    }))),
  };
}

async function mapApprovalCondition(
  condition: ApprovalCondition,
  fieldTypes: ReadonlyMap<string, string>,
  resolve: (entityType: AssociationTargetType, sourceId: string) => Promise<string>,
): Promise<ApprovalCondition> {
  switch (condition.op) {
    case 'and':
    case 'or':
      return {
        ...condition,
        conditions: await Promise.all(condition.conditions.map(async (nested) =>
          mapApprovalCondition(nested, fieldTypes, resolve))),
      };
    case 'not':
      return {
        ...condition,
        condition: await mapApprovalCondition(condition.condition, fieldTypes, resolve),
      };
    case 'eq':
    case 'ne': {
      const entityType = conditionEntityType(fieldTypes.get(condition.field));
      if (entityType === null) return structuredClone(condition);
      const value = isApprovalScalarArray(condition.value)
        ? await Promise.all(condition.value.map((item) =>
            typeof item === 'string' ? resolve(entityType, item) : Promise.resolve(item)))
        : typeof condition.value === 'string'
          ? await resolve(entityType, condition.value)
          : condition.value;
      return { ...condition, value };
    }
    case 'in': {
      const entityType = conditionEntityType(fieldTypes.get(condition.field));
      if (entityType === null) return structuredClone(condition);
      return {
        ...condition,
        values: await Promise.all(condition.values.map(async (value) =>
          typeof value === 'string' ? resolve(entityType, value) : value)),
      };
    }
    default:
      return structuredClone(condition);
  }
}

function conditionEntityType(fieldType: string | undefined): AssociationTargetType | null {
  if (fieldType === 'employee') return 'org.employee';
  if (fieldType === 'department') return 'org.department';
  return null;
}

function isApprovalScalarArray(value: unknown): value is readonly ApprovalScalar[] {
  return Array.isArray(value);
}

function associationEvidence(input: ApplyDataMigrationRecordDto): readonly AssociationEvidence[] {
  let derived: readonly AssociationEvidence[];
  try {
    if (input.entityType === 'org.department') {
      const parent = departmentPayload(input.payload).parentSourceId;
      derived = parent === null ? [] : [{
        relationship: 'parent_department', sourceAssociationId: parent,
        entityType: 'org.department',
      }];
    } else if (input.entityType === 'org.employee') {
      derived = employeeAssociationSpecs(employeePayload(input.payload));
    } else if (input.entityType === 'org.employment') {
      const employeeSourceId = employmentPayload(input.payload).employeeSourceId;
      derived = [{
        relationship: 'employee', sourceAssociationId: employeeSourceId,
        entityType: 'org.employee',
      }];
    } else if (input.entityType === 'approval.template') {
      const payload = approvalTemplatePayload(input.payload);
      derived = approvalTemplateAssociationSpecs(payload);
    } else if (input.entityType === 'approval.history') {
      derived = approvalLegacyHistoryAssociationSpecs(
        approvalLegacyHistoryPayload(input.payload),
      );
    } else if (input.entityType === 'approval.instance') {
      derived = approvalActiveInstanceAssociationSpecs(
        approvalActiveInstancePayload(input.payload),
      );
    } else if (input.entityType === 'recruitment.requisition') {
      derived = recruitmentRequisitionAssociationSpecs(
        recruitmentRequisitionPayload(input.payload),
      );
    } else if (input.entityType === 'recruitment.position') {
      derived = recruitmentPositionAssociationSpecs(
        recruitmentPositionPayload(input.payload),
      );
    } else if (input.entityType === 'recruitment.application') {
      derived = recruitmentApplicationAssociationSpecs(
        recruitmentApplicationPayload(input.payload),
      );
    } else if (input.entityType === 'recruitment.interview') {
      derived = recruitmentInterviewAssociationSpecs(
        recruitmentInterviewPayload(input.payload),
      );
    } else if (input.entityType === 'recruitment.offer') {
      derived = recruitmentOfferAssociationSpecs(recruitmentOfferPayload(input.payload));
    } else if (input.entityType === 'attendance.source_fact') {
      const employeeSourceId = attendanceSourceFactPayload(input.payload).employeeSourceId;
      derived = [{
        relationship: 'employee', sourceAssociationId: employeeSourceId,
        entityType: 'org.employee',
      }];
    } else derived = [];
  } catch {
    derived = [];
  }
  const derivedIds = new Set(derived.map((item) => item.sourceAssociationId));
  return [
    ...derived,
    ...input.associationSourceIds
      .filter((sourceAssociationId) => !derivedIds.has(sourceAssociationId))
      .map((sourceAssociationId) => ({
        relationship: 'declared_reference' as const, sourceAssociationId, entityType: null,
      })),
  ];
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) throw invalidPayload();
}
function invalidPayload(): Error { return new Error('DATA_MIGRATION_PAYLOAD_INVALID'); }
function isStrictUtcIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
function isPlainMigrationObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isMigrationFormData(value: unknown): value is ApprovalFormData {
  if (!isPlainMigrationObject(value) || Object.keys(value).length > 100) return false;
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!FIELD_KEY_PATTERN.test(key) || !isMigrationFormValue(fieldValue)) return false;
  }
  return true;
}
function isMigrationFormValue(value: unknown): value is ApprovalFormValue {
  if (Array.isArray(value)) {
    return value.length <= 200 && value.every((item) => isMigrationScalar(item)) &&
      new Set(value).size === value.length;
  }
  return isMigrationScalar(value);
}
function isMigrationScalar(value: unknown): value is ApprovalScalar {
  return value === null || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 10_000);
}
function target<T extends object & { readonly id: string; readonly version: number }>(value: T) {
  const projection = Object.fromEntries(Object.entries(value));
  delete projection.tenantId;
  delete projection.createdAt;
  delete projection.updatedAt;
  return { id: value.id, version: value.version, hash: digest(canonicalJson(projection)) };
}
function rejectionCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: unknown }).response;
    if (typeof response === 'object' && response !== null) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === 'string' &&
        /^(ORG|APPROVAL|RECRUITMENT|ATTENDANCE|DATA_MIGRATION)_[A-Z0-9_]{2,80}$/.test(code)) return code;
    }
  }
  return error instanceof Error &&
    /^(ORG|APPROVAL|RECRUITMENT|ATTENDANCE|DATA_MIGRATION)_[A-Z0-9_]{2,80}$/.test(error.message)
    ? error.message : null;
}

function assertAssociations(actual: readonly string[], expected: readonly string[]): void {
  if ([...actual].sort().join('|') !== [...expected].sort().join('|')) {
    throw new Error('DATA_MIGRATION_ASSOCIATION_DECLARATION_MISMATCH');
  }
}

function assertEntityInScope(
  scope: DataMigrationRunRecord['scope'],
  entityType: ApplyDataMigrationRecordDto['entityType'],
): void {
  if (!isEntityInMigrationScope(scope, entityType)) throw new BadRequestException({
    code: 'DATA_MIGRATION_ENTITY_OUT_OF_SCOPE', message: '实体类型不属于当前迁移范围',
  });
}

function assertUniqueEvidence(input: ApplyDataMigrationRecordDto): void {
  if (new Set(input.associationSourceIds).size !== input.associationSourceIds.length) {
    throw new BadRequestException({
      code: 'DATA_MIGRATION_ASSOCIATION_DUPLICATE', message: '关联来源标识不得重复',
    });
  }
  const attachmentIds = input.attachments.map((item) => item.sourceAttachmentId);
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new BadRequestException({
      code: 'DATA_MIGRATION_ATTACHMENT_DUPLICATE', message: '附件来源标识不得重复',
    });
  }
}


function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const APPROVAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ASSOCIATION_RELATIONSHIPS = [
  'parent_department', 'department', 'primary_department', 'position', 'job_level',
  'employee',
  'created_by', 'updated_by', 'approved_by',
  'fixed_approver', 'condition_employee', 'condition_department',
  'initiator', 'template',
  'form_employee', 'form_department', 'resolved_approver',
  'action_actor', 'principal_approver', 'transfer_from', 'transfer_to',
  'added_approver', 'expected_pending_approver',
  'requisition', 'approval_instance', 'approval_history',
  'candidate', 'application', 'interviewer', 'interview',
  'declared_reference',
] as const;
const ASSOCIATION_RELATIONSHIP_SET: ReadonlySet<string> = new Set(ASSOCIATION_RELATIONSHIPS);

export { dataMigrationChecksum };
