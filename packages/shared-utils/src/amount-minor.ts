/**
 * amountMinor（最小货币单位）十进制字符串的转换与运算。
 *
 * 金额跨 JSON 边界以十进制字符串传输；进入领域计算前必须
 * 通过本模块转换为 `BigInt`，禁止 JavaScript `number` 参与财务计算。
 */

/** 合法的 amountMinor 形式：可选负号后跟至少一位数字，不允许小数点、空白与千分位。 */
export const AMOUNT_MINOR_PATTERN = /^-?\d+$/;

/**
 * 校验 amountMinor 十进制字符串是否合法。
 *
 * @param value 待校验的输入
 * @returns 合法时返回 true
 */
export function isValidAmountMinor(value: unknown): value is string {
  return typeof value === 'string' && AMOUNT_MINOR_PATTERN.test(value);
}

/**
 * 将 amountMinor 十进制字符串转换为 `BigInt`。
 *
 * @param value 十进制整数字符串，例如 "12345" 或 "-500"
 * @returns 对应的 `BigInt` 值
 * @throws {RangeError} 输入不是合法的十进制整数字符串
 */
export function parseAmountMinor(value: string): bigint {
  if (!isValidAmountMinor(value)) {
    throw new RangeError(`非法的 amountMinor 十进制字符串: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/**
 * 将 `BigInt` 金额转换回 amountMinor 十进制字符串。
 *
 * @param value 最小货币单位金额
 * @returns 十进制整数字符串
 */
export function formatAmountMinor(value: bigint): string {
  return value.toString(10);
}

/**
 * 两个 amountMinor 十进制字符串相加。
 *
 * @param left 左操作数
 * @param right 右操作数
 * @returns 和的十进制字符串
 * @throws {RangeError} 任一操作数非法
 */
export function addAmountMinor(left: string, right: string): string {
  return formatAmountMinor(parseAmountMinor(left) + parseAmountMinor(right));
}

/**
 * 两个 amountMinor 十进制字符串相减（left - right）。
 *
 * @param left 被减数
 * @param right 减数
 * @returns 差的十进制字符串，可能为负
 * @throws {RangeError} 任一操作数非法
 */
export function subtractAmountMinor(left: string, right: string): string {
  return formatAmountMinor(parseAmountMinor(left) - parseAmountMinor(right));
}
