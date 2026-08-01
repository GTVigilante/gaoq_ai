import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createEventId, ULID_PATTERN } from '@gaoq/shared-utils';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';

import type { AppEnvironment } from '../../../config/environment.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { BusinessAttachmentService } from '../../document/application/business-attachment.service.js';
import {
  assertDataMigrationAttachmentJobData,
  createDataMigrationAttachmentJobId,
  DATA_MIGRATION_ATTACHMENT_QUEUE,
  DATA_MIGRATION_ATTACHMENT_TRANSFER_JOB,
  type DataMigrationAttachmentJobData,
} from '../data-migration-attachment.queue.js';
import {
  DATA_MIGRATION_SCOPES,
  DATA_MIGRATION_SCOPE_CLASSIFICATION,
} from '../data-migration-contract.js';
import { DataMigrationAttachmentGateway } from '../integration/data-migration-attachment.ports.js';
import {
  DataMigrationAttachmentRecord,
  type DataMigrationAttachmentDocument,
  DataMigrationRunRecord,
  type DataMigrationRunDocument,
} from '../persistence/data-migration.schemas.js';

const LEASE_MS = 5 * 60 * 1_000;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 外部归档或目标业务终态可能已提交；禁止进入普通失败回写。 */
class DataMigrationAttachmentPostCommitError extends Error {}

type DataMigrationAttachmentJobBase = Pick<
DataMigrationAttachmentJobData,
'tenantId' | 'runId'
>;

/** 附件搬运编排：队列只传控制标识，正文始终留在隔离网关。 */
@Injectable()
export class DataMigrationAttachmentService {
  private readonly logger = new Logger(DataMigrationAttachmentService.name);

  constructor(
    private readonly context: TenantContextService,
    private readonly gateway: DataMigrationAttachmentGateway,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppEnvironment, true>,
    @InjectQueue(DATA_MIGRATION_ATTACHMENT_QUEUE)
    private readonly queue: Queue<DataMigrationAttachmentJobData>,
    @InjectModel(DataMigrationRunRecord.name) private readonly runs: Model<DataMigrationRunDocument>,
    @InjectModel(DataMigrationAttachmentRecord.name)
    private readonly attachments: Model<DataMigrationAttachmentDocument>,
    private readonly businessAttachments: BusinessAttachmentService,
  ) {}

  async request(runId: string) {
    this.assertRequester();
    const tenantId = this.context.getTenantRequired().tenantId;
    this.assertJobBase({ tenantId, runId });
    const run = await this.runs.findOne({ tenantId, id: runId }).lean().exec();
    if (run === null) throw new NotFoundException({
      code: 'DATA_MIGRATION_RUN_NOT_FOUND', message: '迁移运行不存在',
    });
    this.assertRun(run, { tenantId, runId });
    if (run.status !== 'running' || run.checkpoint !== run.expectedSourceCount) {
      throw new ConflictException({
        code: 'DATA_MIGRATION_ATTACHMENT_TRANSFER_NOT_READY',
        message: '必须在全部来源记录处理完成且运行冻结前搬运附件',
      });
    }
    const pendingCount = await this.attachments.countDocuments({
      tenantId, runId, status: { $in: ['pending', 'processing'] },
    }).exec();
    if (pendingCount > 0) await this.enqueue({ tenantId, runId });
    return Object.freeze({ runId, status: pendingCount === 0 ? 'ready' : 'queued', pendingCount });
  }

  async process(input: DataMigrationAttachmentJobData): Promise<void> {
    assertDataMigrationAttachmentJobData(input);
    const run = await this.runs.findOne({ tenantId: input.tenantId, id: input.runId }).lean().exec();
    if (run === null) return;
    this.assertRun(run, input);
    if (run.status !== 'running') return;
    for (let processed = 0; processed < BATCH_SIZE; processed += 1) {
      const attachment = await this.claim(input.tenantId, input.runId);
      if (attachment === null) break;
      try {
        this.assertAttachment(attachment, input);
        const retentionDays = this.retentionDays();
        const receipt = await this.gateway.transfer({
          tenantId: input.tenantId, runId: input.runId, sourceSystem: run.sourceSystem,
          sourceAttachmentId: attachment.sourceAttachmentId,
          expectedChecksum: attachment.checksum,
          classification: DATA_MIGRATION_SCOPE_CLASSIFICATION[run.scope],
          retentionDays,
        });
        if (attachment.usage === 'business_content') {
          const finalized = await this.businessAttachments.finalizeMigration(
            input.tenantId, input.runId, attachment.sourceAttachmentId,
            receipt.checksum, receipt.targetEvidenceId,
          );
          if (!finalized) throw new Error('BUSINESS_ATTACHMENT_MIGRATION_TARGET_NOT_FOUND');
        }
        try {
          const updated = await this.attachments.updateOne(
            this.leaseFilter(input, attachment),
            { $set: {
              status: 'verified', processingStartedAt: null,
              targetEvidenceId: receipt.targetEvidenceId, rejectionCode: null,
            } },
            { runValidators: true },
          ).exec();
          if (updated.modifiedCount !== 1) {
            throw new Error('DATA_MIGRATION_ATTACHMENT_STATE_CONFLICT');
          }
        } catch {
          throw new DataMigrationAttachmentPostCommitError(
            '附件外部归档已成功但本地终态不可用',
          );
        }
        await this.auditAfterCommit(input, attachment, 'success', {
          targetEvidenceId: receipt.targetEvidenceId,
          malwareScanEvidenceId: receipt.malwareScanEvidenceId,
          checksum: receipt.checksum,
          classification: receipt.classification,
        });
      } catch (error) {
        if (error instanceof DataMigrationAttachmentPostCommitError) throw error;
        await this.handleFailure(input, attachment, error);
        if (!permanentFailure(error, attachment.attempts)) throw error;
      }
    }
    const remaining = await this.attachments.countDocuments({
      tenantId: input.tenantId, runId: input.runId,
      $or: [
        { status: 'pending', attempts: { $lt: MAX_ATTEMPTS } },
        {
          status: 'processing', attempts: { $lt: MAX_ATTEMPTS },
          processingStartedAt: { $lt: new Date(Date.now() - LEASE_MS) },
        },
      ],
    }).exec();
    if (remaining > 0) await this.enqueue(input);
  }

  private async claim(tenantId: string, runId: string) {
    const now = new Date();
    return this.attachments.findOneAndUpdate(
      {
        tenantId, runId,
        $or: [
          { status: 'pending', attempts: { $lt: MAX_ATTEMPTS } },
          {
            status: 'processing', attempts: { $lt: MAX_ATTEMPTS },
            processingStartedAt: { $lt: new Date(now.getTime() - LEASE_MS) },
          },
        ],
      },
      { $set: { status: 'processing', processingStartedAt: now }, $inc: { attempts: 1 } },
      { sort: { sequence: 1, sourceAttachmentId: 1 }, returnDocument: 'after', runValidators: true },
    ).lean().exec();
  }

  private async handleFailure(
    input: DataMigrationAttachmentJobData,
    attachment: DataMigrationAttachmentRecord,
    error: unknown,
  ): Promise<void> {
    const rejected = permanentFailure(error, attachment.attempts);
    const rejectionCode = rejected ? safeFailureCode(error, attachment.attempts) : null;
    const updated = await this.attachments.updateOne(
      this.leaseFilter(input, attachment),
      { $set: {
        status: rejected ? 'rejected' : 'pending', processingStartedAt: null,
        rejectionCode,
      } },
      { runValidators: true },
    ).exec();
    if (updated.modifiedCount !== 1) {
      throw new DataMigrationAttachmentPostCommitError('附件失败终态租约已丢失');
    }
    await this.auditAfterCommit(input, attachment, 'failure', {
      failureCode: rejectionCode ?? 'DATA_MIGRATION_ATTACHMENT_TRANSIENT_FAILURE',
      retryable: !rejected,
    });
  }

  private async enqueue(base: DataMigrationAttachmentJobBase): Promise<void> {
    this.assertJobBase(base);
    const data = Object.freeze({ ...base, dispatchId: createEventId() });
    await this.queue.add(DATA_MIGRATION_ATTACHMENT_TRANSFER_JOB, data, {
      jobId: createDataMigrationAttachmentJobId(data),
      attempts: 6,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    });
  }

  private leaseFilter(
    input: DataMigrationAttachmentJobData,
    attachment: DataMigrationAttachmentRecord,
  ): Readonly<Record<string, unknown>> {
    return {
      tenantId: input.tenantId,
      runId: input.runId,
      id: attachment.id,
      status: 'processing',
      attempts: attachment.attempts,
      processingStartedAt: attachment.processingStartedAt,
    };
  }

  private async auditAfterCommit(
    input: DataMigrationAttachmentJobData,
    attachment: DataMigrationAttachmentRecord,
    outcome: 'success' | 'failure',
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.audit.recordSystem(input.tenantId, {
        action: 'data_migration.attachment.transfer',
        resourceType: 'data_migration_run',
        resourceId: input.runId,
        riskLevel: 'R2',
        outcome,
        traceId: input.runId,
        metadata: { sourceAttachmentId: attachment.sourceAttachmentId, ...metadata },
      });
    } catch {
      this.logger.error({
        code: 'DATA_MIGRATION_ATTACHMENT_AUDIT_AFTER_COMMIT_FAILED',
        tenantId: input.tenantId,
        runId: input.runId,
        sourceAttachmentId: attachment.sourceAttachmentId,
        outcome,
      });
    }
  }

  private assertRun(
    run: DataMigrationRunRecord,
    input: DataMigrationAttachmentJobBase,
  ): void {
    if (
      run.id !== input.runId ||
      run.tenantId !== input.tenantId ||
      !ULID_PATTERN.test(run.id) ||
      !TENANT_ID_PATTERN.test(run.tenantId) ||
      !SOURCE_ID_PATTERN.test(run.sourceSystem) ||
      !DATA_MIGRATION_SCOPES.includes(run.scope) ||
      !['running', 'completed', 'failed'].includes(run.status) ||
      !Number.isSafeInteger(run.expectedSourceCount) ||
      run.expectedSourceCount < 0 ||
      run.expectedSourceCount > 10_000_000 ||
      !Number.isSafeInteger(run.checkpoint) ||
      run.checkpoint < 0 ||
      run.checkpoint > run.expectedSourceCount
    ) throw new Error('DATA_MIGRATION_ATTACHMENT_RUN_INVALID');
  }

  private assertAttachment(
    attachment: DataMigrationAttachmentRecord,
    input: DataMigrationAttachmentJobBase,
  ): void {
    if (
      !ULID_PATTERN.test(attachment.id) ||
      attachment.tenantId !== input.tenantId ||
      attachment.runId !== input.runId ||
      !Number.isSafeInteger(attachment.sequence) ||
      attachment.sequence < 1 ||
      !SOURCE_ID_PATTERN.test(attachment.sourceAttachmentId) ||
      !HASH_PATTERN.test(attachment.checksum) ||
      !['migration_evidence', 'business_content'].includes(attachment.usage) ||
      attachment.status !== 'processing' ||
      !Number.isInteger(attachment.attempts) ||
      attachment.attempts < 1 ||
      attachment.attempts > MAX_ATTEMPTS ||
      !(attachment.processingStartedAt instanceof Date) ||
      !Number.isFinite(attachment.processingStartedAt.getTime()) ||
      attachment.targetEvidenceId !== null ||
      attachment.rejectionCode !== null
    ) throw new Error('DATA_MIGRATION_ATTACHMENT_RECORD_INVALID');
  }

  private retentionDays(): number {
    const value = this.config.get(
      'DATA_MIGRATION_ATTACHMENT_RETENTION_DAYS', { infer: true },
    );
    if (!Number.isInteger(value) || value < 2_555 || value > 36_500) {
      throw new Error('DATA_MIGRATION_ATTACHMENT_RETENTION_INVALID');
    }
    return value;
  }

  private assertJobBase(input: DataMigrationAttachmentJobBase): void {
    if (
      !TENANT_ID_PATTERN.test(input.tenantId) ||
      !ULID_PATTERN.test(input.runId)
    ) throw new Error('DATA_MIGRATION_ATTACHMENT_JOB_DATA_INVALID');
  }

  private assertRequester(): void {
    const actor = this.context.getActorRequired();
    if (!['service', 'system_job'].includes(actor.actorType) ||
      !actor.scopes.includes('erp:migration:execute') ||
      !actor.scopes.includes('erp:migration:attachment:execute')) throw new ForbiddenException({
      code: 'DATA_MIGRATION_ATTACHMENT_EXECUTOR_FORBIDDEN',
      message: '当前身份无权执行迁移附件搬运',
    });
  }
}

function permanentFailure(error: unknown, attempts: number): boolean {
  const code = error instanceof Error ? error.message : '';
  return attempts >= MAX_ATTEMPTS || [
    'DATA_MIGRATION_ATTACHMENT_COMMAND_INVALID',
    'DATA_MIGRATION_ATTACHMENT_HASH_INVALID',
    'DATA_MIGRATION_ATTACHMENT_RECORD_INVALID',
    'DATA_MIGRATION_ATTACHMENT_RECEIPT_INVALID',
    'DATA_MIGRATION_ATTACHMENT_RECEIPT_TOO_LARGE',
    'DATA_MIGRATION_ATTACHMENT_GATEWAY_HTTP_404',
    'DATA_MIGRATION_ATTACHMENT_GATEWAY_HTTP_409',
    'DATA_MIGRATION_ATTACHMENT_GATEWAY_HTTP_422',
    'BUSINESS_ATTACHMENT_MIGRATION_RECEIPT_INVALID',
    'BUSINESS_ATTACHMENT_MIGRATION_CHECKSUM_MISMATCH',
    'BUSINESS_ATTACHMENT_MIGRATION_IMMUTABLE',
    'BUSINESS_ATTACHMENT_MIGRATION_TARGET_NOT_FOUND',
  ].includes(code);
}

function safeFailureCode(error: unknown, attempts: number): string {
  if (attempts >= MAX_ATTEMPTS) return 'DATA_MIGRATION_ATTACHMENT_RETRY_EXHAUSTED';
  return error instanceof Error &&
    /^(?:DATA_MIGRATION_ATTACHMENT|BUSINESS_ATTACHMENT_MIGRATION)_[A-Z0-9_]{2,80}$/u
      .test(error.message)
    ? error.message : 'DATA_MIGRATION_ATTACHMENT_TRANSFER_REJECTED';
}
