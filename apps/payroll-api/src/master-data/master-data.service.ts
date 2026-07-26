import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  isErpToPayrollEvent,
  type ErpToPayrollEvent,
} from '@gaoq/platform-contracts';
import { Connection, type ClientSession, type Model } from 'mongoose';
import { z } from 'zod';

import { IdentityContextService } from '../identity/identity-context.service.js';
import {
  MasterDataInboxRecord,
  type MasterDataInboxDocument,
  MasterDataProjectionRecord,
  type MasterDataProjectionDocument,
} from './master-data.schemas.js';

export interface MasterDataApplyResult {
  readonly status: 'applied' | 'duplicate';
  readonly eventId: string;
  readonly aggregateVersion: number;
}

export interface MasterDataSnapshotApplyResult {
  readonly snapshotId: string;
  readonly appliedCount: number;
  readonly skippedCount: number;
  readonly nextCursor: string | null;
}

const projectionBaseSchema = z.object({
  aggregateVersion: z.number().int().min(1),
});
const snapshotPageSchema = z.object({
  contractVersion: z.literal('0.1.0'),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.iso.datetime(),
  nextCursor: z.string().min(1).nullable(),
  departments: z.array(projectionBaseSchema.extend({
    departmentId: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    status: z.enum(['active', 'inactive']),
    parentId: z.string().min(1).max(128).nullable(),
    managerEmployeeId: z.string().min(1).max(128).nullable(),
    sortOrder: z.number().int(),
  })).max(200),
  employees: z.array(projectionBaseSchema.extend({
    employeeId: z.string().min(1).max(128),
    employeeNo: z.string().min(1).max(128),
    displayName: z.string().min(1).max(256),
    status: z.enum(['probation', 'active', 'suspended', 'terminated']),
    departmentIds: z.array(z.string().min(1).max(128)).max(200),
    primaryDepartmentId: z.string().min(1).max(128),
    positionIds: z.array(z.string().min(1).max(128)).max(200),
    jobLevelId: z.string().min(1).max(128).nullable(),
  })).max(200),
  employments: z.array(projectionBaseSchema.extend({
    employmentId: z.string().min(1).max(128),
    personId: z.string().min(1).max(128),
    employeeId: z.string().min(1).max(128),
    status: z.enum(['probation', 'active', 'suspended', 'resigned']),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  })).max(200),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(
  (page) => page.snapshotId === page.snapshotDigest,
  { message: 'snapshotId 与 snapshotDigest 不一致' },
).refine(
  (page) =>
    page.departments.length + page.employees.length + page.employments.length <= 200,
  { message: '快照页超过最大条数' },
);

/** 消费 ERP 组织事件并维护租户隔离、严格有序的只读投影。 */
@Injectable()
export class MasterDataService {
  constructor(
    private readonly identity: IdentityContextService,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MasterDataProjectionRecord.name)
    private readonly projections: Model<MasterDataProjectionDocument>,
    @InjectModel(MasterDataInboxRecord.name)
    private readonly inbox: Model<MasterDataInboxDocument>,
  ) {}

  async applyEvent(value: unknown): Promise<MasterDataApplyResult> {
    const actor = this.identity.requireScope('erp:payroll:master-data:sync');
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'MASTER_DATA_SERVICE_IDENTITY_REQUIRED',
        message: '主数据同步只允许受信服务身份',
      });
    }
    if (!isErpToPayrollEvent(value)) {
      throw new BadRequestException({
        code: 'MASTER_DATA_EVENT_INVALID',
        message: 'ERP 主数据事件不符合平台契约',
      });
    }
    if (value.tenantId !== actor.tenantId) {
      throw new ForbiddenException({
        code: 'MASTER_DATA_TENANT_MISMATCH',
        message: '事件租户与服务身份不一致',
      });
    }
    return this.connection.transaction(async (session) => {
      const duplicate = await this.inbox.findOne({
        tenantId: actor.tenantId,
        $or: [
          { eventId: value.id },
          { idempotencyKey: value.idempotencyKey },
        ],
      }).session(session).lean().exec();
      if (duplicate !== null) {
        return {
          status: 'duplicate' as const,
          eventId: value.id,
          aggregateVersion: duplicate.aggregateVersion,
        };
      }
      const descriptor = eventDescriptor(value);
      await this.applyProjection(
        actor.tenantId,
        descriptor.kind,
        descriptor.aggregateId,
        descriptor.aggregateVersion,
        value.data,
        value.time,
        session,
      );
      await this.inbox.create([{
        tenantId: actor.tenantId,
        eventId: value.id,
        eventType: value.type,
        idempotencyKey: value.idempotencyKey,
        aggregateId: descriptor.aggregateId,
        aggregateVersion: descriptor.aggregateVersion,
        traceId: value.traceId,
      }], { session });
      return {
        status: 'applied' as const,
        eventId: value.id,
        aggregateVersion: descriptor.aggregateVersion,
      };
    });
  }

  /** 应用 ERP 权威快照页，用于首次同步和事件版本缺口修复。 */
  async applySnapshotPage(value: unknown): Promise<MasterDataSnapshotApplyResult> {
    const actor = this.identity.requireScope('erp:payroll:master-data:sync');
    if (actor.actorType !== 'service' && actor.actorType !== 'system_job') {
      throw new ForbiddenException({
        code: 'MASTER_DATA_SERVICE_IDENTITY_REQUIRED',
        message: '主数据快照同步只允许受信服务身份',
      });
    }
    const parsed = snapshotPageSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'MASTER_DATA_SNAPSHOT_INVALID',
        message: 'ERP 主数据快照不符合平台契约',
      });
    }
    const page = parsed.data;
    const entries = [
      ...page.departments.map((payload) => ({
        kind: 'department' as const,
        aggregateId: payload.departmentId,
        aggregateVersion: payload.aggregateVersion,
        payload,
      })),
      ...page.employees.map((payload) => ({
        kind: 'employee' as const,
        aggregateId: payload.employeeId,
        aggregateVersion: payload.aggregateVersion,
        payload,
      })),
      ...page.employments.map((payload) => ({
        kind: 'employment' as const,
        aggregateId: payload.employmentId,
        aggregateVersion: payload.aggregateVersion,
        payload,
      })),
    ];
    const result = await this.connection.transaction(async (session) => {
      let appliedCount = 0;
      let skippedCount = 0;
      for (const entry of entries) {
        const existing = await this.projections.findOne({
          tenantId: actor.tenantId,
          kind: entry.kind,
          aggregateId: entry.aggregateId,
        }).session(session).lean().exec();
        if (existing !== null && existing.aggregateVersion >= entry.aggregateVersion) {
          skippedCount += 1;
          continue;
        }
        const updated = await this.projections.updateOne(
          {
            tenantId: actor.tenantId,
            kind: entry.kind,
            aggregateId: entry.aggregateId,
            ...(existing === null
              ? {}
              : { aggregateVersion: existing.aggregateVersion }),
          },
          {
            $set: {
              aggregateVersion: entry.aggregateVersion,
              payload: { ...entry.payload },
              sourceOccurredAt: new Date(page.generatedAt),
            },
            $setOnInsert: {
              tenantId: actor.tenantId,
              kind: entry.kind,
              aggregateId: entry.aggregateId,
            },
          },
          { upsert: true, session },
        ).exec();
        if (updated.upsertedCount === 1 || updated.modifiedCount === 1) {
          appliedCount += 1;
        } else {
          throw new ConflictException({
            code: 'MASTER_DATA_SNAPSHOT_CONCURRENT_WRITE',
            message: '主数据快照应用期间发生并发修改，请重试当前页',
          });
        }
      }
      return { appliedCount, skippedCount };
    });
    return Object.freeze({
      snapshotId: page.snapshotId,
      ...result,
      nextCursor: page.nextCursor,
    });
  }

  async getEmployee(employeeId: string): Promise<Record<string, unknown>> {
    const actor = this.identity.requireScope('erp:payroll:employee:read');
    const projection = await this.projections.findOne({
      tenantId: actor.tenantId,
      kind: 'employee',
      aggregateId: employeeId,
    }).lean().exec();
    if (projection === null) {
      throw new NotFoundException({
        code: 'EMPLOYEE_PROJECTION_NOT_FOUND',
        message: '员工主数据投影不存在',
      });
    }
    if (
      actor.actorType === 'user' &&
      actor.departmentIds.length > 0 &&
      !actor.departmentIds.some((departmentId) =>
        Array.isArray(projection.payload.departmentIds) &&
        projection.payload.departmentIds.includes(departmentId))
    ) {
      throw new ForbiddenException({
        code: 'EMPLOYEE_DEPARTMENT_SCOPE_DENIED',
        message: '员工不在当前部门数据范围',
      });
    }
    return Object.freeze({ ...projection.payload });
  }

  private async applyProjection(
    tenantId: string,
    kind: 'department' | 'employee' | 'employment',
    aggregateId: string,
    aggregateVersion: number,
    payload: object,
    occurredAt: string | undefined,
    session: ClientSession,
  ): Promise<void> {
    const existing = await this.projections.findOne({
      tenantId,
      kind,
      aggregateId,
    }).session(session).lean().exec();
    if (existing !== null && existing.aggregateVersion >= aggregateVersion) {
      throw new ConflictException({
        code: 'MASTER_DATA_EVENT_STALE',
        message: '主数据事件版本已处理或已过期',
      });
    }
    if (existing !== null && existing.aggregateVersion + 1 !== aggregateVersion) {
      throw new ConflictException({
        code: 'MASTER_DATA_VERSION_GAP',
        message: '主数据事件存在版本缺口，必须执行快照修复',
      });
    }
    if (existing === null && aggregateVersion !== 1) {
      throw new ConflictException({
        code: 'MASTER_DATA_INITIAL_VERSION_GAP',
        message: '首次主数据事件不是版本 1，必须执行快照修复',
      });
    }
    await this.projections.updateOne(
      { tenantId, kind, aggregateId },
      {
        $set: {
          aggregateVersion,
          payload: { ...payload },
          sourceOccurredAt: occurredAt === undefined ? new Date() : new Date(occurredAt),
        },
        $setOnInsert: { tenantId, kind, aggregateId },
      },
      { upsert: true, session },
    ).exec();
  }
}

const eventDescriptor = (
  event: ErpToPayrollEvent,
): {
  readonly kind: 'department' | 'employee' | 'employment';
  readonly aggregateId: string;
  readonly aggregateVersion: number;
} => {
  if (event.type === 'com.gaoq.erp.org.department.upserted.v1') {
    return {
      kind: 'department',
      aggregateId: event.data.departmentId,
      aggregateVersion: event.data.aggregateVersion,
    };
  }
  if (event.type === 'com.gaoq.erp.org.employee.upserted.v1') {
    return {
      kind: 'employee',
      aggregateId: event.data.employeeId,
      aggregateVersion: event.data.aggregateVersion,
    };
  }
  return {
    kind: 'employment',
    aggregateId: event.data.employmentId,
    aggregateVersion: event.data.aggregateVersion,
  };
};
