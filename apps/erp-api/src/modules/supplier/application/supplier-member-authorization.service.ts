import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import type { SupplierPartyKind } from '../domain/supplier.js';
import type { SupplierMemberPermission } from '../domain/supplier-member.js';
import { SupplierMemberRepository } from '../persistence/supplier-member.repository.js';

/** 供应账号与履约者授权的唯一解析 seam；始终从可信 actor 和当前持久化关系解析。 */
@Injectable()
export class SupplierMemberAuthorizationService {
  constructor(
    private readonly context: TenantContextService,
    private readonly members: SupplierMemberRepository,
  ) {}

  async resolveUniqueSelf(permission: SupplierMemberPermission) {
    const actor = this.context.getActorRequired();
    if (actor.actorType !== 'user') {
      throw new ForbiddenException({ code: 'SUPPLIER_SELF_USER_REQUIRED', message: '供应方自助能力仅允许用户委托身份' });
    }
    const day = new Date().toISOString().slice(0, 10);
    const matches = await this.members.listActiveByActor(actor.actorId, permission, day);
    if (matches.length !== 1) {
      throw new ForbiddenException({ code: 'SUPPLIER_SELF_RELATIONSHIP_UNRESOLVED', message: '无法解析唯一有效的供应方本人关系' });
    }
    return matches[0]!;
  }

  async assertPerformersAuthorized(
    supplierId: string,
    partyKind: SupplierPartyKind,
    performerRefs: readonly string[],
    at = new Date(),
  ): Promise<void> {
    if (performerRefs.length < 1) {
      throw new ConflictException({ code: 'SUPPLIER_PERFORMER_REQUIRED', message: '履约委托必须指定至少一名已授权履约者' });
    }
    if (partyKind === 'individual' && performerRefs.length !== 1) {
      throw new ConflictException({ code: 'SUPPLIER_INDIVIDUAL_PERFORMER_INVALID', message: '个人供应方只能绑定本人履约者' });
    }
    const members = await this.members.listActivePerformers(
      supplierId, performerRefs, at.toISOString().slice(0, 10),
    );
    const resolved = new Set(members.map((member) => member.performerRef));
    if (resolved.size !== performerRefs.length || performerRefs.some((reference) => !resolved.has(reference))) {
      throw new ConflictException({ code: 'SUPPLIER_PERFORMER_UNAUTHORIZED', message: '存在未授权、已撤销或已到期的履约者' });
    }
  }
}
