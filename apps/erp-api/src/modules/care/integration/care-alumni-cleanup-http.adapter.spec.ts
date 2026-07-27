import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAlumniCleanupTask } from '../domain/index.js';
import { CareAlumniCleanupHttpAdapter } from './care-alumni-cleanup-http.adapter.js';
import type { CareAlumniCleanupTargetRegistry } from './care-alumni-cleanup-target-registry.js';

const keyPair = generateKeyPairSync('ed25519');
const target = {
  targetCode: 'crm',
  endpoint: 'https://privacy-crm.example.net',
  bearerToken: 'cleanup-token-distinct-at-least-32-characters',
  policyVersion: 'privacy-v1',
  signingKeyId: 'proof-key-v1',
  signingPublicKeyBase64: keyPair.publicKey.export({
    format: 'der',
    type: 'spki',
  }).toString('base64'),
  maxAttempts: 3,
  proofRetentionDays: 2_555,
};
const task = createAlumniCleanupTask({
  sourceEventId: '01J8ZQK7V0A2M4N6P8R0T2W4C6',
  tenantId: 'tenant-001',
  consentId: '01J8ZQK7V0A2M4N6P8R0T2W4C4',
  consentVersion: 2,
  consentPurpose: 'alumni_network',
  terminationReason: 'withdrawn',
  terminatedAt: '2026-07-27T00:00:00.000Z',
  target,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CareAlumniCleanupHttpAdapter', () => {
  it('发送最小控制面并接受绑定上下文的不可变签名证明', async () => {
    let sentBody = '';
    vi.stubGlobal('fetch', vi.fn((url: URL, init: RequestInit) => {
      expect(url.toString()).toBe(
        'https://privacy-crm.example.net/v1/alumni-consent-cleanups/execute',
      );
      if (typeof init.body !== 'string') throw new Error('TEST_BODY_INVALID');
      sentBody = init.body;
      const body = JSON.parse(sentBody) as { controlDigest: string };
      const bytes = Buffer.from(JSON.stringify({
        tenantId: task.tenantId,
        consentId: task.consentId,
        consentVersion: task.consentVersion,
        consentPurpose: task.consentPurpose,
        targetCode: task.targetCode,
        policyVersion: task.policyVersion,
        controlDigest: body.controlDigest,
        proofDigest: 'A'.repeat(43),
        action: 'anonymized',
        processingBlocked: true,
        retainedEvidenceClasses: ['consent_attestation', 'audit_log'],
        storage: 'immutable_worm',
        proofReference: 'worm:proof-001',
        completedAt: '2026-07-27T00:01:00.000Z',
        retentionUntil: '2033-07-27T00:01:00.000Z',
        keyId: target.signingKeyId,
      }), 'utf8');
      const digest = createHash('sha256').update(bytes).digest('base64url');
      const signature = sign(
        null,
        Buffer.from(
          `gaoq-care-alumni-cleanup-proof-v1\n${target.signingKeyId}\n${digest}`,
          'utf8',
        ),
        keyPair.privateKey,
      ).toString('base64url');
      return Promise.resolve(new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-gaoq-signing-key-id': target.signingKeyId,
          'x-gaoq-signature': signature,
        },
      }));
    }));
    const adapter = new CareAlumniCleanupHttpAdapter({
      require: vi.fn().mockReturnValue(target),
    } as unknown as CareAlumniCleanupTargetRegistry);
    await expect(adapter.execute(task)).resolves.toMatchObject({
      proofDigest: 'A'.repeat(43),
      action: 'anonymized',
      storage: 'immutable_worm',
    });
    expect(sentBody).not.toMatch(
      /personId|consentEvidenceId|phone|emailAddress|proofObject|authorization/iu,
    );
  });

  it('拒绝可变存储、错位摘要与无效签名证明', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tenantId: task.tenantId,
      consentId: task.consentId,
      consentVersion: task.consentVersion,
      consentPurpose: task.consentPurpose,
      targetCode: task.targetCode,
      policyVersion: task.policyVersion,
      controlDigest: 'B'.repeat(43),
      proofDigest: 'A'.repeat(43),
      action: 'deleted',
      processingBlocked: true,
      retainedEvidenceClasses: ['consent_attestation', 'audit_log'],
      storage: 'mutable_object_store',
      proofReference: 'mutable:proof-001',
      completedAt: '2026-07-27T00:01:00.000Z',
      retentionUntil: '2033-07-27T00:01:00.000Z',
      keyId: target.signingKeyId,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-gaoq-signing-key-id': target.signingKeyId,
        'x-gaoq-signature': 'A'.repeat(86),
      },
    })));
    const adapter = new CareAlumniCleanupHttpAdapter({
      require: vi.fn().mockReturnValue(target),
    } as unknown as CareAlumniCleanupTargetRegistry);
    await expect(adapter.execute(task)).rejects.toThrow();
  });

  it('在流式读取期间拒绝超出 16 KiB 的证明响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      Buffer.alloc(16_385, 65),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-gaoq-signing-key-id': target.signingKeyId,
          'x-gaoq-signature': 'A'.repeat(86),
        },
      },
    )));
    const adapter = new CareAlumniCleanupHttpAdapter({
      require: vi.fn().mockReturnValue(target),
    } as unknown as CareAlumniCleanupTargetRegistry);
    await expect(adapter.execute(task)).rejects.toThrow(
      'CARE_ALUMNI_CLEANUP_PROOF_TOO_LARGE',
    );
  });
});
