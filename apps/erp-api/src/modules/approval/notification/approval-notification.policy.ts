export const APPROVAL_NOTIFICATION_MAX_ATTEMPTS = 12;
const MAX_DELAY_MS = 6 * 60 * 60 * 1_000;

/** 指数退避并加入 ±20% 抖动，最大 6 小时，避免平台恢复时惊群。 */
export function nextApprovalNotificationAttemptAt(
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): Date {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > APPROVAL_NOTIFICATION_MAX_ATTEMPTS) {
    throw new RangeError('审批通知重试次数非法');
  }
  if (Number.isNaN(now.getTime())) throw new TypeError('审批通知重试基准时间非法');
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('审批通知重试随机数非法');
  }
  const base = Math.min(1_000 * (5 ** (attempts - 1)), MAX_DELAY_MS);
  return new Date(now.getTime() + Math.round(base * (0.8 + sample * 0.4)));
}
