import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { AuditService } from '../../../core/audit/audit.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import {
  createDataMigrationAttachmentJobId,
  type DataMigrationAttachmentJobData,
} from '../data-migration-attachment.queue.js';
import type { DataMigrationAttachmentGateway } from '../integration/data-migration-attachment.ports.js';
import type {
  DataMigrationAttachmentDocument,
  DataMigrationRunDocument,
} from '../persistence/data-migration.schemas.js';
import { DataMigrationAttachmentService } from './data-migration-attachment.service.js';

const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const DISPATCH_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F9';

function jobData(): DataMigrationAttachmentJobData {
  return { tenantId: 'tenant-001', runId: RUN_ID, dispatchId: DISPATCH_ID };
}

function runRecord(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: RUN_ID,
    tenantId: 'tenant-001',
    sourceSystem: 'legacy-hr',
    scope: 'recruitment_offers',
    status: 'running',
    checkpoint: 1,
    expectedSourceCount: 1,
    ...overrides,
  };
}

function attachmentRecord(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4F2',
    tenantId: 'tenant-001',
    runId: RUN_ID,
    sequence: 1,
    sourceAttachmentId: 'legacy-file-001',
    checksum: 'c'.repeat(43),
    usage: 'migration_evidence',
    status: 'processing',
    attempts: 1,
    processingStartedAt: new Date('2026-07-28T10:00:00.000Z'),
    targetEvidenceId: null,
    rejectionCode: null,
    ...overrides,
  };
}

function query<T>(value: T) { return { lean: () => ({ exec: () => Promise.resolve(value) }) }; }

function trusted<T>(context: TenantContextService, action: () => T): T {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: {
      actorId: 'migration-agent', actorType: 'service', tenantId: 'tenant-001',
      roleCodes: [], scopes: ['erp:migration:execute', 'erp:migration:attachment:execute'],
      departmentIds: [], traceId: 'trace-attachment-001',
    },
  }, action);
}

describe('DataMigrationAttachmentService', () => {
  it('来源记录完整后才按运行入队且不把附件正文放进 Job', async () => {
    const context = new TenantContextService();
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', status: 'running', checkpoint: 2,
      expectedSourceCount: 2, sourceSystem: 'legacy-hr', scope: 'org_reference',
    })) };
    const attachments = { countDocuments: vi.fn().mockReturnValue({
      exec: () => Promise.resolve(3),
    }) };
    const queue = { add: vi.fn() };
    const service = assemble(context, runs, attachments, queue, {}, {});

    const result = await trusted(context, () => service.request(RUN_ID));

    expect(result).toEqual({ runId: RUN_ID, status: 'queued', pendingCount: 3 });
    const jobData = queue.add.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(jobData).toMatchObject({ tenantId: 'tenant-001', runId: RUN_ID });
    expect(jobData.dispatchId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(JSON.stringify(jobData)).not.toMatch(/checksum|token|content/iu);
  });

  it('网关回执通过后把附件标记为 verified 并记录系统审计', async () => {
    const context = new TenantContextService();
    const attachment = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F2', tenantId: 'tenant-001', runId: RUN_ID,
      sequence: 1, sourceAttachmentId: 'legacy-file-001', checksum: 'c'.repeat(43),
      usage: 'migration_evidence', status: 'processing', attempts: 1,
      processingStartedAt: new Date(),
      targetEvidenceId: null, rejectionCode: null,
    };
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr',
      scope: 'recruitment_offers', status: 'running',
      checkpoint: 1, expectedSourceCount: 1,
    })) };
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValueOnce(query(attachment)).mockReturnValueOnce(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const gateway = { transfer: vi.fn().mockResolvedValue({
      targetEvidenceId: 'worm/migration/file-001', malwareScanEvidenceId: 'scan-001',
      checksum: 'c'.repeat(43), immutable: true, malwareClean: true, retentionDays: 2_555,
      classification: 'L4',
    }) };
    const audit = { recordSystem: vi.fn() };
    const service = assemble(context, runs, attachments, {}, gateway, audit);

    await service.process(jobData());

    expect(attachments.updateOne).toHaveBeenCalledOnce();
    const updateFilter = attachments.updateOne.mock.calls[0]?.[0] as unknown as
      Record<string, unknown>;
    const update = attachments.updateOne.mock.calls[0]?.[1] as unknown as {
      $set?: Record<string, unknown>;
    };
    const options = attachments.updateOne.mock.calls[0]?.[2] as unknown as
      Record<string, unknown>;
    expect(updateFilter).toMatchObject({ id: attachment.id, status: 'processing' });
    expect(update.$set).toMatchObject({
      status: 'verified', targetEvidenceId: 'worm/migration/file-001',
    });
    expect(options.runValidators).toBe(true);
    expect(audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001', expect.objectContaining({ outcome: 'success', riskLevel: 'R2' }),
    );
    expect(gateway.transfer).toHaveBeenCalledWith(expect.objectContaining({
      classification: 'L4',
    }));
  });

  it('业务附件必须先由领域服务激活才确认账本回执', async () => {
    const context = new TenantContextService();
    const attachment = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F2', tenantId: 'tenant-001', runId: RUN_ID,
      sequence: 1, sourceAttachmentId: 'resume-001', checksum: 'r'.repeat(43),
      usage: 'business_content', status: 'processing', attempts: 1,
      processingStartedAt: new Date(), targetEvidenceId: null, rejectionCode: null,
    };
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr',
      scope: 'business_attachments', status: 'running',
      checkpoint: 1, expectedSourceCount: 1,
    })) };
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValueOnce(query(attachment)).mockReturnValueOnce(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const gateway = { transfer: vi.fn().mockResolvedValue({
      targetEvidenceId: 'worm/migration/resume-001', malwareScanEvidenceId: 'scan-resume-001',
      checksum: 'r'.repeat(43), immutable: true, malwareClean: true, retentionDays: 2_555,
      classification: 'L4',
    }) };
    const finalizer = { finalizeMigration: vi.fn().mockResolvedValue(true) };
    const service = assemble(
      context, runs, attachments, {}, gateway, { recordSystem: vi.fn() }, finalizer,
    );

    await service.process(jobData());

    expect(finalizer.finalizeMigration).toHaveBeenCalledWith(
      'tenant-001', RUN_ID, 'resume-001', 'r'.repeat(43), 'worm/migration/resume-001',
    );
    expect(attachments.updateOne).toHaveBeenCalled();
    expect(JSON.stringify(attachments.updateOne.mock.calls)).toContain('"status":"verified"');
  });

  it('业务附件目标元数据缺失时永久拒绝且不得把账本标为 verified', async () => {
    const context = new TenantContextService();
    const attachment = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F2', tenantId: 'tenant-001', runId: RUN_ID,
      sequence: 1, sourceAttachmentId: 'resume-missing', checksum: 'r'.repeat(43),
      usage: 'business_content', status: 'processing', attempts: 1,
      processingStartedAt: new Date(), targetEvidenceId: null, rejectionCode: null,
    };
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr',
      scope: 'business_attachments', status: 'running',
      checkpoint: 1, expectedSourceCount: 1,
    })) };
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValueOnce(query(attachment)).mockReturnValueOnce(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const gateway = { transfer: vi.fn().mockResolvedValue({
      targetEvidenceId: 'worm/migration/resume-missing', malwareScanEvidenceId: 'scan-missing',
      checksum: 'r'.repeat(43), immutable: true, malwareClean: true, retentionDays: 2_555,
      classification: 'L4',
    }) };
    const finalizer = { finalizeMigration: vi.fn().mockResolvedValue(false) };
    const service = assemble(
      context, runs, attachments, {}, gateway, { recordSystem: vi.fn() }, finalizer,
    );

    await expect(service.process(jobData()))
      .resolves.toBeUndefined();

    const updates = JSON.stringify(attachments.updateOne.mock.calls);
    expect(updates).toContain('BUSINESS_ATTACHMENT_MIGRATION_TARGET_NOT_FOUND');
    expect(updates).not.toContain('"status":"verified"');
  });

  it('网关返回永久失败时把附件标记为 rejected 且不继续重试', async () => {
    const context = new TenantContextService();
    const attachment = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F3', tenantId: 'tenant-001', runId: RUN_ID,
      sequence: 1, sourceAttachmentId: 'legacy-file-malware', checksum: 'd'.repeat(43),
      usage: 'migration_evidence', status: 'processing', attempts: 1,
      processingStartedAt: new Date(),
      targetEvidenceId: null, rejectionCode: null,
    };
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr',
      scope: 'recruitment_offers', status: 'running',
      checkpoint: 1, expectedSourceCount: 1,
    })) };
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValueOnce(query(attachment)).mockReturnValueOnce(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const gateway = {
      transfer: vi.fn().mockRejectedValue(
        new Error('DATA_MIGRATION_ATTACHMENT_GATEWAY_HTTP_422'),
      ),
    };
    const audit = { recordSystem: vi.fn() };
    const service = assemble(context, runs, attachments, {}, gateway, audit);

    await expect(service.process(jobData())).resolves.toBeUndefined();

    const update = attachments.updateOne.mock.calls[0]?.[1] as unknown as {
      $set?: Record<string, unknown>;
    };
    expect(update.$set).toMatchObject({
      status: 'rejected', processingStartedAt: null,
      rejectionCode: 'DATA_MIGRATION_ATTACHMENT_GATEWAY_HTTP_422',
    });
    expect(audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001', expect.objectContaining({ outcome: 'failure', riskLevel: 'R2' }),
    );
  });

  it('瞬时失败时恢复 pending 并抛错交给 BullMQ 退避重试', async () => {
    const context = new TenantContextService();
    const attachment = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F4', tenantId: 'tenant-001', runId: RUN_ID,
      sequence: 1, sourceAttachmentId: 'legacy-file-timeout', checksum: 'e'.repeat(43),
      usage: 'migration_evidence', status: 'processing', attempts: 1,
      processingStartedAt: new Date(),
      targetEvidenceId: null, rejectionCode: null,
    };
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr',
      scope: 'recruitment_offers', status: 'running',
      checkpoint: 1, expectedSourceCount: 1,
    })) };
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValueOnce(query(attachment)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
      countDocuments: vi.fn(),
    };
    const gateway = {
      transfer: vi.fn().mockRejectedValue(
        new Error('DATA_MIGRATION_ATTACHMENT_GATEWAY_UNAVAILABLE'),
      ),
    };
    const audit = { recordSystem: vi.fn() };
    const service = assemble(context, runs, attachments, {}, gateway, audit);

    await expect(service.process(jobData()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_GATEWAY_UNAVAILABLE');

    const update = attachments.updateOne.mock.calls[0]?.[1] as unknown as {
      $set?: Record<string, unknown>;
    };
    expect(update.$set).toMatchObject({
      status: 'pending', processingStartedAt: null, rejectionCode: null,
    });
    expect(audit.recordSystem).toHaveBeenCalledWith(
      'tenant-001', expect.objectContaining({ outcome: 'failure', riskLevel: 'R2' }),
    );
  });

  it('只有其他 Worker 持有有效 processing 租约时不重复入队', async () => {
    const context = new TenantContextService();
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr',
      scope: 'recruitment_offers', status: 'running',
      checkpoint: 1, expectedSourceCount: 1,
    })) };
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValue(query(null)),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const queue = { add: vi.fn() };
    const service = assemble(context, runs, attachments, queue, {}, {});

    await service.process(jobData());

    const remainingFilter = attachments.countDocuments.mock.calls[0]?.[0] as unknown as {
      tenantId: string;
      runId: string;
      $or: ReadonlyArray<{ status?: string }>;
    };
    expect(remainingFilter).toMatchObject({ tenantId: 'tenant-001', runId: RUN_ID });
    expect(remainingFilter.$or.map((condition) => condition.status))
      .toEqual(['pending', 'processing']);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('没有待搬附件时返回 ready 且不创建空任务', async () => {
    const context = new TenantContextService();
    const runs = { findOne: vi.fn().mockReturnValue(query(runRecord())) };
    const attachments = {
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const queue = { add: vi.fn() };
    const service = assemble(context, runs, attachments, queue, {}, {});

    await expect(trusted(context, () => service.request(RUN_ID))).resolves.toEqual({
      runId: RUN_ID,
      status: 'ready',
      pendingCount: 0,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('运行不存在、未完整或标识非法时不得入队', async () => {
    const context = new TenantContextService();
    const missingRuns = { findOne: vi.fn().mockReturnValue(query(null)) };
    const service = assemble(context, missingRuns, {}, { add: vi.fn() }, {}, {});

    await expect(trusted(context, () => service.request(RUN_ID)))
      .rejects.toMatchObject({ response: { code: 'DATA_MIGRATION_RUN_NOT_FOUND' } });
    await expect(trusted(context, () => service.request('bad')))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_JOB_DATA_INVALID');
    expect(missingRuns.findOne).toHaveBeenCalledOnce();

    const incompleteRuns = {
      findOne: vi.fn().mockReturnValue(query(runRecord({ checkpoint: 0 }))),
    };
    const incomplete = assemble(context, incompleteRuns, {}, { add: vi.fn() }, {}, {});
    await expect(trusted(context, () => incomplete.request(RUN_ID)))
      .rejects.toMatchObject({
        response: { code: 'DATA_MIGRATION_ATTACHMENT_TRANSFER_NOT_READY' },
      });
  });

  it.each([
    ['mcp_client', ['erp:migration:execute', 'erp:migration:attachment:execute']],
    ['service', ['erp:migration:execute']],
    ['system_job', ['erp:migration:attachment:execute']],
  ])('拒绝身份类型或 Scope 不完整的请求者 %s', async (actorType, scopes) => {
    const context = new TenantContextService();
    const service = assemble(context, {}, {}, {}, {}, {});
    const action = () => context.run({
      tenant: { tenantId: 'tenant-001', source: 'service_identity' },
      actor: {
        actorId: 'actor-001',
        actorType: actorType as 'mcp_client' | 'service' | 'system_job',
        tenantId: 'tenant-001',
        roleCodes: [],
        scopes,
        departmentIds: [],
        traceId: 'trace-forbidden',
      },
    }, () => service.request(RUN_ID));

    await expect(action()).rejects.toMatchObject({
      response: { code: 'DATA_MIGRATION_ATTACHMENT_EXECUTOR_FORBIDDEN' },
    });
  });

  it('运行缺失或已结束的任务不触碰附件与外部网关', async () => {
    const missingAttachments = { findOneAndUpdate: vi.fn() };
    const missingGateway = { transfer: vi.fn() };
    const missing = assemble(
      new TenantContextService(),
      { findOne: vi.fn().mockReturnValue(query(null)) },
      missingAttachments,
      {},
      missingGateway,
      {},
    );
    await expect(missing.process(jobData())).resolves.toBeUndefined();
    expect(missingAttachments.findOneAndUpdate).not.toHaveBeenCalled();

    const completedAttachments = { findOneAndUpdate: vi.fn() };
    const completedGateway = { transfer: vi.fn() };
    const completed = assemble(
      new TenantContextService(),
      { findOne: vi.fn().mockReturnValue(query(runRecord({ status: 'completed' }))) },
      completedAttachments,
      {},
      completedGateway,
      {},
    );
    await expect(completed.process(jobData())).resolves.toBeUndefined();
    expect(completedAttachments.findOneAndUpdate).not.toHaveBeenCalled();
    expect(completedGateway.transfer).not.toHaveBeenCalled();
  });

  it('任务、运行或附件事实受损时在外呼前失败关闭', async () => {
    const context = new TenantContextService();
    const gateway = { transfer: vi.fn() };
    const invalidJob = assemble(context, {}, {}, {}, gateway, {});
    await expect(invalidJob.process({ ...jobData(), tenantId: '*invalid' }))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_JOB_DATA_INVALID');

    const invalidRun = assemble(
      context,
      { findOne: vi.fn().mockReturnValue(query(runRecord({ sourceSystem: '../legacy' }))) },
      {},
      {},
      gateway,
      {},
    );
    await expect(invalidRun.process(jobData()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RUN_INVALID');

    const invalidAttachment = attachmentRecord({ checksum: 'bad' });
    const attachments = {
      findOneAndUpdate: vi.fn()
        .mockReturnValueOnce(query(invalidAttachment))
        .mockReturnValueOnce(query(null)),
      updateOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ modifiedCount: 1 }),
      }),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const invalidRecord = assemble(
      context,
      { findOne: vi.fn().mockReturnValue(query(runRecord())) },
      attachments,
      {},
      gateway,
      { recordSystem: vi.fn() },
    );
    await expect(invalidRecord.process(jobData())).resolves.toBeUndefined();
    expect(gateway.transfer).not.toHaveBeenCalled();
    const invalidUpdate: unknown = attachments.updateOne.mock.calls[0]?.[1];
    expect(attachments.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        processingStartedAt: invalidAttachment.processingStartedAt,
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(invalidUpdate).toMatchObject({
      $set: {
        status: 'rejected',
        rejectionCode: 'DATA_MIGRATION_ATTACHMENT_RECORD_INVALID',
      },
    });
  });

  it('成功终态先绑定原租约提交，后置审计失败不回写 pending', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const attachment = attachmentRecord();
    const attachments = {
      findOneAndUpdate: vi.fn()
        .mockReturnValueOnce(query(attachment))
        .mockReturnValueOnce(query(null)),
      updateOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ modifiedCount: 1 }),
      }),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const audit = { recordSystem: vi.fn().mockRejectedValue(new Error('audit unavailable')) };
    const service = assemble(
      new TenantContextService(),
      { findOne: vi.fn().mockReturnValue(query(runRecord())) },
      attachments,
      {},
      { transfer: vi.fn().mockResolvedValue({
        targetEvidenceId: 'worm/migration/file-001',
        malwareScanEvidenceId: 'scan-001',
        checksum: 'c'.repeat(43),
        classification: 'L4',
      }) },
      audit,
    );

    await expect(service.process(jobData())).resolves.toBeUndefined();

    expect(attachments.updateOne).toHaveBeenCalledOnce();
    const successUpdate: unknown = attachments.updateOne.mock.calls[0]?.[1];
    expect(attachments.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        processingStartedAt: attachment.processingStartedAt,
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(successUpdate).toMatchObject({ $set: { status: 'verified' } });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      code: 'DATA_MIGRATION_ATTACHMENT_AUDIT_AFTER_COMMIT_FAILED',
      outcome: 'success',
    }));
    log.mockRestore();
  });

  it('外部成功后的本地终态租约丢失不得进入普通失败回写', async () => {
    const attachment = attachmentRecord();
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValueOnce(query(attachment)),
      updateOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ modifiedCount: 0 }),
      }),
      countDocuments: vi.fn(),
    };
    const audit = { recordSystem: vi.fn() };
    const service = assemble(
      new TenantContextService(),
      { findOne: vi.fn().mockReturnValue(query(runRecord())) },
      attachments,
      {},
      { transfer: vi.fn().mockResolvedValue({
        targetEvidenceId: 'worm/migration/file-001',
        malwareScanEvidenceId: 'scan-001',
        checksum: 'c'.repeat(43),
        classification: 'L4',
      }) },
      audit,
    );

    await expect(service.process(jobData()))
      .rejects.toThrow('附件外部归档已成功但本地终态不可用');

    expect(attachments.updateOne).toHaveBeenCalledOnce();
    expect(audit.recordSystem).not.toHaveBeenCalled();
  });

  it('失败终态先按原租约提交，审计故障不覆盖原始瞬时错误', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const attachment = attachmentRecord();
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValueOnce(query(attachment)),
      updateOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ modifiedCount: 1 }),
      }),
      countDocuments: vi.fn(),
    };
    const service = assemble(
      new TenantContextService(),
      { findOne: vi.fn().mockReturnValue(query(runRecord())) },
      attachments,
      {},
      { transfer: vi.fn().mockRejectedValue(
        new Error('DATA_MIGRATION_ATTACHMENT_GATEWAY_UNAVAILABLE'),
      ) },
      { recordSystem: vi.fn().mockRejectedValue(new Error('audit unavailable')) },
    );

    await expect(service.process(jobData()))
      .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_GATEWAY_UNAVAILABLE');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      code: 'DATA_MIGRATION_ATTACHMENT_AUDIT_AFTER_COMMIT_FAILED',
      outcome: 'failure',
    }));
    log.mockRestore();
  });

  it('失败回写租约丢失时停止批次且不得写错误审计', async () => {
    const audit = { recordSystem: vi.fn() };
    const service = assemble(
      new TenantContextService(),
      { findOne: vi.fn().mockReturnValue(query(runRecord())) },
      {
        findOneAndUpdate: vi.fn().mockReturnValueOnce(query(attachmentRecord())),
        updateOne: vi.fn().mockReturnValue({
          exec: () => Promise.resolve({ modifiedCount: 0 }),
        }),
      },
      {},
      { transfer: vi.fn().mockRejectedValue(new Error('timeout')) },
      audit,
    );

    await expect(service.process(jobData()))
      .rejects.toThrow('附件失败终态租约已丢失');
    expect(audit.recordSystem).not.toHaveBeenCalled();
  });

  it('批次仍有可恢复记录时用新派发标识创建载荷绑定的后续任务', async () => {
    const queue = { add: vi.fn() };
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValue(query(null)),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(1) }),
    };
    const service = assemble(
      new TenantContextService(),
      { findOne: vi.fn().mockReturnValue(query(runRecord())) },
      attachments,
      queue,
      {},
      {},
    );

    await service.process(jobData());

    const queued = queue.add.mock.calls[0]?.[1] as DataMigrationAttachmentJobData;
    const options = queue.add.mock.calls[0]?.[2] as { jobId?: string; attempts?: number };
    expect(queued).toMatchObject({ tenantId: 'tenant-001', runId: RUN_ID });
    expect(queued.dispatchId).not.toBe(DISPATCH_ID);
    expect(options).toMatchObject({
      jobId: createDataMigrationAttachmentJobId(queued),
      attempts: 6,
    });
    const remainingFilter = attachments.countDocuments.mock.calls[0]?.[0] as {
      $or: ReadonlyArray<Record<string, unknown>>;
    };
    expect(remainingFilter.$or).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'pending', attempts: { $lt: 5 } }),
      expect.objectContaining({ status: 'processing', attempts: { $lt: 5 } }),
    ]));
  });

  it('第五次失败固定为耗尽拒绝码', async () => {
    const attachment = attachmentRecord({ attempts: 5 });
    const attachments = {
      findOneAndUpdate: vi.fn()
        .mockReturnValueOnce(query(attachment))
        .mockReturnValueOnce(query(null)),
      updateOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ modifiedCount: 1 }),
      }),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const service = assemble(
      new TenantContextService(),
      { findOne: vi.fn().mockReturnValue(query(runRecord())) },
      attachments,
      {},
      { transfer: vi.fn().mockRejectedValue(new Error('unknown')) },
      { recordSystem: vi.fn() },
    );

    await expect(service.process(jobData())).resolves.toBeUndefined();
    const rejectionUpdate: unknown = attachments.updateOne.mock.calls[0]?.[1];
    expect(attachments.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(rejectionUpdate).toMatchObject({
      $set: {
        status: 'rejected',
        rejectionCode: 'DATA_MIGRATION_ATTACHMENT_RETRY_EXHAUSTED',
      },
    });
  });

  it.each([2_554, 36_501, 2_555.5])(
    '非法保留期 %s 在外呼前失败并恢复 pending',
    async (retentionDays) => {
      const attachment = attachmentRecord();
      const gateway = { transfer: vi.fn() };
      const attachments = {
        findOneAndUpdate: vi.fn().mockReturnValueOnce(query(attachment)),
        updateOne: vi.fn().mockReturnValue({
          exec: () => Promise.resolve({ modifiedCount: 1 }),
        }),
      };
      const service = assemble(
        new TenantContextService(),
        { findOne: vi.fn().mockReturnValue(query(runRecord())) },
        attachments,
        {},
        gateway,
        { recordSystem: vi.fn() },
        { finalizeMigration: vi.fn() },
        retentionDays,
      );

      await expect(service.process(jobData()))
        .rejects.toThrow('DATA_MIGRATION_ATTACHMENT_RETENTION_INVALID');
      expect(gateway.transfer).not.toHaveBeenCalled();
      const retryUpdate: unknown = attachments.updateOne.mock.calls[0]?.[1];
      expect(attachments.updateOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(retryUpdate).toMatchObject({ $set: { status: 'pending' } });
    },
  );
});

function assemble(
  context: TenantContextService,
  runs: object,
  attachments: object,
  queue: object,
  gateway: object,
  audit: object,
  businessAttachments: object = { finalizeMigration: vi.fn() },
  retentionDays = 2_555,
): DataMigrationAttachmentService {
  return new DataMigrationAttachmentService(
    context,
    gateway as DataMigrationAttachmentGateway,
    audit as AuditService,
    { get: () => retentionDays } as unknown as ConfigService<AppEnvironment, true>,
    queue as Queue<DataMigrationAttachmentJobData>,
    runs as Model<DataMigrationRunDocument>,
    attachments as Model<DataMigrationAttachmentDocument>,
    businessAttachments as never,
  );
}
