import type { ActorContext, ActorType, TenantContext } from '@gaoq/shared-types';

/** 算薪 API 接受的 GaoQ 已验证访问身份。 */
export interface PayrollIdentityContext extends ActorContext {
  /** 人员主体绑定的 GaoQ employeeId；服务主体为 null。 */
  readonly employeeId: string | null;
  /** OAuth 客户端标识。 */
  readonly clientId: string;
  /** 会话或服务凭据标识。 */
  readonly sessionId: string;
  /** JWT issuer。 */
  readonly issuer: string;
  /** JWT subject。 */
  readonly subject: string;
  /** JWT audience。 */
  readonly audience: readonly string[];
  /** OAuth resource indicator。 */
  readonly resource: readonly string[];
  /** 令牌过期时间，Unix 秒。 */
  readonly expiresAt: number;
}

export type { ActorContext, ActorType, TenantContext };
