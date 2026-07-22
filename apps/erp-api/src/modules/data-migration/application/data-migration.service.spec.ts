import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type { OrgApplicationService } from '../../org/application/org-application.service.js';
import type {
  DataMigrationAssociationDocument,
  DataMigrationAttachmentDocument,
  DataMigrationItemDocument,
  DataMigrationMappingDocument,
  DataMigrationRunDocument,
} from '../persistence/data-migration.schemas.js';
import { DataMigrationService, dataMigrationChecksum } from './data-migration.service.js';

const RUN_ID = '01J8ZQK7V0A2M4N6P8R0T2W4F1';

function trusted<T>(context: TenantContextService, action: () => T): T {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'service_identity' },
    actor: {
      actorId: 'migration-agent-001', actorType: 'service', tenantId: 'tenant-001',
      roleCodes: ['migration'], scopes: [
        'erp:migration:execute', 'erp:org:master:write', 'erp:approval:migration:write',
      ],
      departmentIds: [], traceId: 'trace-migration-001',
    },
  }, action);
}

function reader<T>(context: TenantContextService, action: () => T): T {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'access_token' },
    actor: {
      actorId: 'auditor-001', actorType: 'user', tenantId: 'tenant-001',
      roleCodes: ['auditor'], scopes: ['erp:migration:read'], departmentIds: [],
      traceId: 'trace-migration-report-001',
    },
  }, action);
}

function evidenceReader<T>(context: TenantContextService, action: () => T): T {
  return context.run({
    tenant: { tenantId: 'tenant-001', source: 'access_token' },
    actor: {
      actorId: 'migration-auditor-001', actorType: 'user', tenantId: 'tenant-001',
      roleCodes: ['migration_auditor'],
      scopes: ['erp:migration:read', 'erp:migration:evidence:export'],
      departmentIds: [], traceId: 'trace-migration-evidence-001',
    },
  }, action);
}

function run() {
  return {
    id: RUN_ID, tenantId: 'tenant-001', sourceSystem: 'legacy-hr', sourceRunId: 'full-001',
    mode: 'full' as const, scope: 'org_reference' as const, expectedSourceCount: 1,
    expectedSourceChecksum: 'e'.repeat(43), sourceChecksum: dataMigrationChecksum.empty,
    targetChecksum: dataMigrationChecksum.empty, checkpoint: 0, status: 'running' as const,
    completedAt: null,
  };
}

function workforceRun() {
  return { ...run(), scope: 'org_workforce' as const };
}

function employmentRun() {
  return { ...run(), scope: 'org_employment' as const };
}

function approvalTemplateRun() {
  return { ...run(), scope: 'approval_templates' as const };
}

function query<T>(value: T) { return { lean: () => ({ exec: () => Promise.resolve(value) }) }; }
function listQuery<T>(value: readonly T[]) {
  return {
    sort: () => ({
      limit: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
    }),
  };
}

describe('DataMigrationService', () => {
  it('目标写入复用组织应用服务且账本不持久化来源正文', async () => {
    const context = new TenantContextService();
    const payload = { code: 'POS-001', name: '产品经理', status: 'active' };
    const input = {
      sequence: 1, sourceRecordId: 'legacy-position-001', sourceVersion: '1',
      entityType: 'org.position' as const, payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [], attachments: [],
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(run())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = {
      findOne: vi.fn().mockReturnValue(query(null)),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'position-001' })),
    };
    const associations = {};
    const attachments = {};
    const organization = {
      createPosition: vi.fn().mockResolvedValue({ position: {
        id: 'position-001', tenantId: 'tenant-001', code: 'POS-001', name: '产品经理',
        status: 'active', version: 1,
        createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
      } }),
    };
    const service = new DataMigrationService(
      context, organization as unknown as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
    );
    const result = await trusted(context, () => service.apply(RUN_ID, input));
    expect(result).toMatchObject({ status: 'applied', targetId: 'position-001', targetVersion: 1 });
    expect(organization.createPosition).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u), payload,
    );
    expect(items.create).toHaveBeenCalledWith(expect.objectContaining({
      payloadHash: input.payloadHash, targetId: 'position-001', status: 'applied',
    }));
    const createdItem = items.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(createdItem.sourceFactHash).toMatch(/^[\w-]{43}$/u);
    expect(createdItem).not.toHaveProperty('payload');
  });

  it('未知基础设施故障不伪装为业务拒绝，也不推进检查点', async () => {
    const context = new TenantContextService();
    const payload = { code: 'POS-001', name: '产品经理', status: 'active' };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(run())), updateOne: vi.fn(),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = { findOne: vi.fn().mockReturnValue(query(null)) };
    const associations = {};
    const attachments = {};
    const organization = { createPosition: vi.fn().mockRejectedValue(new Error('ECONNRESET')) };
    const service = new DataMigrationService(
      context, organization as unknown as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
    );
    await expect(trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-position-001', sourceVersion: '1',
      entityType: 'org.position', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [], attachments: [],
    }))).rejects.toThrow('ECONNRESET');
    expect(items.create).not.toHaveBeenCalled();
    expect(runs.updateOne).not.toHaveBeenCalled();
  });

  it('逐项保存已解析关联与附件校验和，但不保存附件正文', async () => {
    const context = new TenantContextService();
    const payload = {
      code: 'DEP-002', name: '产品部', status: 'active',
      parentSourceId: 'legacy-department-001', sortOrder: 20,
    };
    const input = {
      sequence: 1, sourceRecordId: 'legacy-department-002', sourceVersion: '1',
      entityType: 'org.department' as const, payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: ['legacy-department-001'],
      attachments: [{ sourceAttachmentId: 'legacy-file-001', checksum: 'a'.repeat(43) }],
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(run())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const parentMapping = { targetId: 'department-001', targetVersion: 1 };
    const mappings = {
      findOne: vi.fn()
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(parentMapping))
        .mockReturnValueOnce(query(parentMapping))
        .mockReturnValueOnce(query(parentMapping)),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'department-002' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 0 }) }),
    };
    const organization = {
      createDepartment: vi.fn().mockResolvedValue({ department: {
        id: 'department-002', tenantId: 'tenant-001', code: 'DEP-002', name: '产品部',
        status: 'active', parentId: 'department-001', managerId: null, sortOrder: 20,
        version: 1, createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      } }),
    };
    const service = new DataMigrationService(
      context, organization as unknown as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
    );
    await trusted(context, () => service.apply(RUN_ID, input));
    expect(associations.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAssociationId: 'legacy-department-001' }),
      expect.objectContaining({ $set: { targetId: 'department-001', status: 'resolved' } }),
      expect.objectContaining({ upsert: true }),
    );
    expect(attachments.updateOne).toHaveBeenCalledOnce();
    const attachmentQuery = attachments.updateOne.mock.calls[0]?.[0] as unknown as
      Record<string, unknown>;
    const attachmentUpdate = attachments.updateOne.mock.calls[0]?.[1] as unknown as {
      $setOnInsert?: Record<string, unknown>;
    };
    const attachmentOptions = attachments.updateOne.mock.calls[0]?.[2] as unknown as
      Record<string, unknown>;
    expect(attachmentQuery).toMatchObject({
      sourceAttachmentId: 'legacy-file-001', checksum: 'a'.repeat(43),
    });
    expect(attachmentUpdate.$setOnInsert?.status).toBe('pending');
    expect(attachmentOptions.upsert).toBe(true);
    expect(JSON.stringify(attachments.updateOne.mock.calls)).not.toContain('attachmentContent');
  });

  it('重复映射仍执行本批次关联白名单校验', async () => {
    const context = new TenantContextService();
    const payload = { code: 'POS-001', name: '产品经理', status: 'active' };
    const payloadHash = dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload));
    const runs = {
      findOne: vi.fn().mockReturnValue(query(run())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = { findOne: vi.fn().mockReturnValue(query({
      payloadHash, targetId: 'position-001', targetVersion: 1, targetHash: 't'.repeat(43),
      lastRunId: '01J8ZQK7V0A2M4N6P8R0T2W4F0', lastSequence: 1,
    })) };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {};
    const organization = { createPosition: vi.fn(), updatePosition: vi.fn() };
    const service = new DataMigrationService(
      context, organization as unknown as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
    );
    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-position-001', sourceVersion: '1',
      entityType: 'org.position', payload, payloadHash,
      associationSourceIds: ['unexpected-department'], attachments: [],
    }));
    expect(result).toMatchObject({
      status: 'rejected', rejectionCode: 'DATA_MIGRATION_ASSOCIATION_DECLARATION_MISMATCH',
    });
    expect(organization.createPosition).not.toHaveBeenCalled();
    expect(organization.updatePosition).not.toHaveBeenCalled();
  });

  it('员工迁移把来源组织引用解析为 ERP 主数据 ID', async () => {
    const context = new TenantContextService();
    const payload = {
      employeeNo: 'E1001', displayName: '迁移员工', status: 'active',
      departmentSourceIds: ['legacy-department-001'],
      primaryDepartmentSourceId: 'legacy-department-001',
      positionSourceIds: ['legacy-position-001'], jobLevelSourceId: 'legacy-level-001',
    };
    const input = {
      sequence: 1, sourceRecordId: 'legacy-employee-001', sourceVersion: '1',
      entityType: 'org.employee' as const, payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [
        'legacy-department-001', 'legacy-position-001', 'legacy-level-001',
      ],
      attachments: [],
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(workforceRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const targetIds: Readonly<Record<string, string>> = {
      'legacy-department-001': 'department-001',
      'legacy-position-001': 'position-001',
      'legacy-level-001': 'level-001',
    };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string; sourceRecordId: string }) => query(
        filter.entityType === 'org.employee'
          ? null
          : { targetId: targetIds[filter.sourceRecordId], targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'employee-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {};
    const organization = {
      createEmployee: vi.fn().mockResolvedValue({ employee: {
        id: 'employee-001', tenantId: 'tenant-001', employeeNo: 'E1001',
        displayName: '迁移员工', status: 'active', departmentIds: ['department-001'],
        primaryDepartmentId: 'department-001', positionIds: ['position-001'],
        jobLevelId: 'level-001', version: 1,
        createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
      } }),
    };
    const service = new DataMigrationService(
      context, organization as unknown as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
    );

    const result = await trusted(context, () => service.apply(RUN_ID, input));

    expect(result).toMatchObject({ status: 'applied', targetId: 'employee-001' });
    expect(organization.createEmployee).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      {
        employeeNo: 'E1001', displayName: '迁移员工', status: 'active',
        departmentIds: ['department-001'], primaryDepartmentId: 'department-001',
        positionIds: ['position-001'], jobLevelId: 'level-001',
      },
    );
    expect(associations.findOneAndUpdate).toHaveBeenCalledTimes(4);
  });

  it('劳动关系迁移只经组织应用服务绑定已映射员工并保留关联证据', async () => {
    const context = new TenantContextService();
    const payload = {
      employeeSourceId: 'legacy-employee-001', sourcePersonId: 'legacy-person-001',
      identityEvidenceId: 'identity-evidence-001',
      onboardingInstanceId: 'legacy-onboarding-001',
      onboardingCompletionEvidenceId: 'onboarding-evidence-001',
      offerId: 'legacy-offer-001', signedEvidenceId: 'signed-evidence-001',
      status: 'active', effectiveFrom: '2018-01-01', effectiveTo: null,
      terminationCareCaseId: null, terminationExecutionEvidenceId: null,
      terminationEvidenceId: null,
    };
    const input = {
      sequence: 1, sourceRecordId: 'legacy-employment-001', sourceVersion: '1',
      entityType: 'org.employment' as const, payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: ['legacy-employee-001'], attachments: [],
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(employmentRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const employeeMapping = { targetId: 'employee-001', targetVersion: 1 };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string }) => query(
        filter.entityType === 'org.employment' ? null : employeeMapping,
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'employment-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const organization = {
      importEmploymentFromMigration: vi.fn().mockResolvedValue({
        employment: {
          id: 'employment-001', tenantId: 'tenant-001', personId: 'person-001',
          employeeId: 'employee-001', onboardingInstanceId: 'legacy-onboarding-001',
          onboardingCompletionEvidenceId: 'onboarding-evidence-001',
          offerId: 'legacy-offer-001', signedEvidenceId: 'signed-evidence-001',
          status: 'active', effectiveFrom: '2018-01-01', effectiveTo: null,
          terminationCareCaseId: null, terminationExecutionEvidenceId: null,
          terminationEvidenceId: null, version: 1,
          createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
        },
        personId: 'person-001',
      }),
    };
    const service = new DataMigrationService(
      context, organization as unknown as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      {} as Model<DataMigrationAttachmentDocument>,
    );

    const result = await trusted(context, () => service.apply(RUN_ID, input));

    expect(result).toMatchObject({ status: 'applied', targetId: 'employment-001' });
    expect(organization.importEmploymentFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({ employeeId: 'employee-001', sourcePersonId: 'legacy-person-001' }),
    );
    expect(associations.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: 'employee' }),
      expect.objectContaining({ $set: { targetId: 'employee-001', status: 'resolved' } }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('审批模板迁移解析责任员工、要求治理附件并只调用审批应用服务', async () => {
    const context = new TenantContextService();
    const payload = {
      code: 'LEGACY_EXPENSE', name: '历史费用审批', riskLevel: 'R2', revision: 1,
      status: 'published',
      definition: {
        fields: [{
          key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2',
        }, {
          key: 'department_id', label: '部门', type: 'department',
          required: true, sensitivity: 'L2',
        }],
        nodes: [{
          id: 'manager', name: '经理审批', type: 'approval', approvalMode: 'all',
          resolver: { type: 'employees', employeeIds: ['legacy-employee-manager'] },
          condition: { op: 'eq', field: 'department_id', value: 'legacy-department-finance' },
        }],
      },
      createdByEmployeeSourceId: 'legacy-employee-editor',
      updatedByEmployeeSourceId: 'legacy-employee-approver',
      approvedByEmployeeSourceId: 'legacy-employee-approver',
      governanceEvidenceSourceAttachmentId: 'legacy-template-evidence-001',
      publishedAt: '2020-01-02T00:00:00.000Z', retiredAt: null,
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z',
    };
    const input = {
      sequence: 1, sourceRecordId: 'legacy-template-001', sourceVersion: '1',
      entityType: 'approval.template' as const, payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [
        'legacy-employee-editor', 'legacy-employee-approver', 'legacy-employee-manager',
        'legacy-department-finance',
      ],
      attachments: [{ sourceAttachmentId: 'legacy-template-evidence-001', checksum: 'a'.repeat(43) }],
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(approvalTemplateRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const employeeTargets: Readonly<Record<string, string>> = {
      'legacy-employee-editor': 'employee-editor',
      'legacy-employee-approver': 'employee-approver',
      'legacy-employee-manager': 'employee-manager',
      'legacy-department-finance': 'department-finance',
    };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string; sourceRecordId: string }) => query(
        filter.entityType === 'approval.template'
          ? null
          : { targetId: employeeTargets[filter.sourceRecordId], targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'template-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 0 }) }),
    };
    const approvals = {
      importTemplateFromMigration: vi.fn().mockResolvedValue({ template: {
        id: 'template-001', tenantId: 'tenant-001', code: 'LEGACY_EXPENSE',
        name: '历史费用审批', riskLevel: 'R2', revision: 1, status: 'published',
        definition: payload.definition, definitionHash: 'd'.repeat(43),
        createdBy: 'actor-editor', updatedBy: 'actor-approver', approvedBy: 'actor-approver',
        publishedAt: payload.publishedAt, retiredAt: null, version: 1,
        createdAt: payload.createdAt, updatedAt: payload.updatedAt,
      } }),
    };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
      approvals as unknown as ApprovalApplicationService,
    );

    const result = await trusted(context, () => service.apply(RUN_ID, input));

    expect(result).toMatchObject({ status: 'applied', targetId: 'template-001' });
    expect(approvals.importTemplateFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.any(Object),
    );
    const approvalCommand = approvals.importTemplateFromMigration.mock.calls[0]?.[1] as unknown;
    expect(approvalCommand).toMatchObject({
      createdByEmployeeId: 'employee-editor',
      updatedByEmployeeId: 'employee-approver',
      approvedByEmployeeId: 'employee-approver',
      definition: {
        nodes: [expect.objectContaining({
          resolver: { type: 'employees', employeeIds: ['employee-manager'] },
          condition: { op: 'eq', field: 'department_id', value: 'department-finance' },
        })],
      },
    });
    expect(associations.findOneAndUpdate).toHaveBeenCalledTimes(5);
  });

  it('已发布审批模板缺少治理附件时拒绝且不调用领域服务', async () => {
    const context = new TenantContextService();
    const payload = {
      code: 'LEGACY', name: '历史审批', riskLevel: 'R1', revision: 1,
      status: 'published', definition: {
        fields: [{
          key: 'amount', label: '金额', type: 'money_minor', required: true, sensitivity: 'L2',
        }],
        nodes: [{
          id: 'manager', name: '经理审批', type: 'approval', approvalMode: 'all',
          resolver: { type: 'initiator_manager' },
        }],
      },
      createdByEmployeeSourceId: 'legacy-editor',
      updatedByEmployeeSourceId: 'legacy-approver',
      approvedByEmployeeSourceId: 'legacy-approver',
      governanceEvidenceSourceAttachmentId: 'legacy-template-evidence-001',
      publishedAt: '2020-01-02T00:00:00.000Z', retiredAt: null,
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z',
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(approvalTemplateRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = { findOne: vi.fn().mockReturnValue(query(null)) };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const approvals = { importTemplateFromMigration: vi.fn() };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      {} as Model<DataMigrationAttachmentDocument>,
      approvals as unknown as ApprovalApplicationService,
    );
    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-template-001', sourceVersion: '1',
      entityType: 'approval.template', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: ['legacy-editor', 'legacy-approver'], attachments: [],
    }));
    expect(result).toMatchObject({
      status: 'rejected', rejectionCode: 'DATA_MIGRATION_GOVERNANCE_EVIDENCE_REQUIRED',
    });
    expect(approvals.importTemplateFromMigration).not.toHaveBeenCalled();
  });

  it('规范 JSON 与滚动校验和不受对象字段顺序影响', () => {
    const left = dataMigrationChecksum.canonicalJson({ b: 2, a: { y: 2, x: 1 } });
    const right = dataMigrationChecksum.canonicalJson({ a: { x: 1, y: 2 }, b: 2 });
    expect(left).toBe(right);
    expect(dataMigrationChecksum.roll(
      dataMigrationChecksum.empty, 1, dataMigrationChecksum.digest(left),
    )).toHaveLength(43);
  });

  it('来源事实摘要覆盖实体、版本、关联与附件校验和', () => {
    const base = {
      sequence: 1, sourceRecordId: 'legacy-position-001', sourceVersion: '1',
      entityType: 'org.position' as const, payload: {}, payloadHash: 'p'.repeat(43),
      associationSourceIds: [] as string[], attachments: [] as {
        sourceAttachmentId: string; checksum: string;
      }[],
    };
    const changed = { ...base, sourceVersion: '2' };
    expect(dataMigrationChecksum.sourceFactHash(base))
      .not.toBe(dataMigrationChecksum.sourceFactHash(changed));
  });

  it('未解析关联和未决附件进入 Phase 6 硬门禁', async () => {
    const context = new TenantContextService();
    const completedRun = {
      ...run(), checkpoint: 1, sourceChecksum: 'e'.repeat(43), targetChecksum: 't'.repeat(43),
    };
    const runs = { findOne: vi.fn().mockReturnValue(query(completedRun)) };
    const items = { aggregate: vi.fn().mockReturnValue({
      exec: () => Promise.resolve([{ _id: 'applied', count: 1 }]),
    }) };
    const associations = { aggregate: vi.fn().mockReturnValue({
      exec: () => Promise.resolve([{ _id: 'missing', count: 1 }]),
    }) };
    const attachments = { aggregate: vi.fn().mockReturnValue({
      exec: () => Promise.resolve([{ _id: 'pending', count: 2 }]),
    }) };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      {} as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
    );

    const report = await reader(context, () => service.report(RUN_ID));

    expect(report).toMatchObject({
      associationCount: 1, unresolvedAssociationCount: 1,
      attachmentCount: 2, pendingAttachmentCount: 2, phaseSixEligible: false,
    });
    expect(report.differences.map((item) => item.code)).toEqual([
      'ASSOCIATION_UNRESOLVED', 'ATTACHMENT_MIGRATION_PENDING',
    ]);
  });

  it('证据分页只输出白名单字段并以页面校验和封装', async () => {
    const context = new TenantContextService();
    const frozenRun = { ...run(), status: 'completed' as const };
    const runs = { findOne: vi.fn().mockReturnValue(query(frozenRun)) };
    const ledger = {
      id: '01J8ZQK7V0A2M4N6P8R0T2W4F2', tenantId: 'tenant-001', runId: RUN_ID,
      sequence: 1, sourceRecordId: 'legacy-position-001', sourceVersion: '1',
      entityType: 'org.position', payloadHash: 'p'.repeat(43), sourceFactHash: 's'.repeat(43),
      status: 'applied', targetId: 'position-001', targetVersion: 1,
      targetHash: 't'.repeat(43), rejectionCode: null, associationCount: 0,
      attachmentCount: 0, payload: { displayName: '禁止泄露' },
    };
    const items = { find: vi.fn().mockReturnValue(listQuery([ledger, { ...ledger, sequence: 2 }])) };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      {} as Model<DataMigrationMappingDocument>,
      {} as Model<DataMigrationAssociationDocument>,
      {} as Model<DataMigrationAttachmentDocument>,
    );

    const page = await evidenceReader(context, () => service.evidence(RUN_ID, {
      kind: 'items', limit: 1,
    }));

    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(page.pageChecksum).toBe(dataMigrationChecksum.digest(
      dataMigrationChecksum.canonicalJson({
        runId: RUN_ID, kind: 'items', records: page.records,
        nextCursor: page.nextCursor,
      }),
    ));
    const serialized = JSON.stringify(page);
    for (const forbidden of [
      '"tenantId":', '"payload":', '"displayName":', '"createdAt":', '"updatedAt":',
    ]) expect(serialized).not.toContain(forbidden);
    expect(items.find).toHaveBeenCalledWith({ tenantId: 'tenant-001', runId: RUN_ID });
  });
});
