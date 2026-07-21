import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import {
  AccessProfile,
  type AccessProfileDocument,
  type AccessProfileStatus,
} from './access-profile.schema.js';

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
    return Object.freeze({
      tenantId: doc.tenantId,
      actorId: doc.actorId,
      employeeId: doc.employeeId,
      status: doc.status,
      roleCodes: Object.freeze([...doc.roleCodes]),
      scopes: Object.freeze([...doc.scopes]),
      departmentIds: Object.freeze([...doc.departmentIds]),
      version: doc.version,
    });
  }

  /**
   * 停用租户内指定 actor 的授权快照。
   * 过滤条件强制包含 tenantId 与 expectedVersion（乐观锁），命中后 version + 1；
   * 跨租户、非 active 或版本不匹配均返回 false，不产生任何修改。
   */
  async disable(tenantId: string, actorId: string, expectedVersion: number): Promise<boolean> {
    const result = await this.accessProfiles.updateOne(
      { tenantId, actorId, status: 'active', version: expectedVersion },
      { $set: { status: 'disabled' }, $inc: { version: 1 } },
    );
    return result.modifiedCount === 1;
  }
}
