import { randomBytes } from 'node:crypto';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const encodeBase32 = (value: bigint, length: number): string => {
  let remaining = value;
  let encoded = '';
  for (let index = 0; index < length; index += 1) {
    encoded = (CROCKFORD_BASE32[Number(remaining & 31n)] ?? '') + encoded;
    remaining >>= 5n;
  }
  return encoded;
};

/** 生成 26 位 ULID：48 位毫秒时间戳 + 80 位密码学随机数。 */
export const createEventId = (now: Date = new Date()): string => {
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 281_474_976_710_655) {
    throw new RangeError('ULID 时间戳超出 48 位范围');
  }
  const random = randomBytes(10).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  return `${encodeBase32(BigInt(timestamp), 10)}${encodeBase32(random, 16)}`;
};

export const isValidEventId = (value: unknown): value is string =>
  typeof value === 'string' && ULID_PATTERN.test(value);
