import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { ERP_AUTHORIZATION_SCOPE_PATTERN } from './authorization-scope.js';
import {
  AccessProfile,
  type AccessProfileDocument,
  type AccessProfileStatus,
} from './access-profile.schema.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_VERSION = 1_000_000_000;

/** 鉴权使用的授权权限快照：不可变普通对象，数组已复制并冻结。 */
export interface AccessProfileSnapshot {
  readonly tenantId: string;
  readonly actorId: string;
  readonly employeeId: string;
  readonly status: AccessProfileStatus;
  readonly roleCodes: readonly string[];
  readonly scopes: readonly string[];
  readonly departmentIds: readonly string[];
  readonly version: number;
}

export interface EmployeeAccessIdentitySnapshot {
  readonly actorId: string;
  readonly status: AccessProfileStatus;
}

/** 最小投影：只取鉴权所需字段，不带回 _id 与 Mongoose 内部字段。 */
const SNAPSHOT_PROJECTION =
  'tenantId actorId employeeId status roleCodes scopes departmentIds version -_id';

/**
 * 授权权限快照仓储。
 * 安全约定：所有查询强制携带 tenantId；动态值一律作为标量传入，
 * 禁止接收客户端查询对象/动态字段；返回值一律为冻结的普通对象，禁止返回 Mongoose 文档。
 */
@Injectable()
export class AccessProfileRepository {
  constructor(
    @InjectModel(AccessProfile.name)
    private readonly accessProfiles: Model<AccessProfileDocument>,
  ) {}

  /**
   * 解析租户内指定 actor 当前生效的授权快照。
   * 查询条件固定为 tenantId + actorId + status=active；找不到返回 null。
   * 返回冻结的普通对象，数组为独立副本且已冻结，调用方无法反向修改库中数据。
   */
  async resolveActive(
    tenantId: string,
    actorId: string,
    mongoSession?: ClientSession,
  ): Promise<AccessProfileSnapshot | null> {
    this.assertId(tenantId);
    this.assertId(actorId);
    const query = this.accessProfiles.findOne({ tenantId, actorId, status: 'active' });
    if (mongoSession !== undefined) {
      query.session(mongoSession);
    }
    const doc = await query
      .select(SNAPSHOT_PROJECTION)
      .lean()
      .exec();
    if (!doc) {
      return null;
    }
    return this.toSnapshot(doc, tenantId, actorId);
  }

  /** 审批人解析专用：按固定角色白名单查询有效主体，可选限制在部门交集内。 */
  async findActiveByRoles(
    tenantId: string,
    roleCodes: readonly string[],
    departmentIds: readonly string[] | null,
    mongoSession?: ClientSession,
  ): Promise<readonly AccessProfileSnapshot[]> {
    this.assertId(tenantId);
    if (
      roleCodes.length < 1 || roleCodes.length > 50 ||
      roleCodes.some((code) => !ID_PATTERN.test(code)) ||
      new Set(roleCodes).size !== roleCodes.length ||
      (departmentIds !== null && (
        departmentIds.length < 1 || departmentIds.length > 500 ||
        departmentIds.some((id) => !ID_PATTERN.test(id)) ||
        new Set(departmentIds).size !== departmentIds.length
      ))
    ) throw new Error('审批角色解析参数非法');
    const filter: Record<string, unknown> = {
      tenantId,
      status: 'active',
      roleCodes: { $in: [...roleCodes] },
      ...(departmentIds === null ? {} : { departmentIds: { $in: [...departmentIds] } }),
    };
    const query = this.accessProfiles.find(filter).sort({ actorId: 1 }).limit(501);
    if (mongoSession !== undefined) query.session(mongoSession);
    const records = await query.select(SNAPSHOT_PROJECTION).lean().exec();
    if (records.length > 500) throw new Error('审批角色解析结果超过 500 人上限');
    return Object.freeze(records.map((record) => this.toSnapshot(record, tenantId)));
  }

  /**
   * 停用租户内指定 actor 的授权快照。
   * 过滤条件强制包含 tenantId 与 expectedVersion（乐观锁），命中后 version + 1；
   * 跨租户、非 active 或版本不匹配均返回 false，不产生任何修改。
   */
  async disable(tenantId: string, actorId: string, expectedVersion: number): Promise<boolean> {
    this.assertId(tenantId);
    this.assertId(actorId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > MAX_VERSION) {
      throw new Error('授权快照版本非法');
    }
    const result = await this.accessProfiles.updateOne(
      { tenantId, actorId, status: 'active', version: expectedVersion },
      { $set: { status: 'disabled' }, $inc: { version: 1 } },
    );
    return result.modifiedCount === 1;
  }

  /** 固定投影反查员工授权主体，包含已停用快照以覆盖异常残留会话。 */
  async findActorIdByEmployee(
    tenantId: string,
    employeeId: string,
    mongoSession?: ClientSession,
  ): Promise<string | null> {
    this.assertId(tenantId);
    this.assertId(employeeId);
    const query = this.accessProfiles
      .findOne({ tenantId, employeeId })
      .select('actorId -_id');
    if (mongoSession !== undefined) query.session(mongoSession);
    const record = await query
      .lean()
      .exec();
    if (record === null) return null;
    this.assertId(record.actorId);
    return record.actorId;
  }

  /** 开户前只读解析员工主体与启停状态，不返回权限数组。 */
  async resolveEmployeeIdentity(
    tenantId: string,
    employeeId: string,
  ): Promise<EmployeeAccessIdentitySnapshot | null> {
    this.assertId(tenantId);
    this.assertId(employeeId);
    const record = await this.accessProfiles
      .findOne({ tenantId, employeeId })
      .select('actorId status -_id')
      .lean()
      .exec();
    if (record === null) return null;
    this.assertId(record.actorId);
    if (record.status !== 'active' && record.status !== 'disabled') {
      throw new Error('授权快照持久化记录受损');
    }
    return Object.freeze({ actorId: record.actorId, status: record.status });
  }

  /** 开户绑定事务内幂等确保最小权限员工主体，既有冲突失败关闭。 */
  async ensureProvisionedEmployee(
    tenantId: string,
    employeeId: string,
    actorId: string,
    departmentIds: readonly string[],
    mongoSession: ClientSession,
  ): Promise<void> {
    this.assertId(tenantId);
    this.assertId(employeeId);
    if (
      !ID_PATTERN.test(actorId) ||
      departmentIds.length < 1 || departmentIds.length > 500 ||
      !departmentIds.every((departmentId) => ID_PATTERN.test(departmentId))
    ) throw new Error('开户授权主体参数非法');
    await this.accessProfiles.updateOne(
      { tenantId, employeeId, actorId, status: 'active' },
      {
        $setOnInsert: {
          tenantId,
          employeeId,
          actorId,
          status: 'active',
          roleCodes: [],
          scopes: [],
          departmentIds: [...new Set(departmentIds)],
          version: 1,
        },
      },
      { upsert: true, session: mongoSession, runValidators: true },
    );
  }

  /** 离职事务内停用员工当前有效授权快照并推进版本。 */
  async disableByEmployee(
    tenantId: string,
    employeeId: string,
    mongoSession: ClientSession,
  ): Promise<boolean> {
    this.assertId(tenantId);
    this.assertId(employeeId);
    const result = await this.accessProfiles.updateOne(
      { tenantId, employeeId, status: 'active' },
      { $set: { status: 'disabled' }, $inc: { version: 1 } },
      { session: mongoSession },
    );
    return result.modifiedCount === 1;
  }

  private assertId(value: string): void {
    if (!ID_PATTERN.test(value)) {
      throw new Error('授权快照生命周期标识非法');
    }
  }

  private toSnapshot(
    record: AccessProfile,
    expectedTenantId: string,
    expectedActorId?: string,
  ): AccessProfileSnapshot {
    const scalarIds = [record.tenantId, record.actorId, record.employeeId];
    const validArrays =
      Array.isArray(record.roleCodes) &&
      record.roleCodes.length <= 100 &&
      record.roleCodes.every((value) => ID_PATTERN.test(value)) &&
      new Set(record.roleCodes).size === record.roleCodes.length &&
      Array.isArray(record.scopes) &&
      record.scopes.length <= 200 &&
      record.scopes.every((value) => ERP_AUTHORIZATION_SCOPE_PATTERN.test(value)) &&
      new Set(record.scopes).size === record.scopes.length &&
      Array.isArray(record.departmentIds) &&
      record.departmentIds.length <= 500 &&
      record.departmentIds.every((value) => ID_PATTERN.test(value)) &&
      new Set(record.departmentIds).size === record.departmentIds.length;
    if (
      scalarIds.some((value) => !ID_PATTERN.test(value)) ||
      record.tenantId !== expectedTenantId ||
      (expectedActorId !== undefined && record.actorId !== expectedActorId) ||
      record.status !== 'active' ||
      !validArrays ||
      !Number.isSafeInteger(record.version) ||
      record.version < 1 ||
      record.version > MAX_VERSION
    ) {
      throw new Error('授权快照持久化记录受损');
    }
    return Object.freeze({
      tenantId: record.tenantId,
      actorId: record.actorId,
      employeeId: record.employeeId,
      status: record.status,
      roleCodes: Object.freeze([...record.roleCodes]),
      scopes: Object.freeze([...record.scopes]),
      departmentIds: Object.freeze([...record.departmentIds]),
      version: record.version,
    });
  }
}
