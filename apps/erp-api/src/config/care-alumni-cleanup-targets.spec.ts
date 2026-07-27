import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseCareAlumniCleanupTargets } from './care-alumni-cleanup-targets.js';

const publicKey = generateKeyPairSync('ed25519').publicKey.export({
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
      },
      target,
    ]))).toMatchObject([
      { targetCode: 'crm' },
      { targetCode: 'notification' },
    ]);
  });

  it.each([
    [{ ...target, endpoint: 'http://privacy.example.net' }],
    [{ ...target, endpoint: 'https://localhost' }],
    [{ ...target, endpoint: 'https://127.0.0.1' }],
    [{ ...target, endpoint: 'https://privacy.example.net/path' }],
    [{ ...target, signingPublicKeyBase64: Buffer.from('wrong').toString('base64') }],
  ])('拒绝不可信网络或签名配置 %#', (value) => {
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify(value))).toThrow();
  });

  it('拒绝目标、Origin、Token 复用和 ERP 授权域', () => {
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify([
      target,
      { ...target, endpoint: 'https://privacy-other.example.net' },
    ]))).toThrow('targetCode');
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify([
      target,
      {
        ...target,
        targetCode: 'notify',
        bearerToken: 'notify-cleanup-token-distinct-at-least-32-characters',
      },
    ]))).toThrow('Origin');
    expect(() => parseCareAlumniCleanupTargets(JSON.stringify([
      target,
      { ...target, targetCode: 'notify', endpoint: 'https://privacy-other.example.net' },
    ]))).toThrow('Token');
    expect(() => parseCareAlumniCleanupTargets(
      JSON.stringify([target]),
      ['https://privacy-crm.example.net'],
    )).toThrow('独立');
  });
});
