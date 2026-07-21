import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { Department } from '../domain/department.js';
import type { Employee } from '../domain/employee.js';
import type { JobLevel } from '../domain/job-level.js';
import type { Position } from '../domain/position.js';
import {
  OrgDepartmentRecord,
  type OrgDepartmentDocument,
  OrgEmployeeRecord,
  type OrgEmployeeDocument,
  OrgJobLevelRecord,
  type OrgJobLevelDocument,
  OrgPositionRecord,
  type OrgPositionDocument,
} from './org.schemas.js';

export class OrgWriteConflictError extends Error {
  constructor() {
    super('组织主数据版本冲突');
    this.name = 'OrgWriteConflictError';
  }
}

abstract class TenantBoundRepository {
  constructor(protected readonly context: TenantContextService) {}

  protected tenantId(): string {
    return this.context.getTenantRequired().tenantId;
  }

  protected assertEntityTenant(entityTenantId: string): void {
    if (entityTenantId !== this.tenantId()) {
      throw new Error('组织仓储拒绝跨租户实体');
    }
  }
}

@Injectable()
export class DepartmentRepository extends TenantBoundRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(OrgDepartmentRecord.name)
    private readonly records: Model<OrgDepartmentDocument>,
  ) {
    super(context);
  }

  async findById(id: string, session?: ClientSession): Promise<Department | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findChildren(parentId: string | null, session?: ClientSession): Promise<readonly Department[]> {
    const query = this.records
      .find({ tenantId: this.tenantId(), parentId })
      .sort({ sortOrder: 1, id: 1 });
    if (session !== undefined) query.session(session);
    return (await query.lean().exec()).map((record) => this.toDomain(record));
  }

  async findAll(session?: ClientSession): Promise<readonly Department[]> {
    const query = this.records.find({ tenantId: this.tenantId() }).sort({ sortOrder: 1, id: 1 });
    if (session !== undefined) query.session(session);
    return (await query.lean().exec()).map((record) => this.toDomain(record));
  }

  async findByIds(ids: readonly string[], session: ClientSession): Promise<readonly Department[]> {
    const records = await this.records
      .find({ tenantId: this.tenantId(), id: { $in: [...ids] } })
      .session(session)
      .lean()
      .exec();
    return records.map((record) => this.toDomain(record));
  }

  async insert(department: Department, session: ClientSession): Promise<void> {
    this.assertEntityTenant(department.tenantId);
    await this.records.create([this.toRecord(department)], { session });
  }

  async replace(
    department: Department,
    expectedVersion: number,
    session: ClientSession,
  ): Promise<void> {
    this.assertEntityTenant(department.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: department.id, version: expectedVersion },
      { $set: {
        code: department.code,
        name: department.name,
        status: department.status,
        parentId: department.parentId,
        managerId: department.managerId,
        sortOrder: department.sortOrder,
        version: department.version,
        updatedAt: new Date(department.updatedAt),
      } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new OrgWriteConflictError();
  }

  private toRecord(department: Department): Record<string, unknown> {
    return {
      id: department.id,
      tenantId: department.tenantId,
      code: department.code,
      name: department.name,
      status: department.status,
      parentId: department.parentId,
      managerId: department.managerId,
      sortOrder: department.sortOrder,
      version: department.version,
      createdAt: new Date(department.createdAt),
      updatedAt: new Date(department.updatedAt),
    };
  }

  private toDomain(record: OrgDepartmentRecord): Department {
    return Object.freeze({
      id: record.id,
      tenantId: record.tenantId,
      code: record.code,
      name: record.name,
      status: record.status,
      parentId: record.parentId,
      managerId: record.managerId,
      sortOrder: record.sortOrder,
      version: record.version,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}

@Injectable()
export class EmployeeRepository extends TenantBoundRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(OrgEmployeeRecord.name)
    private readonly records: Model<OrgEmployeeDocument>,
  ) {
    super(context);
  }

  async findById(id: string, session?: ClientSession): Promise<Employee | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : this.toDomain(record);
  }

  async findByDepartment(departmentId: string): Promise<readonly Employee[]> {
    const records = await this.records
      .find({ tenantId: this.tenantId(), departmentIds: departmentId })
      .sort({ employeeNo: 1 })
      .lean()
      .exec();
    return records.map((record) => this.toDomain(record));
  }

  async findAll(session?: ClientSession): Promise<readonly Employee[]> {
    const query = this.records.find({ tenantId: this.tenantId() }).sort({ employeeNo: 1 });
    if (session !== undefined) query.session(session);
    return (await query.lean().exec()).map((record) => this.toDomain(record));
  }

  async insert(employee: Employee, session: ClientSession): Promise<void> {
    this.assertEntityTenant(employee.tenantId);
    await this.records.create([this.toRecord(employee)], { session });
  }

  async replace(employee: Employee, expectedVersion: number, session: ClientSession): Promise<void> {
    this.assertEntityTenant(employee.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: employee.id, version: expectedVersion },
      { $set: {
        employeeNo: employee.employeeNo,
        displayName: employee.displayName,
        status: employee.status,
        departmentIds: [...employee.departmentIds],
        primaryDepartmentId: employee.primaryDepartmentId,
        positionIds: [...employee.positionIds],
        jobLevelId: employee.jobLevelId,
        version: employee.version,
        updatedAt: new Date(employee.updatedAt),
      } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new OrgWriteConflictError();
  }

  private toRecord(employee: Employee): Record<string, unknown> {
    return {
      id: employee.id,
      tenantId: employee.tenantId,
      employeeNo: employee.employeeNo,
      displayName: employee.displayName,
      status: employee.status,
      departmentIds: [...employee.departmentIds],
      primaryDepartmentId: employee.primaryDepartmentId,
      positionIds: [...employee.positionIds],
      jobLevelId: employee.jobLevelId,
      version: employee.version,
      createdAt: new Date(employee.createdAt),
      updatedAt: new Date(employee.updatedAt),
    };
  }

  private toDomain(record: OrgEmployeeRecord): Employee {
    return Object.freeze({
      id: record.id,
      tenantId: record.tenantId,
      employeeNo: record.employeeNo,
      displayName: record.displayName,
      status: record.status,
      departmentIds: Object.freeze([...record.departmentIds]),
      primaryDepartmentId: record.primaryDepartmentId,
      positionIds: Object.freeze([...record.positionIds]),
      jobLevelId: record.jobLevelId,
      version: record.version,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}

@Injectable()
export class PositionRepository extends TenantBoundRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(OrgPositionRecord.name) private readonly records: Model<OrgPositionDocument>,
  ) {
    super(context);
  }

  async findById(id: string, session?: ClientSession): Promise<Position | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : Object.freeze({
      id: record.id, tenantId: record.tenantId, code: record.code, name: record.name,
      status: record.status, version: record.version, createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }

  async insert(position: Position, session: ClientSession): Promise<void> {
    this.assertEntityTenant(position.tenantId);
    await this.records.create([this.toRecord(position)], { session });
  }

  async findByIds(ids: readonly string[], session: ClientSession): Promise<readonly Position[]> {
    const records = await this.records
      .find({ tenantId: this.tenantId(), id: { $in: [...ids] } })
      .session(session)
      .lean()
      .exec();
    return records.map((record) => Object.freeze({
      id: record.id, tenantId: record.tenantId, code: record.code, name: record.name,
      status: record.status, version: record.version, createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    }));
  }

  async replace(position: Position, expectedVersion: number, session: ClientSession): Promise<void> {
    this.assertEntityTenant(position.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: position.id, version: expectedVersion },
      { $set: {
        code: position.code,
        name: position.name,
        status: position.status,
        version: position.version,
        updatedAt: new Date(position.updatedAt),
      } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new OrgWriteConflictError();
  }

  private toRecord(position: Position): Record<string, unknown> {
    return { ...position, createdAt: new Date(position.createdAt), updatedAt: new Date(position.updatedAt) };
  }
}

@Injectable()
export class JobLevelRepository extends TenantBoundRepository {
  constructor(
    context: TenantContextService,
    @InjectModel(OrgJobLevelRecord.name) private readonly records: Model<OrgJobLevelDocument>,
  ) {
    super(context);
  }

  async findById(id: string, session?: ClientSession): Promise<JobLevel | null> {
    const query = this.records.findOne({ tenantId: this.tenantId(), id });
    if (session !== undefined) query.session(session);
    const record = await query.lean().exec();
    return record === null ? null : Object.freeze({
      id: record.id, tenantId: record.tenantId, code: record.code, name: record.name,
      track: record.track, rank: record.rank, version: record.version,
      createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
    });
  }

  async insert(jobLevel: JobLevel, session: ClientSession): Promise<void> {
    this.assertEntityTenant(jobLevel.tenantId);
    await this.records.create([this.toRecord(jobLevel)], { session });
  }

  async replace(jobLevel: JobLevel, expectedVersion: number, session: ClientSession): Promise<void> {
    this.assertEntityTenant(jobLevel.tenantId);
    const result = await this.records.updateOne(
      { tenantId: this.tenantId(), id: jobLevel.id, version: expectedVersion },
      { $set: {
        code: jobLevel.code,
        name: jobLevel.name,
        track: jobLevel.track,
        rank: jobLevel.rank,
        version: jobLevel.version,
        updatedAt: new Date(jobLevel.updatedAt),
      } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new OrgWriteConflictError();
  }

  private toRecord(jobLevel: JobLevel): Record<string, unknown> {
    return { ...jobLevel, createdAt: new Date(jobLevel.createdAt), updatedAt: new Date(jobLevel.updatedAt) };
  }
}
