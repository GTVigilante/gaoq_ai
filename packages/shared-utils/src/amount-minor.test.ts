import { describe, expect, it } from 'vitest';
import {
  addAmountMinor,
  formatAmountMinor,
  isValidAmountMinor,
  parseAmountMinor,
  subtractAmountMinor,
} from './amount-minor.js';

describe('isValidAmountMinor', () => {
  it('接受十进制整数字符串', () => {
    expect(isValidAmountMinor('0')).toBe(true);
    expect(isValidAmountMinor('12345')).toBe(true);
    expect(isValidAmountMinor('-500')).toBe(true);
  });

  it('拒绝小数、空白、千分位与非字符串', () => {
    expect(isValidAmountMinor('12.34')).toBe(false);
    expect(isValidAmountMinor(' 100')).toBe(false);
    expect(isValidAmountMinor('100 ')).toBe(false);
    expect(isValidAmountMinor('1,000')).toBe(false);
    expect(isValidAmountMinor('')).toBe(false);
    expect(isValidAmountMinor('-')).toBe(false);
    expect(isValidAmountMinor('abc')).toBe(false);
    expect(isValidAmountMinor('1e5')).toBe(false);
    expect(isValidAmountMinor(100)).toBe(false);
    expect(isValidAmountMinor(null)).toBe(false);
  });
});

describe('parseAmountMinor / formatAmountMinor', () => {
  it('合法字符串与 BigInt 互转', () => {
    expect(parseAmountMinor('12345')).toBe(12345n);
    expect(parseAmountMinor('-500')).toBe(-500n);
    expect(formatAmountMinor(12345n)).toBe('12345');
    // 超出 number 安全整数范围时仍精确
    expect(formatAmountMinor(parseAmountMinor('9007199254740993'))).toBe(
      '9007199254740993',
    );
  });

  it('非法输入抛出 RangeError', () => {
    expect(() => parseAmountMinor('12.34')).toThrow(RangeError);
    expect(() => parseAmountMinor('')).toThrow(RangeError);
    expect(() => parseAmountMinor('abc')).toThrow(RangeError);
  });
});

describe('addAmountMinor / subtractAmountMinor', () => {
  it('加法返回十进制字符串', () => {
    expect(addAmountMinor('100', '250')).toBe('350');
    expect(addAmountMinor('-100', '50')).toBe('-50');
    expect(addAmountMinor('9007199254740993', '1')).toBe('9007199254740994');
  });

  it('减法返回十进制字符串，支持负结果', () => {
    expect(subtractAmountMinor('250', '100')).toBe('150');
    expect(subtractAmountMinor('100', '250')).toBe('-150');
    expect(subtractAmountMinor('0', '0')).toBe('0');
  });

  it('任一操作数非法时抛出 RangeError', () => {
    expect(() => addAmountMinor('1.5', '1')).toThrow(RangeError);
    expect(() => subtractAmountMinor('1', 'x')).toThrow(RangeError);
  });
});
