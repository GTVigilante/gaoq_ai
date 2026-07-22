import type { ActorContext } from '@gaoq/shared-types';
import type { ClientSession } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { BusinessAttachmentService } from './business-attachment.service.js';

const tenant = { tenantId: 'tenant-001', source: 'service_identity' as const };
const actor: ActorContext = {
  actorType: 'service', actorId: 'migration-document-worker', tenantId: tenant.tenantId,
  roleCodes: [], scopes: ['erp:migration:execute', 'erp:document:migration:write'],
  departmentIds: [], traceId: 'trace-business-attachment',
};
const session = {} as ClientSession;
const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';
const REF = `erp://data-migrations/runs/${RUN_ID}/attachments/resume-001`;

function query<T>(value: T) {
  const result = { session: vi.fn(), lean: vi.fn(), exec: vi.fn().mockResolvedValue(value) };
  result.session.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  return result;
}

function input() {
  return {
    targetId: null, ownerType: 'recruitment.candidate' as const,
    ownerId: '01J8ZQK7V0A2M4N6P8R0T2W4C1', purpose: 'candidate_resume' as const,
    uploadedByEmployeeId: 'employee-recruiter',
    businessCreatedAt: '2026-07-22T09:00:00.000Z',
    migrationEvidenceRef: REF, evidenceChecksum: 'r'.repeat(43),
  };
}

function setup(existing: unknown = null) {
  const context = new TenantContextService();
  const records = {
    findOne: vi.fn().mockReturnValue(query(existing)),
    create: vi.fn().mockResolvedValue([]),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const idempotency = { execute: vi.fn(async (
    _operation: string, _key: string, _request: unknown,
    handler: (value: ClientSession) => Promise<unknown>,
  ) => handler(session)) };
  const connection = { transaction: vi.fn(async (
    handler: (value: ClientSession) => Promise<unknown>,
  ) => handler(session)) };
  const outbox = { migrated: vi.fn().mockResolvedValue(undefined) };
  const service = new BusinessAttachmentService(
    idempotency as never, context, connection as never, records as never, outbox as never,
  );
  return { context, records, connection, outbox, service };
}

describe('BusinessAttachmentService', () => {
  it('迁移应用阶段只登记不可用元数据，不伪造对象回执', async () => {
    const store = setup();
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.importFromMigration('business-attachment-import', input()));
    expect(result).toMatchObject({
      ownerType: 'recruitment.candidate', purpose: 'candidate_resume',
      status: 'migration_pending', version: 1,
    });
    const created = store.records.create.mock.calls[0]?.[0] as unknown;
    expect(created).toEqual([expect.objectContaining({
      objectEvidenceId: null, availableAt: null, contentChecksum: 'r'.repeat(43),
    })]);
    expect(JSON.stringify(created)).not.toMatch(/fileName|originalName|contentType|fileBody/u);
    expect(store.outbox.migrated).not.toHaveBeenCalled();
  });

  it('隔离网关回执后在同一事务激活附件并发布专用迁移事件', async () => {
    const record = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', tenantId: tenant.tenantId,
      ownerType: 'recruitment.candidate', ownerId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
      purpose: 'candidate_resume', uploadedByEmployeeId: 'employee-recruiter',
      businessCreatedAt: new Date('2026-07-22T09:00:00.000Z'),
      contentChecksum: 'r'.repeat(43), migrationEvidenceRef: REF,
      migrationEvidenceChecksum: 'r'.repeat(43), objectEvidenceId: null,
      availableAt: null, status: 'migration_pending', version: 1,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const store = setup(record);
    const result = await store.service.finalizeMigration(
      tenant.tenantId, RUN_ID, 'resume-001', 'r'.repeat(43), 'worm/migration/resume-001',
    );
    expect(result).toBe(true);
    expect(store.records.updateOne).toHaveBeenCalled();
    expect(JSON.stringify(store.records.updateOne.mock.calls)).toContain(
      '"objectEvidenceId":"worm/migration/resume-001"',
    );
    expect(store.outbox.migrated).toHaveBeenCalledWith(record, RUN_ID, expect.any(Date), session);
  });

  it('领域写入成功但映射未落账时可用同一来源快照恢复', async () => {
    const record = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4A1', tenantId: tenant.tenantId,
      ownerType: 'recruitment.candidate', ownerId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
      purpose: 'candidate_resume', uploadedByEmployeeId: 'employee-recruiter',
      businessCreatedAt: new Date('2026-07-22T09:00:00.000Z'),
      contentChecksum: 'r'.repeat(43), migrationEvidenceRef: REF,
      migrationEvidenceChecksum: 'r'.repeat(43), objectEvidenceId: null,
      availableAt: null, status: 'migration_pending', version: 1,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const store = setup(record);
    const result = await store.context.run({ tenant, actor }, () =>
      store.service.importFromMigration('business-attachment-recovery', input()));
    expect(result).toEqual({
      id: record.id, ownerType: record.ownerType, ownerId: record.ownerId,
      purpose: record.purpose, status: record.status, version: record.version,
    });
    expect(store.records.create).not.toHaveBeenCalled();
  });

  it('缺少业务附件迁移权限时拒绝执行', async () => {
    const store = setup();
    await expect(store.context.run({ tenant, actor: {
      ...actor, scopes: ['erp:migration:execute'],
    } }, () => store.service.importFromMigration('business-attachment-denied', input())))
      .rejects.toThrow('业务附件迁移必须由受信任服务身份执行');
    expect(store.records.findOne).not.toHaveBeenCalled();
  });

  it('附件用途与归属类型不一致时失败关闭', async () => {
    const store = setup();
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.importFromMigration('business-attachment-invalid', {
        ...input(), ownerType: 'approval.instance',
      }))).rejects.toThrow('业务附件迁移输入非法');
    expect(store.records.create).not.toHaveBeenCalled();
  });
});
