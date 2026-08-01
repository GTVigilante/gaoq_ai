/** OP 审批桥重试退避档位：1 秒、5 秒、30 秒、2 分钟、10 分钟、30 分钟。 */
export const OP_APPROVAL_RETRY_DELAYS_MS = [
  1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000,
] as const;

/** OP 审批桥自动重试上限。 */
export const OP_APPROVAL_MAX_ATTEMPTS = OP_APPROVAL_RETRY_DELAYS_MS.length;

/**
 * 计算带 ±20% 抖动的下一次重试时间。
 * @param attempts 本次失败后的累计失败次数。
 * @param now 当前时间。
 * @param random 随机源，必须返回 [0, 1)。
 */
export function calculateOpApprovalNextAttemptAt(
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): Date {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > OP_APPROVAL_MAX_ATTEMPTS) {
    throw new RangeError(`attempts 必须为 1..${OP_APPROVAL_MAX_ATTEMPTS} 的整数`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now 必须为有效 Date');
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('random() 必须返回 [0, 1) 的数值');
  }
  const baseDelay = OP_APPROVAL_RETRY_DELAYS_MS[attempts - 1];
  if (baseDelay === undefined) throw new RangeError('未配置对应退避档位');
  const factor = 1 + (sample * 2 - 1) * 0.2;
  return new Date(now.getTime() + Math.round(baseDelay * factor));
}
