/** 币种编码，当前仅支持人民币，后续按 ISO 4217 扩展。 */
export type CurrencyCode = 'CNY';

/**
 * 金额值对象（跨 JSON 传输形态）。
 *
 * - `amountMinor` 为最小货币单位（分）的十进制字符串，
 *   跨 JSON 边界禁止使用 JavaScript `number` 或浮点数；
 * - 领域层内部计算应通过 `@gaoq/shared-utils` 转换为 `BigInt` 后进行。
 */
export interface Money {
  /** 最小货币单位金额，十进制整数字符串，例如 "12345" 表示 123.45 元。 */
  readonly amountMinor: string;
  /** 币种编码。 */
  readonly currency: CurrencyCode;
}
