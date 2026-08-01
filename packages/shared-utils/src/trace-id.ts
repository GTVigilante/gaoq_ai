import { randomUUID } from 'node:crypto';

/**
 * traceId 白名单：仅允许 1-64 位的大小写字母、数字、点、下划线与连字符。
 * 任何不在白名单内的外部输入都不得进入调用链与日志。
 */
export const TRACE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 校验 traceId 是否符合白名单。
 *
 * @param value 待校验的外部输入
 * @returns 合法且非空字符串时返回 true
 */
export function isValidTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

/**
 * 生成新的 traceId。
 *
 * 使用 `crypto.randomUUID()`，形如 "3f6b0d2e-....-............"，
 * 天然满足白名单约束（36 位十六进制与连字符）。
 *
 * @returns 全新的合法 traceId
 */
export function createTraceId(): string {
  return randomUUID();
}

/**
 * 解析外部传入的 traceId：合法则透传，非法或缺失则重新生成。
 *
 * 外部值（HTTP 头、消息属性、回调参数）一律视为不可信输入，
 * 禁止在不做白名单校验的情况下进入调用链。
 *
 * @param external 外部传入的 traceId，可为空
 * @returns 合法的 traceId；外部值非法时为新生成的值
 */
export function resolveTraceId(external?: string | null): string {
  if (isValidTraceId(external)) {
    return external;
  }
  return createTraceId();
}
