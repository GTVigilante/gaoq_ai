import { createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';

import { z } from 'zod';

const targetSchema = z.object({
  targetCode: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  endpoint: z.string().url().max(2_048),
  bearerToken: z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/),
  policyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  signingKeyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  signingPublicKeyBase64: z.string().min(40).max(512),
  maxAttempts: z.number().int().min(1).max(12),
  proofRetentionDays: z.number().int().min(2_555).max(36_500),
}).strict();

export interface CareAlumniCleanupTarget {
  readonly targetCode: string;
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly policyVersion: string;
  readonly signingKeyId: string;
  readonly signingPublicKeyBase64: string;
  readonly maxAttempts: number;
  readonly proofRetentionDays: number;
}

/** 解析由 Secret Manager 注入的下游清理登记表，并失败关闭网络与信任域。 */
export function parseCareAlumniCleanupTargets(
  raw: string,
  forbiddenOrigins: readonly string[] = [],
): readonly CareAlumniCleanupTarget[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error('下游清理登记表不是合法 JSON', { cause: error });
  }
  const parsed = z.array(targetSchema).max(32).safeParse(decoded);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  const targetCodes = new Set<string>();
  const origins = new Set<string>();
  const tokens = new Set<string>();
  const signingKeyIds = new Set<string>();
  const signingPublicKeys = new Set<string>();
  const forbidden = new Set(forbiddenOrigins.map((value) => {
    const url = new URL(value);
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) throw new Error('禁止复用的 Origin 必须为标准根地址');
    return url.origin;
  }));
  const targets = parsed.data.map((target) => {
    const url = new URL(target.endpoint);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
      .replace(/^\[(.*)\]$/u, '$1');
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.port !== '' && url.port !== '443') ||
      url.hostname !== hostname ||
      !hostname.includes('.') ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      isIP(hostname) !== 0 ||
      forbidden.has(url.origin)
    ) throw new Error(`下游 ${target.targetCode} 必须使用独立标准 HTTPS 域名根地址`);
    if (targetCodes.has(target.targetCode)) {
      throw new Error(`下游清理 targetCode 重复：${target.targetCode}`);
    }
    if (origins.has(url.origin)) {
      throw new Error(`下游清理 Origin 重复：${url.origin}`);
    }
    if (tokens.has(target.bearerToken)) {
      throw new Error('下游清理 Bearer Token 禁止跨目标复用');
    }
    if (signingKeyIds.has(target.signingKeyId)) {
      throw new Error('下游清理 signingKeyId 禁止跨目标复用');
    }
    if (signingPublicKeys.has(target.signingPublicKeyBase64)) {
      throw new Error('下游清理 Ed25519 公钥禁止跨目标复用');
    }
    try {
      const decodedKey = Buffer.from(target.signingPublicKeyBase64, 'base64');
      if (decodedKey.toString('base64') !== target.signingPublicKeyBase64) {
        throw new Error('KEY_ENCODING_INVALID');
      }
      const key = createPublicKey({ key: decodedKey, format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('KEY_TYPE_INVALID');
    } catch (error: unknown) {
      throw new Error(`下游 ${target.targetCode} 签名公钥必须为 Ed25519 SPKI DER base64`, {
        cause: error,
      });
    }
    targetCodes.add(target.targetCode);
    origins.add(url.origin);
    tokens.add(target.bearerToken);
    signingKeyIds.add(target.signingKeyId);
    signingPublicKeys.add(target.signingPublicKeyBase64);
    return Object.freeze({ ...target, endpoint: url.origin });
  });
  return Object.freeze([...targets].sort((left, right) =>
    left.targetCode.localeCompare(right.targetCode)));
}
