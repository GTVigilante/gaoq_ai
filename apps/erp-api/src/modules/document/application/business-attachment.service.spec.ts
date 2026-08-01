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

function stored(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4A1',
    tenantId: tenant.tenantId,
    ownerType: 'recruitment.candidate',
    ownerId: '01J8ZQK7V0A2M4N6P8R0T2W4C1',
    purpose: 'candidate_resume',
    uploadedByEmployeeId: 'employee-recruiter',
    businessCreatedAt: new Date('2026-07-22T09:00:00.000Z'),
    contentChecksum: 'r'.repeat(43),
    migrationEvidenceRef: REF,
    migrationEvidenceChecksum: 'r'.repeat(43),
    objectEvidenceId: null,
    availableAt: null,
    status: 'migration_pending',
    version: 1,
    createdAt: new Date('2026-07-22T09:00:01.000Z'),
    updatedAt: new Date('2026-07-22T09:00:01.000Z'),
    ...overrides,
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
    const record = stored();
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
    expect(store.records.findOne).toHaveBeenCalledWith(
      { tenantId: tenant.tenantId, migrationEvidenceRef: REF },
      expect.objectContaining({ tenantId: 1, objectEvidenceId: 1, _id: 0 }),
    );
  });

  it('领域写入成功但映射未落账时可用同一来源快照恢复', async () => {
    const record = stored();
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

  it.each([
    null,
    { ...input(), accessToken: 'forbidden' },
    { ...input(), targetId: 'not-a-ulid' },
    { ...input(), ownerId: '$bad' },
    { ...input(), uploadedByEmployeeId: '' },
    { ...input(), migrationEvidenceRef: 'erp://other/run' },
    { ...input(), evidenceChecksum: 'short' },
    { ...input(), businessCreatedAt: '2026-07-22T09:00:00Z' },
    { ...input(), businessCreatedAt: '2099-01-01T00:00:00.000Z' },
  ])('严格拒绝受损或带未知字段的迁移输入 %#', async (candidate) => {
    const store = setup();
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.importFromMigration(
        'business-attachment-invalid-shape',
        candidate as ReturnType<typeof input>,
      ),
    )).rejects.toThrow('业务附件');
    expect(store.records.findOne).not.toHaveBeenCalled();
    expect(store.records.create).not.toHaveBeenCalled();
  });

  it.each([
    stored({ tenantId: 'tenant-other' }),
    stored({ migrationEvidenceRef: REF.replace('resume-001', 'resume-other') }),
    stored({ contentChecksum: 's'.repeat(43) }),
    stored({ ownerType: 'approval.instance' }),
    stored({ objectEvidenceId: 'worm/unexpected' }),
    stored({ status: 'available', version: 1 }),
    stored({ createdAt: 'not-a-date' }),
    { ...stored(), providerToken: 'forbidden' },
  ])('受损持久化最小投影失败关闭且不得创建或发布 %#', async (existing) => {
    const store = setup(existing);
    await expect(store.context.run({ tenant, actor }, () =>
      store.service.importFromMigration(
        'business-attachment-invalid-state',
        input(),
      ),
    )).rejects.toThrow('BUSINESS_ATTACHMENT_MIGRATION_STATE_INVALID');
    expect(store.records.create).not.toHaveBeenCalled();
    expect(store.outbox.migrated).not.toHaveBeenCalled();
  });

  it('同一来源快照的归属变化或预指定目标冲突不可覆盖', async () => {
    const changedOwner = setup(stored({
      ownerType: 'approval.instance',
      ownerId: 'approval-001',
      purpose: 'approval_attachment',
    }));
    await expect(changedOwner.context.run({ tenant, actor }, () =>
      changedOwner.service.importFromMigration(
        'business-attachment-owner-conflict',
        input(),
      ),
    )).rejects.toThrow('既有业务附件与来源快照不一致');

    const missingTarget = setup();
    await expect(missingTarget.context.run({ tenant, actor }, () =>
      missingTarget.service.importFromMigration(
        'business-attachment-target-conflict',
        { ...input(), targetId: '01J8ZQK7V0A2M4N6P8R0T2W4A2' },
      ),
    )).rejects.toThrow('既有业务附件与来源快照不一致');
    expect(missingTarget.records.create).not.toHaveBeenCalled();
  });

  it.each([
    ['', RUN_ID, 'resume-001', 'r'.repeat(43), 'worm/evidence'],
    [tenant.tenantId, 'bad-run', 'resume-001', 'r'.repeat(43), 'worm/evidence'],
    [tenant.tenantId, RUN_ID, '$bad', 'r'.repeat(43), 'worm/evidence'],
    [tenant.tenantId, RUN_ID, 'resume-001', 'short', 'worm/evidence'],
    [tenant.tenantId, RUN_ID, 'resume-001', 'r'.repeat(43), '../escape'],
  ])('非法网关回执在事务前失败关闭 %#', async (
    tenantId,
    runId,
    sourceAttachmentId,
    checksum,
    targetEvidenceId,
  ) => {
    const store = setup();
    await expect(store.service.finalizeMigration(
      tenantId,
      runId,
      sourceAttachmentId,
      checksum,
      targetEvidenceId,
    )).rejects.toThrow('BUSINESS_ATTACHMENT_MIGRATION_RECEIPT_INVALID');
    expect(store.connection.transaction).not.toHaveBeenCalled();
  });

  it('未登记的附件回执返回 false 且无写入副作用', async () => {
    const store = setup();
    await expect(store.service.finalizeMigration(
      tenant.tenantId,
      RUN_ID,
      'resume-001',
      'r'.repeat(43),
      'worm/migration/resume-001',
    )).resolves.toBe(false);
    expect(store.records.updateOne).not.toHaveBeenCalled();
    expect(store.outbox.migrated).not.toHaveBeenCalled();
  });

  it('回执摘要错位失败关闭且不写状态或 Outbox', async () => {
    const store = setup(stored());
    await expect(store.service.finalizeMigration(
      tenant.tenantId,
      RUN_ID,
      'resume-001',
      's'.repeat(43),
      'worm/migration/resume-001',
    )).rejects.toThrow('BUSINESS_ATTACHMENT_MIGRATION_CHECKSUM_MISMATCH');
    expect(store.records.updateOne).not.toHaveBeenCalled();
    expect(store.outbox.migrated).not.toHaveBeenCalled();
  });

  it.each([
    stored({ tenantId: 'tenant-other' }),
    stored({ migrationEvidenceChecksum: 's'.repeat(43) }),
    stored({ objectEvidenceId: 'worm/unexpected' }),
    stored({ version: 2 }),
    stored({ status: 'available', objectEvidenceId: null }),
  ])('受损待激活状态不得写对象证据或 Outbox %#', async (existing) => {
    const store = setup(existing);
    await expect(store.service.finalizeMigration(
      tenant.tenantId,
      RUN_ID,
      'resume-001',
      'r'.repeat(43),
      'worm/migration/resume-001',
    )).rejects.toThrow('BUSINESS_ATTACHMENT_MIGRATION_STATE_INVALID');
    expect(store.records.updateOne).not.toHaveBeenCalled();
    expect(store.outbox.migrated).not.toHaveBeenCalled();
  });

  it('已激活附件只接受同一对象证据幂等恢复', async () => {
    const available = stored({
      status: 'available',
      version: 2,
      objectEvidenceId: 'worm/migration/resume-001',
      availableAt: new Date('2026-07-22T09:05:00.000Z'),
    });
    const same = setup(available);
    await expect(same.service.finalizeMigration(
      tenant.tenantId,
      RUN_ID,
      'resume-001',
      'r'.repeat(43),
      'worm/migration/resume-001',
    )).resolves.toBe(true);
    expect(same.records.updateOne).not.toHaveBeenCalled();
    expect(same.outbox.migrated).not.toHaveBeenCalled();

    const conflict = setup(available);
    await expect(conflict.service.finalizeMigration(
      tenant.tenantId,
      RUN_ID,
      'resume-001',
      'r'.repeat(43),
      'worm/migration/other',
    )).rejects.toThrow('BUSINESS_ATTACHMENT_MIGRATION_IMMUTABLE');
    expect(conflict.records.updateOne).not.toHaveBeenCalled();
  });

  it('版本 CAS 丢失时不得发布可用事件', async () => {
    const store = setup(stored());
    store.records.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(store.service.finalizeMigration(
      tenant.tenantId,
      RUN_ID,
      'resume-001',
      'r'.repeat(43),
      'worm/migration/resume-001',
    )).rejects.toThrow('BUSINESS_ATTACHMENT_MIGRATION_CONFLICT');
    expect(store.outbox.migrated).not.toHaveBeenCalled();
  });
});
