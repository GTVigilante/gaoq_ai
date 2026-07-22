import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId } from '@gaoq/shared-utils';
import type { Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { OrgApplicationService } from '../../org/application/org-application.service.js';
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
  readonly scope: 'org_reference' | 'org_workforce';
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
  ) {}

  async start(input: CreateDataMigrationRunDto) {
    this.assertExecutor();
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
    else {
      const payload = employeePayload(input.payload);
      assertAssociations(input.associationSourceIds, employeeAssociationIds(payload));
      await Promise.all(employeeAssociationSpecs(payload).map(async (association) =>
        this.requireMapping(run, association.entityType, association.sourceAssociationId)));
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
    const payload = employeePayload(input.payload);
    const command = await this.employeeCommand(run, payload);
    const result = mapping === null
      ? await this.organization.createEmployee(key, command)
      : await this.organization.synchronizeEmployeeFromMigration(
        mapping.targetId, mapping.targetVersion, key, command,
      );
    return target(result.employee);
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

  private assertExecutor(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:org:master:write')) throw new ForbiddenException({
      code: 'DATA_MIGRATION_EXECUTOR_FORBIDDEN', message: '当前身份无权执行数据迁移',
    });
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
type AssociationTargetType = 'org.department' | 'org.position' | 'org.job_level';
interface AssociationEvidence {
  readonly relationship: AssociationRelationship;
  readonly sourceAssociationId: string;
  readonly entityType: AssociationTargetType | null;
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
      if (typeof code === 'string' && /^(ORG|DATA_MIGRATION)_[A-Z0-9_]{2,80}$/.test(code)) return code;
    }
  }
  return error instanceof Error && /^(ORG|DATA_MIGRATION)_[A-Z0-9_]{2,80}$/.test(error.message)
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
  const allowed = scope === 'org_reference'
    ? ['org.department', 'org.position', 'org.job_level']
    : ['org.employee'];
  if (!allowed.includes(entityType)) throw new BadRequestException({
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
const ASSOCIATION_RELATIONSHIPS = [
  'parent_department', 'department', 'primary_department', 'position', 'job_level',
  'declared_reference',
] as const;
const ASSOCIATION_RELATIONSHIP_SET: ReadonlySet<string> = new Set(ASSOCIATION_RELATIONSHIPS);

export { dataMigrationChecksum };
