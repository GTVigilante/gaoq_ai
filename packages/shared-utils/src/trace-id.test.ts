import { describe, expect, it } from 'vitest';
import {
  createTraceId,
  isValidTraceId,
  resolveTraceId,
  TRACE_ID_PATTERN,
} from './trace-id.js';

describe('isValidTraceId', () => {
  it('接受白名单内的合法值', () => {
    expect(isValidTraceId('abc-123_DEF.456')).toBe(true);
    expect(isValidTraceId('a')).toBe(true);
    expect(isValidTraceId('A'.repeat(64))).toBe(true);
  });

  it('拒绝空串、超长、非法字符与非字符串', () => {
    expect(isValidTraceId('')).toBe(false);
    expect(isValidTraceId('A'.repeat(65))).toBe(false);
    expect(isValidTraceId('has space')).toBe(false);
    expect(isValidTraceId('中文追踪')).toBe(false);
    expect(isValidTraceId('semi;colon')).toBe(false);
    expect(isValidTraceId('emoji🚀')).toBe(false);
    expect(isValidTraceId(null)).toBe(false);
    expect(isValidTraceId(undefined)).toBe(false);
    expect(isValidTraceId(123)).toBe(false);
    expect(isValidTraceId({})).toBe(false);
  });
});

describe('createTraceId', () => {
  it('生成的值满足白名单且互不重复', () => {
    const first = createTraceId();
    const second = createTraceId();
    expect(first).toMatch(TRACE_ID_PATTERN);
    expect(second).toMatch(TRACE_ID_PATTERN);
    expect(first).not.toBe(second);
  });
});

describe('resolveTraceId', () => {
  it('外部值合法时原样透传', () => {
    expect(resolveTraceId('ext-trace_1.0')).toBe('ext-trace_1.0');
  });

  it('外部值缺失或非法时重新生成合法值', () => {
    for (const bad of [undefined, null, '', 'bad trace!', 'A'.repeat(65)]) {
      const resolved = resolveTraceId(bad);
      expect(resolved).toMatch(TRACE_ID_PATTERN);
      expect(resolved).not.toBe(bad);
    }
  });
});
