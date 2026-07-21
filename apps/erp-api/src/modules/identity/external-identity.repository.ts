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

export interface ProvisionedExternalIdentityInput extends ExternalProfile {
  readonly actorId: string;
  readonly employeeId: string;
}

export interface BoundEmployeeExternalIdentitySnapshot {
  readonly actorId: string;
  readonly externalUserId: string;
  readonly unionId: string;
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

  /** 按租户+平台租户+员工精确确认已绑定身份。 */
  async findBoundByEmployee(
    tenantId: string,
    provider: ExternalIdentityProvider,
    externalTenantId: string,
    employeeId: string,
  ): Promise<BoundEmployeeExternalIdentitySnapshot | null> {
    this.assertIds(tenantId, employeeId);
    if (!/^[A-Za-z0-9._:@-]{1,256}$/.test(externalTenantId)) {
      throw new Error('外部租户标识非法');
    }
    const record = await this.externalIdentities.findOne(
      { tenantId, provider, externalTenantId, employeeId, status: 'bound' },
      { actorId: 1, externalUserId: 1, unionId: 1, _id: 0 },
    ).lean().exec();
    return record === null
      ? null
      : Object.freeze({
          actorId: record.actorId,
          externalUserId: record.externalUserId,
          unionId: record.unionId,
        });
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

  /**
   * 将已由私密通道开通的平台身份幂等绑定。
   * 过滤条件包含全部不可变标识和 bound 状态；任一冲突由唯一索引失败关闭，
   * 禁止依据手机号或邮箱合并身份。
   */
  async bindProvisioned(
    tenantId: string,
    input: ProvisionedExternalIdentityInput,
    mongoSession: ClientSession,
  ): Promise<void> {
    this.assertIds(tenantId, input.employeeId);
    for (const value of [
      input.externalTenantId,
      input.unionId,
      input.externalUserId,
      input.actorId,
    ]) {
      if (!/^[A-Za-z0-9._:@-]{1,256}$/.test(value)) {
        throw new Error('开户外部身份标识非法');
      }
    }
    await this.externalIdentities.updateOne(
      {
        tenantId,
        provider: input.provider,
        externalTenantId: input.externalTenantId,
        unionId: input.unionId,
        externalUserId: input.externalUserId,
        actorId: input.actorId,
        employeeId: input.employeeId,
        status: 'bound',
      },
      {
        $setOnInsert: {
          tenantId,
          provider: input.provider,
          externalTenantId: input.externalTenantId,
          unionId: input.unionId,
          externalUserId: input.externalUserId,
          actorId: input.actorId,
          employeeId: input.employeeId,
          status: 'bound',
        },
      },
      { upsert: true, session: mongoSession, runValidators: true },
    );
  }

  private assertIds(tenantId: string, employeeId: string): void {
    if (!ID_PATTERN.test(tenantId) || !ID_PATTERN.test(employeeId)) {
      throw new Error('外部身份生命周期标识非法');
    }
  }
}
