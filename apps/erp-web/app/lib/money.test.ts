import { describe, expect, it } from 'vitest';

import { formatCnyMinor, minorToYuan, yuanToMinor } from './money';

describe('金额字符串工具', () => {
  it('不经浮点数完成元分转换和千分位格式化', () => {
    expect(yuanToMinor('9999999999999.99')).toBe('999999999999999');
    expect(minorToYuan('999999999999999')).toBe('9999999999999.99');
    expect(formatCnyMinor('123456789')).toBe('1,234,567.89');
    expect(yuanToMinor('0')).toBe('0');
  });

  it('拒绝负数、指数、三位小数和超界金额', () => {
    for (const value of ['-1', '1e3', '0.001', '10000000000000']) {
      expect(() => yuanToMinor(value)).toThrow();
    }
  });
});
