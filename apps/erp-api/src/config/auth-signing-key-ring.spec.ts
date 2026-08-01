import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseVerifyOnlySigningJwks } from './auth-signing-key-ring.js';

const publicJwk = (kid: string, modulusLength = 2_048): Record<string, unknown> => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength });
  return {
    ...publicKey.export({ format: 'jwk' }),
    kid,
    alg: 'RS256',
    use: 'sig',
    key_ops: ['verify'],
  };
};

describe('parseVerifyOnlySigningJwks', () => {
  it('接受至多五个公开 RSA 验签密钥并深冻结结果', () => {
    const parsed = parseVerifyOnlySigningJwks(
      JSON.stringify([publicJwk('signing-key-old-001')]),
      'signing-key-current-001',
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      kty: 'RSA',
      kid: 'signing-key-old-001',
      alg: 'RS256',
      use: 'sig',
      key_ops: ['verify'],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    expect(Object.isFrozen(parsed[0]?.key_ops)).toBe(true);
  });

  it('允许省略可选 key_ops，但始终固定 RSA 签名用途', () => {
    const key = publicJwk('signing-key-old-001');
    delete key['key_ops'];
    const parsed = parseVerifyOnlySigningJwks(JSON.stringify([key]));
    expect(parsed[0]).not.toHaveProperty('key_ops');
    expect(parsed[0]).toMatchObject({ alg: 'RS256', use: 'sig' });
  });

  it.each([
    ['非法 JSON', '{'],
    ['不是数组', '{}'],
    ['含私钥字段', JSON.stringify([{ ...publicJwk('signing-key-old-001'), d: 'secret' }])],
    ['弱 RSA 公钥', JSON.stringify([publicJwk('signing-key-old-001', 1_024)])],
  ])('拒绝%s', (_name, raw) => {
    expect(() => parseVerifyOnlySigningJwks(raw, 'signing-key-current-001')).toThrow(
      'AUTH_SIGNING_VERIFY_ONLY_JWKS_JSON',
    );
  });

  it('拒绝活动 kid、历史重复 kid 和重复公钥材料', () => {
    const key = publicJwk('signing-key-old-001');
    expect(() => parseVerifyOnlySigningJwks(
      JSON.stringify([{ ...key, kid: 'signing-key-current-001' }]),
      'signing-key-current-001',
    )).toThrow('kid 必须唯一');
    expect(() => parseVerifyOnlySigningJwks(
      JSON.stringify([key, key]),
      'signing-key-current-001',
    )).toThrow('kid 必须唯一');
    expect(() => parseVerifyOnlySigningJwks(
      JSON.stringify([key, { ...key, kid: 'signing-key-old-002' }]),
      'signing-key-current-001',
    )).toThrow('重复公钥材料');
  });
});
