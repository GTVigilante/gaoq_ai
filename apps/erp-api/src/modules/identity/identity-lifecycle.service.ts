import { Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongoose';

import { AccessProfileRepository } from './access-profile.repository.js';
import { ExternalIdentityRepository } from './external-identity.repository.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { SessionService } from './session.service.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface EmployeeIdentityTerminationResult {
  readonly actorIds: readonly string[];
  readonly accessProfileDisabled: boolean;
  readonly externalIdentitiesDisabled: number;
  readonly sessionsRevoked: number;
  readonly refreshTokensRevoked: number;
}

/** 组织生命周期与身份安全的原子编排端口；不得由外部平台回调直接调用。 */
@Injectable()
export class IdentityLifecycleService {
  constructor(
    private readonly profiles: AccessProfileRepository,
    private readonly externalIdentities: ExternalIdentityRepository,
    private readonly refreshTokens: RefreshTokenService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * 在调用方提供的 Mongo 事务中完成员工离职身份封禁。
   * 先固定查询全部 ERP 主体，再停用授权与外部绑定并吊销全部登录材料；
   * 所有写入共用同一 ClientSession，任一步失败均由外层事务整体回滚。
   */
  async terminateEmployee(
    tenantId: string,
    employeeId: string,
    mongoSession: ClientSession,
  ): Promise<EmployeeIdentityTerminationResult> {
    this.assertId(tenantId);
    this.assertId(employeeId);
    const actorIds = new Set<string>();
    const profileActorId = await this.profiles.findActorIdByEmployee(
      tenantId,
      employeeId,
      mongoSession,
    );
    if (profileActorId !== null) actorIds.add(profileActorId);
    const externalActorIds = await this.externalIdentities.findActorIdsByEmployee(
      tenantId,
      employeeId,
      mongoSession,
    );
    for (const actorId of externalActorIds) actorIds.add(actorId);
    if (actorIds.size > 100) throw new Error('员工身份主体数量超过安全上限');

    const accessProfileDisabled = await this.profiles.disableByEmployee(
      tenantId,
      employeeId,
      mongoSession,
    );
    const externalIdentitiesDisabled = await this.externalIdentities.disableAllByEmployee(
      tenantId,
      employeeId,
      mongoSession,
    );
    const frozenActorIds = Object.freeze([...actorIds].sort());
    let refreshTokensRevoked = 0;
    let sessionsRevoked = 0;
    if (frozenActorIds.length > 0) {
      refreshTokensRevoked = await this.refreshTokens.revokeAllByActors(
        tenantId,
        frozenActorIds,
        mongoSession,
      );
      sessionsRevoked = await this.sessions.revokeAllByActors(
        tenantId,
        frozenActorIds,
        mongoSession,
      );
    }
    return Object.freeze({
      actorIds: frozenActorIds,
      accessProfileDisabled,
      externalIdentitiesDisabled,
      sessionsRevoked,
      refreshTokensRevoked,
    });
  }

  private assertId(value: string): void {
    if (!ID_PATTERN.test(value)) throw new Error('员工身份生命周期标识非法');
  }
}
