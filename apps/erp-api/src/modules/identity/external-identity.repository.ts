import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import {
  ExternalIdentity,
  type ExternalIdentityDocument,
  type ExternalIdentityProvider,
} from './external-identity.schema.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 外部平台回调/同步得到的用户身份档案，字段均为标量，禁止透传客户端对象。 */
export interface ExternalProfile {
  provider: ExternalIdentityProvider;
  externalTenantId: string;
  unionId: string;
  externalUserId: string;
}

/**
 * 外部身份映射仓储。
 * 安全约定：所有查询必须携带 tenantId；动态值一律作为普通 Mongo 标量值传入，
 * 不展开客户端传入的对象，避免查询注入；不提供手机号/邮箱自动合并能力。
 */
@Injectable()
export class ExternalIdentityRepository {
  constructor(
    @InjectModel(ExternalIdentity.name)
    private readonly externalIdentities: Model<ExternalIdentityDocument>,
  ) {}

  /**
   * 按外部身份档案查找租户内处于 bound 状态的绑定。
   * unionId 与 externalUserId 必须同时一致；任一漂移都失败关闭并进入人工仲裁。
   */
  async findBoundByExternalProfile(
    tenantId: string,
    profile: ExternalProfile,
  ): Promise<ExternalIdentityDocument | null> {
    return this.externalIdentities
      .findOne({
        tenantId,
        provider: profile.provider,
        externalTenantId: profile.externalTenantId,
        status: 'bound',
        unionId: profile.unionId,
        externalUserId: profile.externalUserId,
      })
      .exec();
  }

  /**
   * 停用租户内指定绑定；过滤条件强制包含 tenantId，不允许跨租户更新。
   * 返回是否实际修改了一条记录。
   */
  async disable(tenantId: string, id: string): Promise<boolean> {
    const result = await this.externalIdentities.updateOne(
      { _id: id, tenantId, status: 'bound' },
      { $set: { status: 'disabled' } },
    );
    return result.modifiedCount === 1;
  }

  /** 固定投影反查员工关联的全部 ERP 主体，供离职事务吊销登录材料。 */
  async findActorIdsByEmployee(
    tenantId: string,
    employeeId: string,
    mongoSession: ClientSession,
  ): Promise<readonly string[]> {
    this.assertIds(tenantId, employeeId);
    const records = await this.externalIdentities
      .find({ tenantId, employeeId })
      .select('actorId -_id')
      .session(mongoSession)
      .lean()
      .exec();
    return Object.freeze([...new Set(records.map((record) => record.actorId))].sort());
  }

  /** 离职事务内停用员工的全部已绑定外部身份，不影响其他租户或已停用记录。 */
  async disableAllByEmployee(
    tenantId: string,
    employeeId: string,
    mongoSession: ClientSession,
  ): Promise<number> {
    this.assertIds(tenantId, employeeId);
    const result = await this.externalIdentities.updateMany(
      { tenantId, employeeId, status: 'bound' },
      { $set: { status: 'disabled' } },
      { session: mongoSession },
    );
    return result.modifiedCount;
  }

  private assertIds(tenantId: string, employeeId: string): void {
    if (!ID_PATTERN.test(tenantId) || !ID_PATTERN.test(employeeId)) {
      throw new Error('外部身份生命周期标识非法');
    }
  }
}
