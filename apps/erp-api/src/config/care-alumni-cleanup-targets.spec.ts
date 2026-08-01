import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseCareAlumniCleanupTargets } from './care-alumni-cleanup-targets.js';

const publicKey = generateKeyPairSync('ed25519').publicKey.export({
  format: 'der',
  type: 'spki',
}).toString('base64');
const notificationPublicKey = generateKeyPairSync('ed25519').publicKey.export({
  format: 'der',
  type: 'spki',
}).toString('base64');
const rsaPublicKey = generateKeyPairSync('rsa', {
  modulusLength: 2_048,
}).publicKey.export({
  format: 'der',
  type: 'spki',
}).toString('base64');

const target = {
  targetCode: 'crm',
  endpoint: 'https://privacy-crm.example.net',
  bearerToken: 'crm-cleanup-token-distinct-at-least-32-characters',
  policyVersion: 'privacy-v1',
  signingKeyId: 'crm-proof-key-v1',
  signingPublicKeyBase64: publicKey,
  maxAttempts: 6,
  proofRetentionDays: 2_555,
};

describe('parseCareAlumniCleanupTargets', () => {
  it('接受排序后的独立下游登记表', () => {
    expect(parseCareAlumniCleanupTargets(JSON.stringify([
      {
        ...target,
        targetCode: 'notification',
        endpoint: 'https://privacy-notify.example.net',
        bearerToken: 'notify-cleanup-token-distinct-at-least-32-characters',
        signingKeyId: 'notify-proof-key-v1',
        signingPublicKeyBase64: notificationPublicKey,
      },
      target,
    ]))).toMatchObject([
      { targetCode: 'crm' },
      { targetCode: 'notification' },
    ]);
    const parsed = parseCareAlumniCleanupTargets(JSON.stringify([target]));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
  });

  it.each([
    [{ ...target, endpoint: 'http://privacy.example.net' }],
    [{ ...target, endpoint: 'https://localhost' }],
    [{ ...target, endpoint: 'https://service.localhost' }],
    [{ ...target, endpoint: 'https://127.0.0.1' }],
    [{ ...target, endpoint: 'https://privacy.example.net.' }],
    [{ ...target, endpoint: 'https://intranet' }],
    [{ ...target, endpoint: 'https://user:pass@privacy.example.net' }],
    [{ ...target, endpoint: 'https://privacy.example.net/path' }],
    [{ ...target, endpoint: 'https://privacy.example.net?x=1' }],
    [{ ...target, endpoint: 'https://privacy.example.net#fragment' }],
    [{ ...target, endpoint: 'https://privacy.example.net:8443' }],
    [{ ...target, signingPublicKeyBase64: Buffer.from('wrong').toString('base64') }],
    [{ ...target, signingPublicKeyBase64: `${publicKey}\n` }],
    [{ ...target, signingPublicKeyBase64: rsaPublicKey }],
    [{ ...target, bearerToken: 'x'.repeat(31) + '\n' }],
  ])('拒绝不可信网络或签名配置 %#', (value) => {
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify(value))).toThrow();
  });

  it('拒绝目标、Origin、Token、Key ID、公钥复用和 ERP 授权域', () => {
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify([
      target,
      {
        ...target,
        endpoint: 'https://privacy-other.example.net',
        signingKeyId: 'other-key-v1',
        signingPublicKeyBase64: notificationPublicKey,
      },
    ]))).toThrow('targetCode');
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify([
      target,
      {
        ...target,
        targetCode: 'notify',
        bearerToken: 'notify-cleanup-token-distinct-at-least-32-characters',
        signingKeyId: 'notify-key-v1',
        signingPublicKeyBase64: notificationPublicKey,
      },
    ]))).toThrow('Origin');
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify([
      target,
      {
        ...target,
        targetCode: 'notify',
        endpoint: 'https://privacy-other.example.net',
        signingKeyId: 'notify-key-v1',
        signingPublicKeyBase64: notificationPublicKey,
      },
    ]))).toThrow('Token');
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify([
      target,
      {
        ...target,
        targetCode: 'notify',
        endpoint: 'https://privacy-other.example.net',
        bearerToken: 'notify-cleanup-token-distinct-at-least-32-characters',
        signingPublicKeyBase64: notificationPublicKey,
      },
    ]))).toThrow('signingKeyId');
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify([
      target,
      {
        ...target,
        targetCode: 'notify',
        endpoint: 'https://privacy-other.example.net',
        bearerToken: 'notify-cleanup-token-distinct-at-least-32-characters',
        signingKeyId: 'notify-key-v1',
      },
    ]))).toThrow('公钥');
    expect(() => parseCareAlumniCleanupTargets(
      JSON.stringify([target]),
      ['https://privacy-crm.example.net'],
    )).toThrow('独立');
  });

  it('拒绝非法 JSON、超量目标、未知字段与非法禁止 Origin', () => {
    expect(() => parseCareAlumniCleanupTargets('{')).toThrow('合法 JSON');
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify(
      Array.from({ length: 33 }, (_, index) => ({
        ...target,
        targetCode: `target-${index}`,
      })),
    ))).toThrow();
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify([{
      ...target,
      unexpected: true,
    }]))).toThrow();
    expect(() => parseCareAlumniCleanupTargets(
      JSON.stringify([target]),
      ['https://privacy-crm.example.net/path'],
    )).toThrow('标准根地址');
  });

  it('接受空登记表', () => {
    expect(parseCareAlumniCleanupTargets('[]')).toEqual([]);
  });
});
