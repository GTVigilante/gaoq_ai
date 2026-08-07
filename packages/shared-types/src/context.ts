/**
 * 租户上下文。
 *
 * `tenantId` 必须由服务端已验证身份派生（访问令牌或服务身份），
 * 请求头中的租户标识仅可用于诊断日志，禁止作为 `tenantId` 来源。
 */
export interface TenantContext {
  /** 租户唯一标识，来源于已验证身份，不接受客户端头回退。 */
  readonly tenantId: string;
  /** 租户身份的派生来源。 */
  readonly source: 'access_token' | 'service_identity';
}

/** 操作主体类型。 */
export type ActorType = 'user' | 'service' | 'mcp_client' | 'system_job';

/**
 * 操作主体上下文。
 *
 * 必须贯穿同步调用、队列任务、MCP 调用与审计日志；
 * 异步任务不得退化为无主体的超级权限。
 */
export interface ActorContext {
  /** 主体类型。 */
  readonly actorType: ActorType;
  /** 主体唯一标识（用户 ID、服务名或任务标识）。 */
  readonly actorId: string;
  /** 主体所属租户，必须与已验证身份一致。 */
  readonly tenantId: string;
  /** 主体拥有的角色编码集合。 */
  readonly roleCodes: readonly string[];
  /** 主体被授权的 scope 集合。 */
  readonly scopes: readonly string[];
  /** 主体可见的部门数据范围。 */
  readonly departmentIds: readonly string[];
  /** 当前调用链的追踪标识。 */
  readonly traceId: string;
}
