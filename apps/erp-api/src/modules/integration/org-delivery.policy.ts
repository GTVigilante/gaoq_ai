/**
 * 组织下发纯策略：退避计算与失败分类。
 * 不依赖 NestJS / Mongoose，可独立单测。
 */

/** 下发重试退避档位（毫秒）：1s / 5s / 30s / 2min / 10min / 30min。 */
export const ORG_DELIVERY_RETRY_DELAYS_MS = [
  1000, 5000, 30000, 120000, 600000, 1800000,
] as const;

/** 最大重试次数，attempts 按“本次失败后累计次数”取 1..6 档，不得超过。 */
export const ORG_DELIVERY_MAX_ATTEMPTS = ORG_DELIVERY_RETRY_DELAYS_MS.length;

/** 退避抖动幅度：±20%。 */
const JITTER_RATIO = 0.2;

/** 组织下发失败分类。 */
export type OrgDeliveryFailureCategory = 'retryable' | 'business';

/**
 * 计算下一次可下发时间。
 * @param attempts 本次失败后的累计失败次数，必须为 1..6 的整数。
 * @param now 当前时间，必须为有效 Date。
 * @param random 抖动随机源，返回 [0, 1)，默认 Math.random。
 * @returns now + 基准延迟 × [1-20%, 1+20%] 抖动后的时间。
 */
export function calculateNextAttemptAt(
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): Date {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > ORG_DELIVERY_MAX_ATTEMPTS) {
    throw new RangeError(
      `attempts 必须为 1..${ORG_DELIVERY_MAX_ATTEMPTS} 的整数，当前值: ${String(attempts)}`,
    );
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now 必须为有效 Date');
  }
  const sample = random();
  if (typeof sample !== 'number' || Number.isNaN(sample) || sample < 0 || sample >= 1) {
    throw new RangeError(`random() 必须返回 [0, 1) 的数值，当前值: ${String(sample)}`);
  }
  const baseDelay = ORG_DELIVERY_RETRY_DELAYS_MS[attempts - 1];
  if (baseDelay === undefined) {
    // 防御分支：attempts 已校验 1..6，正常不会命中。
    throw new RangeError(`未配置第 ${attempts} 档退避延迟`);
  }
  // 抖动因子 [0.8, 1.2)，避免多实例同步重试造成惊群。
  const factor = 1 + (sample * 2 - 1) * JITTER_RATIO;
  return new Date(now.getTime() + Math.round(baseDelay * factor));
}

/**
 * 按 HTTP 状态码分类下发失败。
 * 网络层失败（undefined）、408、429、5xx 视为可重试；其余 4xx 视为业务失败。
 * 无状态码的非数值输入按网络异常处理（可重试，失败保守方向）。
 */
export function classifyOrgDeliveryFailure(status: number | undefined): OrgDeliveryFailureCategory {
  if (status === undefined || !Number.isInteger(status)) {
    return 'retryable';
  }
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
    return 'retryable';
  }
  return 'business';
}
