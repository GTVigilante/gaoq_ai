import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnvironment } from '../../../config/environment.js';
import type { AuditService } from '../../../core/audit/audit.service.js';
import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { DataMigrationAttachmentJobData } from '../data-migration-attachment.queue.js';
import type { DataMigrationAttachmentGateway } from '../integration/data-migration-attachment.ports.js';
import type {
  DataMigrationAttachmentDocument,
  DataMigrationRunDocument,
} from '../persistence/data-migration.schemas.js';
import { DataMigrationAttachmentService } from './data-migration-attachment.service.js';

const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';

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
      expectedSourceCount: 2,
    })) };
    const attachments = { countDocuments: vi.fn().mockReturnValue({
      exec: () => Promise.resolve(3),
    }) };
    const queue = { add: vi.fn() };
    const service = assemble(context, runs, attachments, queue, {}, {});

    const result = await trusted(context, () => service.request(RUN_ID));

    expect(result).toEqual({ runId: RUN_ID, status: 'queued', pendingCount: 3 });
    const jobData = queue.add.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(jobData).toEqual({ tenantId: 'tenant-001', runId: RUN_ID });
    expect(JSON.stringify(jobData)).not.toMatch(/attachment|checksum|token/iu);
  });

  it('网关回执通过后把附件标记为 verified 并记录系统审计', async () => {
    const context = new TenantContextService();
    const attachment = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F2', tenantId: 'tenant-001', runId: RUN_ID,
      sequence: 1, sourceAttachmentId: 'legacy-file-001', checksum: 'c'.repeat(43),
      status: 'processing', attempts: 1, processingStartedAt: new Date(),
      targetEvidenceId: null, rejectionCode: null,
    };
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr',
      scope: 'recruitment_offers', status: 'running',
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

    await service.process({ tenantId: 'tenant-001', runId: RUN_ID });

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

    await service.process({ tenantId: 'tenant-001', runId: RUN_ID });

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

    await expect(service.process({ tenantId: 'tenant-001', runId: RUN_ID }))
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
      status: 'processing', attempts: 1, processingStartedAt: new Date(),
      targetEvidenceId: null, rejectionCode: null,
    };
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr',
      scope: 'recruitment_offers', status: 'running',
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

    await expect(service.process({ tenantId: 'tenant-001', runId: RUN_ID })).resolves.toBeUndefined();

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
      status: 'processing', attempts: 1, processingStartedAt: new Date(),
      targetEvidenceId: null, rejectionCode: null,
    };
    const runs = { findOne: vi.fn().mockReturnValue(query({
      id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr',
      scope: 'recruitment_offers', status: 'running',
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

    await expect(service.process({ tenantId: 'tenant-001', runId: RUN_ID }))
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
    })) };
    const attachments = {
      findOneAndUpdate: vi.fn().mockReturnValue(query(null)),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    const queue = { add: vi.fn() };
    const service = assemble(context, runs, attachments, queue, {}, {});

    await service.process({ tenantId: 'tenant-001', runId: RUN_ID });

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
});

function assemble(
  context: TenantContextService,
  runs: object,
  attachments: object,
  queue: object,
  gateway: object,
  audit: object,
  businessAttachments: object = { finalizeMigration: vi.fn() },
): DataMigrationAttachmentService {
  return new DataMigrationAttachmentService(
    context,
    gateway as DataMigrationAttachmentGateway,
    audit as AuditService,
    { get: () => 2_555 } as unknown as ConfigService<AppEnvironment, true>,
    queue as Queue<DataMigrationAttachmentJobData>,
    runs as Model<DataMigrationRunDocument>,
    attachments as Model<DataMigrationAttachmentDocument>,
    businessAttachments as never,
  );
}
