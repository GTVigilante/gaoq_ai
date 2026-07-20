import type { Request } from 'express';
import type { ActorType, TenantContext } from '@gaoq/shared-types';

/** 已经由认证守卫验签并写入请求的可信主体。 */
export interface TrustedPrincipal {
  readonly actorId: string;
  readonly actorType: ActorType;
  readonly tenantId: string;
  readonly identitySource: TenantContext['source'];
  readonly roleCodes: readonly string[];
  readonly scopes: readonly string[];
  readonly departmentIds: readonly string[];
}

/** ERP 请求对象；身份字段只能由认证设施写入。 */
export interface ErpRequest extends Request {
  traceId?: string;
  user?: TrustedPrincipal;
}
