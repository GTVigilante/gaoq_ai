import { Controller, Get } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { TenantContextService } from '../../core/tenant/tenant-context.service.js';
import { RequiredScopes } from './auth.decorators.js';

export interface IdentityProfileView {
  readonly actorId: string;
  readonly actorType: 'user' | 'service' | 'mcp_client' | 'system_job';
  readonly roleCodes: readonly string[];
  readonly scopes: readonly string[];
  readonly departmentIds: readonly string[];
}

/** 浏览器个人中心只返回已验证令牌派生的授权快照，不接受租户或主体参数。 */
@Controller('auth/profile')
export class IdentityProfileController {
  constructor(
    private readonly context: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequiredScopes('erp:identity:profile:read')
  async get(): Promise<IdentityProfileView> {
    const actor = this.context.getActorRequired();
    const profile = Object.freeze({
      actorId: actor.actorId,
      actorType: actor.actorType,
      roleCodes: Object.freeze([...actor.roleCodes]),
      scopes: Object.freeze([...actor.scopes]),
      departmentIds: Object.freeze([...actor.departmentIds]),
    });
    await this.audit.record({
      action: 'identity.profile.read',
      resourceType: 'identity_profile',
      resourceId: actor.actorId,
      riskLevel: 'R0',
      outcome: 'success',
      metadata: {
        roleCount: profile.roleCodes.length,
        scopeCount: profile.scopes.length,
        departmentCount: profile.departmentIds.length,
      },
    });
    return profile;
  }
}
