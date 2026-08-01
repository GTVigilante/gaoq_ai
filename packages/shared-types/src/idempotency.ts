/**
 * 幂等上下文。
 *
 * 携带幂等键的业务操作（队列任务、回调处理、重试提交）
 * 必须据此判断重复执行；幂等键在 `tenantId + scope` 内唯一。
 */
export interface IdempotencyContext {
  /** 幂等键，由调用方生成，重复提交时保持不变。 */
  readonly key: string;
  /** 幂等键所属租户，禁止跨租户复用同一键空间。 */
  readonly tenantId: string;
  /** 幂等键的业务作用域，例如 "payroll.payout"。 */
  readonly scope: string;
  /** 幂等记录过期时间，UTC ISO 8601 字符串；过期后可安全重用键。 */
  readonly expiresAt?: string;
}
