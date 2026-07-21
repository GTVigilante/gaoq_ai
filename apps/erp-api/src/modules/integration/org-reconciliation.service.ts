import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { AuditService } from '../../core/audit/audit.service.js';
import {
  OrgDepartmentRecord,
  type OrgDepartmentDocument,
  OrgEmployeeRecord,
  type OrgEmployeeDocument,
} from '../org/persistence/org.schemas.js';
import type { OrgDeliveryAggregateType, OrgDeliveryChannel } from './org-delivery.schemas.js';
import {
  OrgExternalVersionState,
  type OrgExternalVersionStateDocument,
} from './org-delivery.schemas.js';
import {
  OrgPlatformBinding,
  type OrgPlatformBindingDocument,
} from './org-platform-binding.schema.js';
import {
  OrgReconciliationReport,
  type OrgReconciliationDifference,
  type OrgReconciliationReportDocument,
} from './org-reconciliation.schema.js';
import { OrgPushAdapterRegistry, OrgPushError } from './org-push.adapter.js';

const MAX_REPORTED_DIFFERENCES = 1_000;
const MAX_EXPECTED_OBJECTS = 20_000;
const RECONCILIATION_LEASE_MS = 2 * 60 * 60 * 1_000;
const ERROR_CODE_PATTERN = /^[A-Z0-9_:-]{1,128}$/;

/** 对账报告已完成但后置审计不可用；禁止将完成报告回写为失败。 */
class ReconciliationPostCommitAuditError extends Error {}

interface MappingView {
  readonly aggregateType: OrgDeliveryAggregateType;
  readonly aggregateId: string;
  readonly externalId: string;
}

/** 按 UTC 日对 ERP 主数据与双平台通讯录做只读对账，不自动覆盖任一侧。 */
@Injectable()
export class OrgReconciliationService {
  constructor(
    @InjectModel(OrgPlatformBinding.name)
    private readonly bindings: Model<OrgPlatformBindingDocument>,
    @InjectModel(OrgReconciliationReport.name)
    private readonly reports: Model<OrgReconciliationReportDocument>,
    @InjectModel(OrgDepartmentRecord.name)
    private readonly departments: Model<OrgDepartmentDocument>,
    @InjectModel(OrgEmployeeRecord.name)
    private readonly employees: Model<OrgEmployeeDocument>,
    @InjectModel(OrgExternalVersionState.name)
    private readonly versions: Model<OrgExternalVersionStateDocument>,
    private readonly adapters: OrgPushAdapterRegistry,
    private readonly audit: AuditService,
  ) {}

  async runDaily(now = new Date()): Promise<number> {
    const runDate = now.toISOString().slice(0, 10);
    const bindings = await this.bindings.find(
      { status: 'active' },
      { tenantId: 1, channel: 1, _id: 0 },
    ).sort({ tenantId: 1, channel: 1 }).limit(5_000).lean().exec();
    let completed = 0;
    let failed = 0;
    for (const binding of bindings) {
      try {
        if (await this.runOne(binding.tenantId, binding.channel, runDate)) completed += 1;
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      throw new OrgPushError(
        'ORG_RECONCILIATION_PARTIAL_FAILURE',
        'retryable',
        '部分租户组织对账失败',
      );
    }
    return completed;
  }

  private async runOne(
    tenantId: string,
    channel: OrgDeliveryChannel,
    runDate: string,
  ): Promise<boolean> {
    const startedAt = new Date();
    const staleBefore = new Date(startedAt.getTime() - RECONCILIATION_LEASE_MS);
    const claim = await this.reports.findOneAndUpdate(
      {
        tenantId,
        channel,
        runDate,
        $or: [
          { status: 'failed' },
          { status: 'running', startedAt: { $lt: staleBefore } },
          { status: { $exists: false } },
        ],
      },
      {
        $setOnInsert: { tenantId, channel, runDate },
        $set: {
          status: 'running', startedAt, completedAt: null, lastErrorCode: null,
          expectedCount: 0, externalCount: 0, differenceCount: 0,
          differences: [], truncated: false,
        },
      },
      { upsert: true, returnDocument: 'after' },
    ).lean().exec().catch((error: unknown) => {
      if (this.isDuplicateKeyError(error)) return null;
      throw error;
    });
    if (claim === null) return false;
    try {
      const [snapshot, departments, employees, mappings] = await Promise.all([
        this.adapters.get(channel).fetchSnapshot(tenantId),
        this.departments.find(
          { tenantId },
          { id: 1, name: 1, status: 1, parentId: 1, _id: 0 },
        ).limit(MAX_EXPECTED_OBJECTS + 1).lean().exec(),
        this.employees.find(
          { tenantId },
          { id: 1, displayName: 1, employeeNo: 1, status: 1, departmentIds: 1, _id: 0 },
        ).limit(MAX_EXPECTED_OBJECTS + 1).lean().exec(),
        this.versions.find(
          { tenantId, channel, appliedVersion: { $gte: 1 }, externalId: { $ne: null } },
          { aggregateType: 1, aggregateId: 1, externalId: 1, _id: 0 },
        ).limit(MAX_EXPECTED_OBJECTS + 1).lean().exec(),
      ]);
      if (
        departments.length + employees.length > MAX_EXPECTED_OBJECTS ||
        mappings.length > MAX_EXPECTED_OBJECTS
      ) {
        throw new OrgPushError(
          'ORG_RECONCILIATION_EXPECTED_TOO_LARGE',
          'business',
          'ERP 组织规模超过单次对账安全上限',
        );
      }
      const differences = this.compare(
        departments,
        employees,
        mappings.filter((item): item is typeof item & { externalId: string } => item.externalId !== null),
        snapshot,
      );
      const completedAt = new Date();
      await this.reports.updateOne(
        { tenantId, channel, runDate, status: 'running' },
        { $set: {
          status: 'completed',
          expectedCount: departments.length + employees.length,
          externalCount: snapshot.departments.size + snapshot.employees.size,
          differenceCount: differences.length,
          differences: differences.slice(0, MAX_REPORTED_DIFFERENCES),
          truncated: differences.length > MAX_REPORTED_DIFFERENCES,
          completedAt,
          lastErrorCode: null,
        } },
        { timestamps: false },
      );
      try {
        await this.audit.recordSystem(tenantId, {
          action: 'integration.org.reconciliation',
          resourceType: 'org_reconciliation_report',
          resourceId: `${channel}:${runDate}`,
          riskLevel: 'R1',
          outcome: 'success',
          traceId: `reconcile-${randomUUID()}`,
          metadata: { channel, differenceCount: differences.length },
        });
      } catch {
        throw new ReconciliationPostCommitAuditError('对账已完成但审计不可用');
      }
      return true;
    } catch (error) {
      if (error instanceof ReconciliationPostCommitAuditError) throw error;
      const code = error instanceof OrgPushError && ERROR_CODE_PATTERN.test(error.code)
        ? error.code
        : 'ORG_RECONCILIATION_FAILED';
      await this.reports.updateOne(
        { tenantId, channel, runDate, status: 'running' },
        { $set: { status: 'failed', completedAt: new Date(), lastErrorCode: code } },
        { timestamps: false },
      );
      await this.audit.recordSystem(tenantId, {
        action: 'integration.org.reconciliation',
        resourceType: 'org_reconciliation_report',
        resourceId: `${channel}:${runDate}`,
        riskLevel: 'R1',
        outcome: 'failure',
        traceId: `reconcile-${randomUUID()}`,
        metadata: { channel, errorCode: code },
      });
      throw error;
    }
  }

  private compare(
    departments: readonly OrgDepartmentRecord[],
    employees: readonly OrgEmployeeRecord[],
    mappings: readonly MappingView[],
    snapshot: {
      readonly departments: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
      readonly employees: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
    },
  ): OrgReconciliationDifference[] {
    const differences: OrgReconciliationDifference[] = [];
    const mappingByAggregate = new Map(
      mappings.map((item) => [`${item.aggregateType}:${item.aggregateId}`, item.externalId]),
    );
    const knownDepartmentExternalIds = new Set<string>();
    const knownEmployeeExternalIds = new Set<string>();
    for (const department of departments) {
      const externalId = mappingByAggregate.get(`org.department:${department.id}`);
      if (externalId === undefined) {
        if (department.status === 'active') differences.push(this.difference('mapping_missing', 'org.department', department.id));
        continue;
      }
      knownDepartmentExternalIds.add(externalId);
      const external = snapshot.departments.get(externalId);
      if (external === undefined) {
        if (department.status === 'active') differences.push(this.difference('external_missing', 'org.department', department.id, externalId));
        continue;
      }
      const fields: string[] = [];
      if (external['name'] !== department.name) fields.push('name');
      if (department.status === 'inactive') fields.push('status');
      const expectedParent = department.parentId === null
        ? null
        : mappingByAggregate.get(`org.department:${department.parentId}`) ?? null;
      const actualParent = external['parentExternalId'];
      if (expectedParent !== null && actualParent !== expectedParent) fields.push('parentId');
      if (fields.length > 0) differences.push(this.difference('field_mismatch', 'org.department', department.id, externalId, fields));
    }
    for (const employee of employees) {
      const externalId = mappingByAggregate.get(`org.employee:${employee.id}`);
      if (externalId === undefined) {
        if (employee.status !== 'terminated') differences.push(this.difference('mapping_missing', 'org.employee', employee.id));
        continue;
      }
      knownEmployeeExternalIds.add(externalId);
      const external = snapshot.employees.get(externalId);
      if (external === undefined) {
        if (employee.status !== 'terminated') differences.push(this.difference('external_missing', 'org.employee', employee.id, externalId));
        continue;
      }
      const fields: string[] = [];
      if (external['displayName'] !== employee.displayName) fields.push('displayName');
      if (external['employeeNo'] !== employee.employeeNo) fields.push('employeeNo');
      const expectedDepartments = employee.departmentIds
        .map((id) => mappingByAggregate.get(`org.department:${id}`))
        .filter((id): id is string => id !== undefined)
        .sort();
      const actualDepartments = Array.isArray(external['departmentExternalIds'])
        ? external['departmentExternalIds'].filter((id): id is string => typeof id === 'string').sort()
        : [];
      if (expectedDepartments.join('\u0000') !== actualDepartments.join('\u0000')) fields.push('departmentIds');
      if (employee.status === 'terminated') fields.push('status');
      if (employee.status === 'suspended' && external['suspended'] !== true) fields.push('status');
      if (
        (employee.status === 'active' || employee.status === 'probation') &&
        (external['suspended'] === true || external['resigned'] === true)
      ) fields.push('status');
      if (fields.length > 0) differences.push(this.difference('field_mismatch', 'org.employee', employee.id, externalId, [...new Set(fields)]));
    }
    for (const externalId of snapshot.departments.keys()) {
      if (!knownDepartmentExternalIds.has(externalId) && externalId !== '0' && externalId !== '1') {
        differences.push(this.difference('external_orphan', 'org.department', externalId, externalId));
      }
    }
    for (const externalId of snapshot.employees.keys()) {
      if (!knownEmployeeExternalIds.has(externalId)) {
        differences.push(this.difference('external_orphan', 'org.employee', externalId, externalId));
      }
    }
    return differences;
  }

  private difference(
    kind: OrgReconciliationDifference['kind'],
    aggregateType: OrgDeliveryAggregateType,
    aggregateId: string,
    externalId?: string,
    fields?: readonly string[],
  ): OrgReconciliationDifference {
    return {
      kind,
      aggregateType,
      aggregateId,
      ...(externalId === undefined ? {} : { externalId }),
      ...(fields === undefined ? {} : { fields }),
    };
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
  }
}
