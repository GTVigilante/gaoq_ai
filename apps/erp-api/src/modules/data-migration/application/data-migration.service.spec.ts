import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import type { OrgApplicationService } from '../../org/application/org-application.service.js';
import type { RecruitmentManagementService } from '../../recruitment/application/recruitment-management.service.js';
import type { RecruitmentApplicationService } from '../../recruitment/application/recruitment-application.service.js';
import type { RecruitmentInterviewService } from '../../recruitment/application/recruitment-interview.service.js';
import type { RecruitmentOfferService } from '../../recruitment/application/recruitment-offer.service.js';
import type { AttendanceApplicationService } from '../../attendance/application/attendance-application.service.js';
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
        'erp:recruitment:migration:write',
        'erp:attendance:migration:write',
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

function approvalHistoryRun() {
  return { ...run(), scope: 'approval_history' as const };
}

function approvalActiveRun() {
  return { ...run(), scope: 'approval_active_instances' as const };
}

function recruitmentReferenceRun() {
  return { ...run(), scope: 'recruitment_reference' as const };
}

function recruitmentCandidatesRun() {
  return { ...run(), scope: 'recruitment_candidates' as const };
}

function recruitmentApplicationsRun() {
  return { ...run(), scope: 'recruitment_applications' as const };
}

function recruitmentInterviewsRun() {
  return { ...run(), scope: 'recruitment_interviews' as const };
}

function recruitmentOffersRun() {
  return { ...run(), scope: 'recruitment_offers' as const };
}

function attendanceSourceFactsRun() {
  return { ...run(), scope: 'attendance_source_facts' as const };
}

function attendanceCorrectionsRun() {
  return { ...run(), scope: 'attendance_corrections' as const };
}

function attendanceMonthlySnapshotsRun() {
  return { ...run(), scope: 'attendance_monthly_snapshots' as const };
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
      { findOne: vi.fn().mockReturnValue(query(null)) } as unknown as
        Model<DataMigrationAttachmentDocument>,
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

  it('已终结审批历史解析模板与员工并绑定唯一 WORM 迁移证据', async () => {
    const context = new TenantContextService();
    const payload = {
      templateSourceId: 'legacy-template-001',
      templateCode: 'LEGACY_EXPENSE',
      templateRevision: 1,
      initiatorEmployeeSourceId: 'legacy-employee-001',
      outcome: 'approved',
      completedAt: '2020-01-02T00:00:00.000Z',
      archivedAt: '2020-01-03T00:00:00.000Z',
      historyEvidenceSourceAttachmentId: 'legacy-history-evidence-001',
      historyEvidenceChecksum: 'a'.repeat(43),
    };
    const input = {
      sequence: 1, sourceRecordId: 'legacy-history-001', sourceVersion: '1',
      entityType: 'approval.history' as const, payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: ['legacy-template-001', 'legacy-employee-001'],
      attachments: [{
        sourceAttachmentId: 'legacy-history-evidence-001', checksum: 'a'.repeat(43),
      }],
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(approvalHistoryRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string }) => query(
        filter.entityType === 'approval.history'
          ? null
          : filter.entityType === 'approval.template'
            ? { targetId: 'template-001', targetVersion: 1 }
            : { targetId: 'employee-001', targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'history-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 0 }) }),
    };
    const approvals = {
      importLegacyHistoryFromMigration: vi.fn().mockResolvedValue({ history: {
        id: 'history-001', tenantId: 'tenant-001', templateId: 'template-001',
        templateCode: 'LEGACY_EXPENSE',
        templateRevision: 1, initiatorEmployeeId: 'employee-001', outcome: 'approved',
        completedAt: payload.completedAt, archivedAt: payload.archivedAt,
        migrationEvidenceRef:
          `erp://data-migrations/runs/${RUN_ID}/attachments/legacy-history-evidence-001`,
        evidenceChecksum: 'a'.repeat(43), version: 1,
        createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
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

    expect(result).toMatchObject({ status: 'applied', targetId: 'history-001' });
    expect(approvals.importLegacyHistoryFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({
        templateId: 'template-001',
        initiatorEmployeeId: 'employee-001',
        migrationEvidenceRef:
          `erp://data-migrations/runs/${RUN_ID}/attachments/legacy-history-evidence-001`,
        evidenceChecksum: 'a'.repeat(43),
      }),
    );
    expect(associations.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: 'template' }),
      expect.objectContaining({ $set: { targetId: 'template-001', status: 'resolved' } }),
      expect.objectContaining({ upsert: true }),
    );
    expect(associations.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: 'initiator' }),
      expect.objectContaining({ $set: { targetId: 'employee-001', status: 'resolved' } }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('审批历史证据摘要与附件不一致时失败关闭', async () => {
    const context = new TenantContextService();
    const payload = {
      templateSourceId: 'legacy-template-001', templateCode: 'LEGACY_EXPENSE',
      templateRevision: 1, initiatorEmployeeSourceId: 'legacy-employee-001',
      outcome: 'approved', completedAt: '2020-01-02T00:00:00.000Z', archivedAt: null,
      historyEvidenceSourceAttachmentId: 'legacy-history-evidence-001',
      historyEvidenceChecksum: 'a'.repeat(43),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(approvalHistoryRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const approvals = { importLegacyHistoryFromMigration: vi.fn() };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      { findOne: vi.fn().mockReturnValue(query(null)) } as unknown as
        Model<DataMigrationMappingDocument>,
      { findOneAndUpdate: vi.fn().mockReturnValue(query({})) } as unknown as
        Model<DataMigrationAssociationDocument>,
      {
        findOne: vi.fn().mockReturnValue(query(null)),
        updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 0 }) }),
      } as unknown as
        Model<DataMigrationAttachmentDocument>,
      approvals as unknown as ApprovalApplicationService,
    );

    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-history-001', sourceVersion: '1',
      entityType: 'approval.history', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: ['legacy-template-001', 'legacy-employee-001'],
      attachments: [{
        sourceAttachmentId: 'legacy-history-evidence-001', checksum: 'b'.repeat(43),
      }],
    }));
    expect(result).toMatchObject({
      status: 'rejected', rejectionCode: 'DATA_MIGRATION_HISTORY_EVIDENCE_REQUIRED',
    });
    expect(approvals.importLegacyHistoryFromMigration).not.toHaveBeenCalled();
  });

  it('活动审批解析表单、节点与动作员工引用后调用审批状态机入口', async () => {
    const context = new TenantContextService();
    const payload = {
      templateSourceId: 'legacy-template-001', templateCode: 'LEGACY_EXPENSE',
      templateRevision: 1, title: '迁移中的费用审批',
      initiatorEmployeeSourceId: 'legacy-initiator',
      formData: { amount: 12_345, employee_ref: 'legacy-form-employee' },
      formReferenceFields: [{ fieldKey: 'employee_ref', entityType: 'org.employee' }],
      resolvedNodes: [{
        nodeId: 'manager',
        actorEmployeeSourceIds: ['legacy-manager-1', 'legacy-manager-2'],
      }],
      actions: [{
        type: 'submitted', actorEmployeeSourceId: 'legacy-initiator',
        occurredAt: '2026-07-21T00:10:00.000Z',
      }, {
        type: 'decided', actorEmployeeSourceId: 'legacy-manager-1',
        principalApproverEmployeeSourceId: 'legacy-manager-1', outcome: 'approved',
        occurredAt: '2026-07-21T00:20:00.000Z',
      }],
      expectedStatus: 'running', expectedVersion: 3, expectedCurrentNodeId: 'manager',
      expectedPendingApproverEmployeeSourceIds: ['legacy-manager-2'],
      createdAt: '2026-07-21T00:05:00.000Z',
      submittedAt: '2026-07-21T00:10:00.000Z',
      updatedAt: '2026-07-21T00:20:00.000Z',
      activityEvidenceSourceAttachmentId: 'legacy-active-evidence-001',
      activityEvidenceChecksum: 'c'.repeat(43),
    };
    const input = {
      sequence: 1, sourceRecordId: 'legacy-active-001', sourceVersion: '1',
      entityType: 'approval.instance' as const, payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [
        'legacy-template-001', 'legacy-initiator', 'legacy-form-employee',
        'legacy-manager-1', 'legacy-manager-2',
      ],
      attachments: [{
        sourceAttachmentId: 'legacy-active-evidence-001', checksum: 'c'.repeat(43),
      }],
    };
    const targets: Readonly<Record<string, string>> = {
      'legacy-template-001': 'template-001',
      'legacy-initiator': 'employee-initiator',
      'legacy-form-employee': 'employee-form',
      'legacy-manager-1': 'employee-manager-1',
      'legacy-manager-2': 'employee-manager-2',
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(approvalActiveRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string; sourceRecordId: string }) => query(
        filter.entityType === 'approval.instance'
          ? null
          : { targetId: targets[filter.sourceRecordId], targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'instance-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 0 }) }),
    };
    const approvals = {
      importActiveInstanceFromMigration: vi.fn().mockResolvedValue({ instance: {
        id: 'instance-001', tenantId: 'tenant-001', version: 3,
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

    expect(result).toMatchObject({ status: 'applied', targetId: 'instance-001', targetVersion: 3 });
    expect(approvals.importActiveInstanceFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({
        templateId: 'template-001', initiatorEmployeeId: 'employee-initiator',
        formData: { amount: 12_345, employee_ref: 'employee-form' },
        resolvedNodes: [{
          nodeId: 'manager', actorEmployeeIds: ['employee-manager-1', 'employee-manager-2'],
        }],
        actions: [
          expect.objectContaining({ actorEmployeeId: 'employee-initiator' }),
          expect.objectContaining({ principalApproverEmployeeId: 'employee-manager-1' }),
        ],
        migrationEvidenceRef:
          `erp://data-migrations/runs/${RUN_ID}/attachments/legacy-active-evidence-001`,
      }),
    );
    expect(associations.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: 'form_employee' }),
      expect.objectContaining({ $set: { targetId: 'employee-form', status: 'resolved' } }),
      expect.objectContaining({ upsert: true }),
    );
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

  it('招聘 HC 解析组织、员工与终结审批映射后调用领域迁移入口', async () => {
    const context = new TenantContextService();
    const payload = {
      departmentSourceId: 'legacy-department-001',
      positionTitle: '小红书经纪人',
      headcount: 2,
      justification: '历史 HC 需求证据已进入迁移账本',
      status: 'approved',
      approvalReferenceType: 'approval.history',
      approvalReferenceSourceId: 'legacy-approval-history-001',
      version: 3,
      createdByEmployeeSourceId: 'legacy-employee-001',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      governanceEvidenceSourceAttachmentId: 'legacy-hc-evidence-001',
      governanceEvidenceChecksum: 'h'.repeat(43),
    };
    const input = {
      sequence: 1, sourceRecordId: 'legacy-requisition-001', sourceVersion: '1',
      entityType: 'recruitment.requisition' as const, payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [
        'legacy-department-001', 'legacy-employee-001', 'legacy-approval-history-001',
      ],
      attachments: [{ sourceAttachmentId: 'legacy-hc-evidence-001', checksum: 'h'.repeat(43) }],
    };
    const targets: Readonly<Record<string, string>> = {
      'legacy-department-001': 'department-001',
      'legacy-employee-001': 'employee-001',
      'legacy-approval-history-001': 'approval-history-001',
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(recruitmentReferenceRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string; sourceRecordId: string }) => query(
        filter.entityType === 'recruitment.requisition'
          ? null
          : { targetId: targets[filter.sourceRecordId], targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'requisition-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const recruitment = {
      importRequisitionFromMigration: vi.fn().mockResolvedValue({ requisition: {
        id: 'requisition-001', departmentId: 'department-001', positionTitle: '小红书经纪人',
        headcount: 2, status: 'approved', approvalInstanceId: null,
        approvalHistoryId: 'approval-history-001', version: 3,
      } }),
    };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
      undefined,
      recruitment as unknown as RecruitmentManagementService,
    );

    const result = await trusted(context, () => service.apply(RUN_ID, input));

    expect(result).toMatchObject({ status: 'applied', targetId: 'requisition-001' });
    expect(recruitment.importRequisitionFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({
        targetId: null, departmentId: 'department-001', createdByEmployeeId: 'employee-001',
        approvalReferenceType: 'legacy_history', approvalReferenceId: 'approval-history-001',
      }),
    );
    expect(associations.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: 'approval_history' }),
      expect.objectContaining({ $set: { targetId: 'approval-history-001', status: 'resolved' } }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('招聘职位解析 HC、部门和职级映射且缺少治理证据时失败关闭', async () => {
    const context = new TenantContextService();
    const payload = {
      requisitionSourceId: 'legacy-requisition-001',
      departmentSourceId: 'legacy-department-001',
      jobLevelSourceId: 'legacy-job-level-001',
      title: '小红书经纪人', location: '上海', headcount: 2,
      status: 'open', version: 2,
      publishedAt: '2026-07-21T00:00:00.000Z', closedAt: null,
      createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
      governanceEvidenceSourceAttachmentId: 'legacy-position-evidence-001',
      governanceEvidenceChecksum: 'p'.repeat(43),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(recruitmentReferenceRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const recruitment = { importPositionFromMigration: vi.fn() };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      { findOne: vi.fn().mockReturnValue(query(null)) } as unknown as
        Model<DataMigrationMappingDocument>,
      { findOneAndUpdate: vi.fn().mockReturnValue(query({})) } as unknown as
        Model<DataMigrationAssociationDocument>,
      {
        findOne: vi.fn().mockReturnValue(query(null)),
        updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
      } as unknown as Model<DataMigrationAttachmentDocument>,
      undefined,
      recruitment as unknown as RecruitmentManagementService,
    );

    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-position-001', sourceVersion: '1',
      entityType: 'recruitment.position', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [
        'legacy-requisition-001', 'legacy-department-001', 'legacy-job-level-001',
      ],
      attachments: [{
        sourceAttachmentId: 'legacy-position-evidence-001', checksum: 'x'.repeat(43),
      }],
    }));
    expect(result).toMatchObject({
      status: 'rejected',
      rejectionCode: 'DATA_MIGRATION_RECRUITMENT_GOVERNANCE_EVIDENCE_REQUIRED',
    });
    expect(recruitment.importPositionFromMigration).not.toHaveBeenCalled();
  });

  it('候选人明文只传给加密领域入口，账本仅保存摘要和无 PII 目标投影', async () => {
    const context = new TenantContextService();
    const payload = {
      status: 'active', name: '张三', phone: '+8613800138000', email: 'candidate@example.com',
      consentVersion: 'privacy-v1', consentPurpose: '招聘评估与候选人联络',
      consentCapturedAt: '2026-07-20T00:00:00.000Z',
      consentExpiresAt: '2027-07-20T00:00:00.000Z', consentWithdrawnAt: null,
      retentionExpiresAt: '2028-07-20T00:00:00.000Z', version: 1,
      createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z',
      candidateEvidenceSourceAttachmentId: 'candidate-evidence-001',
      candidateEvidenceChecksum: 'c'.repeat(43),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(recruitmentCandidatesRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = {
      findOne: vi.fn().mockReturnValue(query(null)),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'candidate-001' })),
    };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const recruitmentCandidates = {
      importCandidateFromMigration: vi.fn().mockResolvedValue({ candidate: {
        id: 'candidate-001', status: 'active', consentEvidenceId: 'consent-001',
        consentVersion: 'privacy-v1', version: 1,
      } }),
    };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      { findOneAndUpdate: vi.fn().mockReturnValue(query({})) } as unknown as
        Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
      undefined,
      undefined,
      recruitmentCandidates as unknown as RecruitmentApplicationService,
    );

    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-candidate-001', sourceVersion: '1',
      entityType: 'recruitment.candidate', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [],
      attachments: [{ sourceAttachmentId: 'candidate-evidence-001', checksum: 'c'.repeat(43) }],
    }));

    expect(result).toMatchObject({ status: 'applied', targetId: 'candidate-001' });
    expect(recruitmentCandidates.importCandidateFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({
        name: '张三', phone: '+8613800138000', email: 'candidate@example.com',
        migrationEvidenceRef:
          `erp://data-migrations/runs/${RUN_ID}/attachments/candidate-evidence-001`,
      }),
    );
    const item = items.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(item)).not.toMatch(/张三|13800138000|candidate@example/iu);
  });

  it('申请基线解析候选人与职位映射后调用内存状态机迁移入口', async () => {
    const context = new TenantContextService();
    const payload = {
      candidateSourceId: 'legacy-candidate-001', positionSourceId: 'legacy-position-001',
      sourceChannel: 'legacy_ats',
      actions: [
        { targetStage: 'screening', reasonCode: null, occurredAt: '2026-07-20T01:00:00.000Z' },
        { targetStage: 'interview', reasonCode: null, occurredAt: '2026-07-20T02:00:00.000Z' },
      ],
      expectedStage: 'interview', expectedVersion: 3,
      appliedAt: '2026-07-20T00:00:00.000Z', endedAt: null,
      updatedAt: '2026-07-20T02:00:00.000Z',
      applicationEvidenceSourceAttachmentId: 'application-evidence-001',
      applicationEvidenceChecksum: 'd'.repeat(43),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(recruitmentApplicationsRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const targets: Readonly<Record<string, string>> = {
      'legacy-candidate-001': 'candidate-001', 'legacy-position-001': 'position-001',
    };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string; sourceRecordId: string }) => query(
        filter.entityType === 'recruitment.application'
          ? null
          : { targetId: targets[filter.sourceRecordId], targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'application-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const recruitmentApplications = {
      importApplicationBaselineFromMigration: vi.fn().mockResolvedValue({ application: {
        id: 'application-001', candidateId: 'candidate-001', positionId: 'position-001',
        stage: 'interview', version: 3,
        appliedAt: '2026-07-20T00:00:00.000Z', endedAt: null,
      } }),
    };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
      undefined,
      undefined,
      recruitmentApplications as unknown as RecruitmentApplicationService,
    );

    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-application-001', sourceVersion: '1',
      entityType: 'recruitment.application', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: ['legacy-candidate-001', 'legacy-position-001'],
      attachments: [{ sourceAttachmentId: 'application-evidence-001', checksum: 'd'.repeat(43) }],
    }));

    expect(result).toMatchObject({ status: 'applied', targetId: 'application-001' });
    expect(recruitmentApplications.importApplicationBaselineFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({ candidateId: 'candidate-001', positionId: 'position-001' }),
    );
    expect(associations.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: 'candidate' }),
      expect.objectContaining({ $set: { targetId: 'candidate-001', status: 'resolved' } }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('面试迁移解析申请和员工映射，L3 原文只进入加密领域入口', async () => {
    const context = new TenantContextService();
    const payload = {
      applicationSourceId: 'legacy-application-001', roundNumber: 1, mode: 'video',
      startsAt: '2026-07-20T02:00:00.000Z', endsAt: '2026-07-20T03:00:00.000Z',
      timezone: 'Asia/Shanghai',
      interviewerEmployeeSourceIds: ['legacy-employee-001', 'legacy-employee-002'],
      location: 'https://meeting.example/legacy-secret',
      createdByEmployeeSourceId: 'legacy-employee-hr',
      feedback: [
        {
          interviewerEmployeeSourceId: 'legacy-employee-001', recommendation: 'hire', score: 4,
          notes: '技术能力符合要求', submittedAt: '2026-07-20T03:01:00.000Z',
        },
        {
          interviewerEmployeeSourceId: 'legacy-employee-002', recommendation: 'strong_hire',
          score: 5, notes: '综合能力优秀', submittedAt: '2026-07-20T03:02:00.000Z',
        },
      ],
      expectedStatus: 'completed', expectedVersion: 4,
      completedAt: '2026-07-20T03:03:00.000Z', cancelledAt: null,
      createdAt: '2026-07-19T02:00:00.000Z', updatedAt: '2026-07-20T03:03:00.000Z',
      interviewEvidenceSourceAttachmentId: 'interview-evidence-001',
      interviewEvidenceChecksum: 'f'.repeat(43),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(recruitmentInterviewsRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const targets: Readonly<Record<string, string>> = {
      'legacy-application-001': 'application-001',
      'legacy-employee-001': 'employee-001',
      'legacy-employee-002': 'employee-002',
      'legacy-employee-hr': 'employee-hr',
    };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string; sourceRecordId: string }) => query(
        filter.entityType === 'recruitment.interview'
          ? null
          : { targetId: targets[filter.sourceRecordId], targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'interview-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const recruitmentInterviews = {
      importInterviewFromMigration: vi.fn().mockResolvedValue({ interview: {
        id: 'interview-001', applicationId: 'application-001', roundNumber: 1,
        mode: 'video', startsAt: payload.startsAt, endsAt: payload.endsAt,
        timezone: payload.timezone, interviewerIds: ['employee-001', 'employee-002'],
        status: 'completed', version: 4, completedAt: payload.completedAt, cancelledAt: null,
      } }),
    };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
      undefined,
      undefined,
      undefined,
      recruitmentInterviews as unknown as RecruitmentInterviewService,
    );

    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-interview-001', sourceVersion: '1',
      entityType: 'recruitment.interview', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [
        'legacy-application-001', 'legacy-employee-hr',
        'legacy-employee-001', 'legacy-employee-002',
      ],
      attachments: [{ sourceAttachmentId: 'interview-evidence-001', checksum: 'f'.repeat(43) }],
    }));

    expect(result).toMatchObject({ status: 'applied', targetId: 'interview-001' });
    expect(recruitmentInterviews.importInterviewFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({
        applicationId: 'application-001',
        interviewerIds: ['employee-001', 'employee-002'],
        createdByEmployeeId: 'employee-hr',
        location: 'https://meeting.example/legacy-secret',
        migrationEvidenceRef:
          `erp://data-migrations/runs/${RUN_ID}/attachments/interview-evidence-001`,
      }),
    );
    const item = items.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(item)).not.toMatch(/legacy-secret|技术能力符合要求/u);
    expect(associations.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: 'application' }),
      expect.objectContaining({ $set: { targetId: 'application-001', status: 'resolved' } }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('Offer 迁移解析申请、面试、员工和审批历史且账本不保存 L4 条款', async () => {
    const context = new TenantContextService();
    const payload = {
      applicationSourceId: 'legacy-application-001',
      completedInterviewSourceId: 'legacy-interview-001',
      createdByEmployeeSourceId: 'legacy-employee-hr',
      terms: {
        currency: 'CNY', monthlyBaseSalaryMinor: 3_000_000, salaryMonths: 13,
        annualVariableTargetMinor: 6_000_000, signingBonusMinor: 1_000_000,
        proposedStartDate: '2026-08-15', probationMonths: 3,
        employmentType: 'full_time', workLocation: '上海', benefitsSummary: '标准福利计划',
      },
      expiresAt: '2027-08-01T00:00:00.000Z',
      retentionExpiresAt: '2033-08-01T00:00:00.000Z', status: 'accepted',
      approvalReferenceType: 'approval.history',
      approvalReferenceSourceId: 'legacy-approval-history-001', sendRequested: true,
      sentProof: { proofHash: 'a'.repeat(43), occurredAt: '2026-07-21T03:00:00.000Z' },
      decisionProof: {
        decision: 'accepted', proofHash: 'b'.repeat(43),
        occurredAt: '2026-07-21T04:00:00.000Z',
      },
      signedProof: null, version: 6,
      createdAt: '2026-07-21T01:00:00.000Z', updatedAt: '2026-07-21T04:00:00.000Z',
      applicationBaselineVersion: 3,
      applicationBaselineUpdatedAt: '2026-07-21T00:00:00.000Z',
      applicationActions: [
        { targetStage: 'offer_approval', reasonCode: null, occurredAt: '2026-07-21T02:00:00.000Z' },
        { targetStage: 'offer_sent', reasonCode: null, occurredAt: '2026-07-21T03:00:00.000Z' },
        { targetStage: 'offer_accepted', reasonCode: null, occurredAt: '2026-07-21T04:00:00.000Z' },
      ],
      expectedApplicationStage: 'offer_accepted', expectedApplicationVersion: 6,
      applicationEndedAt: null, applicationUpdatedAt: '2026-07-21T04:00:00.000Z',
      offerEvidenceSourceAttachmentId: 'offer-evidence-001',
      offerEvidenceChecksum: 'c'.repeat(43),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(recruitmentOffersRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const targets: Readonly<Record<string, string>> = {
      'legacy-application-001': 'application-001',
      'legacy-interview-001': 'interview-001',
      'legacy-employee-hr': 'employee-hr',
      'legacy-approval-history-001': 'approval-history-001',
    };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string; sourceRecordId: string }) => query(
        filter.entityType === 'recruitment.offer'
          ? null
          : { targetId: targets[filter.sourceRecordId], targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'offer-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const recruitmentOffers = {
      importOfferFromMigration: vi.fn().mockResolvedValue({ offer: {
        id: 'offer-001', applicationId: 'application-001', positionId: 'position-001',
        completedInterviewId: 'interview-001', status: 'accepted',
        expiresAt: payload.expiresAt, approvalInstanceId: null,
        approvalHistoryId: 'approval-history-001', sendRequestId: 'send-001',
        sentEvidenceId: 'sent-001', acceptanceEvidenceId: 'decision-001',
        esignFlowId: null, signedEvidenceId: null, version: 6,
      } }),
    };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
      undefined, undefined, undefined, undefined,
      recruitmentOffers as unknown as RecruitmentOfferService,
    );
    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-offer-001', sourceVersion: '1',
      entityType: 'recruitment.offer', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [
        'legacy-application-001', 'legacy-interview-001', 'legacy-employee-hr',
        'legacy-approval-history-001',
      ],
      attachments: [{ sourceAttachmentId: 'offer-evidence-001', checksum: 'c'.repeat(43) }],
    }));
    expect(result).toMatchObject({ status: 'applied', targetId: 'offer-001' });
    expect(recruitmentOffers.importOfferFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({
        applicationId: 'application-001', completedInterviewId: 'interview-001',
        createdByEmployeeId: 'employee-hr', approvalReferenceId: 'approval-history-001',
        migrationEvidenceRef:
          `erp://data-migrations/runs/${RUN_ID}/attachments/offer-evidence-001`,
      }),
    );
    const item = items.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(item)).not.toMatch(/标准福利计划|monthlyBaseSalaryMinor/u);
  });

  it('考勤源事实迁移解析员工并且账本不保存 L4 分钟或外部事件标识', async () => {
    const context = new TenantContextService();
    const payload = {
      employeeSourceId: 'legacy-employee-001', providerCode: 'legacy_hr',
      externalEventId: 'legacy-attendance-event-001', factType: 'shift',
      occurredAt: '2026-04-01T01:00:00.000Z', timeZone: 'Asia/Shanghai',
      impact: { workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0 },
      sourceObservedAt: '2026-04-01T01:01:00.000Z',
      createdAt: '2026-04-01T01:02:00.000Z',
      sourceEvidenceSourceAttachmentId: 'attendance-source-001',
      sourceEvidenceChecksum: 'd'.repeat(43),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(attendanceSourceFactsRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string }) => query(
        filter.entityType === 'attendance.source_fact'
          ? null
          : { targetId: 'employee-001', targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'attendance-fact-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const attendance = { importSourceFactFromMigration: vi.fn().mockResolvedValue({ fact: {
      id: 'attendance-fact-001', employeeId: 'employee-001', providerCode: 'legacy_hr',
      factType: 'shift', businessDate: '2026-04-01', version: 1,
    } }) };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
      undefined, undefined, undefined, undefined, undefined,
      attendance as unknown as AttendanceApplicationService,
    );
    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-attendance-001', sourceVersion: '1',
      entityType: 'attendance.source_fact', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: ['legacy-employee-001'],
      attachments: [{ sourceAttachmentId: 'attendance-source-001', checksum: 'd'.repeat(43) }],
    }));
    expect(result).toMatchObject({ status: 'applied', targetId: 'attendance-fact-001' });
    expect(attendance.importSourceFactFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({
        employeeId: 'employee-001', externalEventId: 'legacy-attendance-event-001',
        migrationEvidenceRef:
          `erp://data-migrations/runs/${RUN_ID}/attachments/attendance-source-001`,
      }),
    );
    const item = items.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(item)).not.toMatch(/workedMinutes|480|legacy-attendance-event-001/u);
  });

  it('考勤修订迁移解析员工、源事实与批准历史且账本不保存 L4 影响', async () => {
    const context = new TenantContextService();
    const payload = {
      employeeSourceId: 'legacy-employee-001',
      sourceFactSourceId: 'legacy-attendance-001',
      approvalHistorySourceId: 'legacy-approval-001',
      approvalEvidenceChecksum: 'a'.repeat(43),
      replacementImpact: {
        workedMinutes: 420, leaveMinutes: 60, overtimeMinutes: 0, absentMinutes: 0,
      },
      reasonCode: 'LEGACY_APPROVED', createdAt: '2026-04-01T02:01:00.000Z',
      sourceEvidenceSourceAttachmentId: 'attendance-correction-001',
      sourceEvidenceChecksum: 'd'.repeat(43),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(attendanceCorrectionsRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const targetByEntity: Readonly<Record<string, string>> = {
      'org.employee': 'employee-001',
      'attendance.source_fact': 'attendance-fact-001',
      'approval.history': 'approval-history-001',
    };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string }) => query(
        filter.entityType === 'attendance.correction'
          ? null
          : { targetId: targetByEntity[filter.entityType], targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'correction-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const attendance = { importCorrectionFromMigration: vi.fn().mockResolvedValue({ correction: {
      id: 'correction-001', employeeId: 'employee-001',
      sourceFactId: 'attendance-fact-001', businessDate: '2026-04-01',
      approvalReferenceType: 'legacy_history', approvalReferenceId: 'approval-history-001',
      version: 1,
    } }) };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
      undefined, undefined, undefined, undefined, undefined,
      attendance as unknown as AttendanceApplicationService,
    );
    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-correction-001', sourceVersion: '1',
      entityType: 'attendance.correction', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: [
        'legacy-approval-001', 'legacy-attendance-001', 'legacy-employee-001',
      ],
      attachments: [{
        sourceAttachmentId: 'attendance-correction-001', checksum: 'd'.repeat(43),
      }],
    }));
    expect(result).toMatchObject({ status: 'applied', targetId: 'correction-001' });
    expect(attendance.importCorrectionFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({
        employeeId: 'employee-001', sourceFactId: 'attendance-fact-001',
        approvalHistoryId: 'approval-history-001',
      }),
    );
    const item = items.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(item)).not.toMatch(/workedMinutes|420|LEGACY_APPROVED/u);
  });

  it('考勤月结迁移解析员工并且账本不保存来源汇总', async () => {
    const context = new TenantContextService();
    const payload = {
      employeeSourceId: 'legacy-employee-001', month: '2026-04', snapshotVersion: 1,
      rulesetVersion: 'legacy-cn-v1', sourceCutoffAt: '2026-04-02T00:00:00.000Z',
      closedAt: '2026-04-02T00:01:00.000Z', previousSnapshotSourceId: null,
      supersessionApprovalHistorySourceId: null,
      supersessionApprovalEvidenceChecksum: null,
      expectedImpact: {
        workedMinutes: 480, leaveMinutes: 0, overtimeMinutes: 0, absentMinutes: 0,
      },
      expectedSourceFactCount: 1, expectedCorrectionCount: 0,
      sourceEvidenceSourceAttachmentId: 'attendance-month-001',
      sourceEvidenceChecksum: 'm'.repeat(43),
    };
    const runs = {
      findOne: vi.fn().mockReturnValue(query(attendanceMonthlySnapshotsRun())),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const items = { findOne: vi.fn().mockReturnValue(query(null)), create: vi.fn() };
    const mappings = {
      findOne: vi.fn((filter: { entityType: string }) => query(
        filter.entityType === 'attendance.monthly_snapshot'
          ? null : { targetId: 'employee-001', targetVersion: 1 },
      )),
      findOneAndUpdate: vi.fn().mockReturnValue(query({ targetId: 'snapshot-001' })),
    };
    const associations = { findOneAndUpdate: vi.fn().mockReturnValue(query({})) };
    const attachments = {
      findOne: vi.fn().mockReturnValue(query(null)),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const attendance = { importMonthFromMigration: vi.fn().mockResolvedValue({ month: {
      id: 'snapshot-001', employeeId: 'employee-001', month: '2026-04',
      snapshotVersion: 1, snapshotHash: 's'.repeat(43), version: 1,
    } }) };
    const service = new DataMigrationService(
      context, {} as OrgApplicationService,
      runs as unknown as Model<DataMigrationRunDocument>,
      items as unknown as Model<DataMigrationItemDocument>,
      mappings as unknown as Model<DataMigrationMappingDocument>,
      associations as unknown as Model<DataMigrationAssociationDocument>,
      attachments as unknown as Model<DataMigrationAttachmentDocument>,
      undefined, undefined, undefined, undefined, undefined,
      attendance as unknown as AttendanceApplicationService,
    );
    const result = await trusted(context, () => service.apply(RUN_ID, {
      sequence: 1, sourceRecordId: 'legacy-month-001', sourceVersion: '1',
      entityType: 'attendance.monthly_snapshot', payload,
      payloadHash: dataMigrationChecksum.digest(dataMigrationChecksum.canonicalJson(payload)),
      associationSourceIds: ['legacy-employee-001'],
      attachments: [{ sourceAttachmentId: 'attendance-month-001', checksum: 'm'.repeat(43) }],
    }));
    expect(result).toMatchObject({ status: 'applied', targetId: 'snapshot-001' });
    expect(attendance.importMonthFromMigration).toHaveBeenCalledWith(
      expect.stringMatching(/^migration:/u),
      expect.objectContaining({ employeeId: 'employee-001', snapshotVersion: 1 }),
    );
    const item = items.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(item)).not.toMatch(/workedMinutes|480|legacy-cn-v1/u);
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
