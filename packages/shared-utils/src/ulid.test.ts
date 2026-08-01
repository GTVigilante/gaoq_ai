import { describe, expect, it } from 'vitest';

import { createEventId, isValidEventId, ULID_PATTERN } from './ulid.js';

describe('ULID 事件标识', () => {
  it('生成符合 Crockford Base32 的 26 位标识', () => {
    const id = createEventId(new Date('2026-07-21T00:00:00.000Z'));

    expect(id).toMatch(ULID_PATTERN);
    expect(isValidEventId(id)).toBe(true);
  });

  it('同一毫秒仍由 80 位随机数产生不同标识', () => {
    const now = new Date('2026-07-21T00:00:00.000Z');
    expect(createEventId(now)).not.toBe(createEventId(now));
  });

  it('时间前缀保持字典序', () => {
    const first = createEventId(new Date('2026-07-21T00:00:00.000Z'));
    const second = createEventId(new Date('2026-07-21T00:00:00.001Z'));
    expect(first.slice(0, 10) < second.slice(0, 10)).toBe(true);
  });

  it('拒绝非规范字符和长度', () => {
    expect(isValidEventId('not-a-ulid')).toBe(false);
    expect(isValidEventId('8'.repeat(26))).toBe(false);
  });
});
