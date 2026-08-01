import { createPublicKey } from 'node:crypto';

import { z } from 'zod';

export interface VerifyOnlyRsaJwk {
  readonly kty: 'RSA';
  readonly n: string;
  readonly e: string;
  readonly kid: string;
  readonly alg: 'RS256';
  readonly use: 'sig';
  readonly key_ops?: string[];
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const verifyOnlyRsaJwkSchema = z.object({
  kty: z.literal('RSA'),
  n: z.string().min(1).max(1_024).regex(BASE64URL_PATTERN),
  e: z.string().min(1).max(16).regex(BASE64URL_PATTERN),
  kid: z.string().regex(KEY_ID_PATTERN),
  alg: z.literal('RS256'),
  use: z.literal('sig'),
  key_ops: z.tuple([z.literal('verify')]).optional(),
}).strict();

const verifyOnlyJwksSchema = z.array(verifyOnlyRsaJwkSchema).max(5);

const freezeKey = (key: z.infer<typeof verifyOnlyRsaJwkSchema>): VerifyOnlyRsaJwk => {
  const { key_ops: keyOperations, ...publicKey } = key;
  return Object.freeze({
    ...publicKey,
    ...(keyOperations === undefined
      ? {}
      : { key_ops: Object.freeze(['verify']) as string[] }),
  });
};

/**
 * 解析仅用于旧访问令牌验签的公开 RSA JWK。
 * 配置禁止私钥字段、重复 kid、重复公钥材料及与当前签名 kid 冲突。
 */
export const parseVerifyOnlySigningJwks = (
  raw: string,
  activeKeyId?: string,
): readonly VerifyOnlyRsaJwk[] => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('AUTH_SIGNING_VERIFY_ONLY_JWKS_JSON 不是合法 JSON');
  }
  const parsed = verifyOnlyJwksSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `AUTH_SIGNING_VERIFY_ONLY_JWKS_JSON 配置无效：${z.prettifyError(parsed.error)}`,
    );
  }
  const keyIds = new Set<string>();
  const materials = new Set<string>();
  for (const key of parsed.data) {
    try {
      const publicKey = createPublicKey({
        key: { kty: key.kty, n: key.n, e: key.e },
        format: 'jwk',
      });
      if (
        publicKey.asymmetricKeyType !== 'rsa' ||
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048
      ) throw new Error('RSA_KEY_INVALID');
    } catch {
      throw new Error('AUTH_SIGNING_VERIFY_ONLY_JWKS_JSON 必须包含至少 2048 位的有效 RSA 公钥');
    }
    if (key.kid === activeKeyId || keyIds.has(key.kid)) {
      throw new Error('AUTH_SIGNING_VERIFY_ONLY_JWKS_JSON 的 kid 必须唯一且不得等于活动 kid');
    }
    const material = `${key.n}:${key.e}`;
    if (materials.has(material)) {
      throw new Error('AUTH_SIGNING_VERIFY_ONLY_JWKS_JSON 禁止重复公钥材料');
    }
    keyIds.add(key.kid);
    materials.add(material);
  }
  return Object.freeze(parsed.data.map(freezeKey));
};
