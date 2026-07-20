import type { ActorType } from '@gaoq/shared-types';

/** ERP 访问令牌中经过验签与约束校验的声明。 */
export interface VerifiedAccessToken {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: readonly string[];
  readonly resource: readonly string[];
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorType: ActorType;
  readonly roleCodes: readonly string[];
  readonly scopes: readonly string[];
  readonly departmentIds: readonly string[];
  readonly sessionId: string;
  readonly expiresAt: number;
}

/** 外部 SSO 提供者编码。 */
export type SsoProviderCode = 'dingtalk' | 'feishu';

/** 外部平台返回的最小身份，不得直接成为 ERP 授权依据。 */
export interface ExternalIdentityProfile {
  readonly provider: SsoProviderCode;
  readonly externalTenantId: string;
  readonly unionId: string;
  readonly externalUserId: string;
  readonly displayName: string;
}
