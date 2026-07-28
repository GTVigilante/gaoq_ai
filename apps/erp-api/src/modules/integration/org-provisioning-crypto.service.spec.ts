import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { OrgProvisioningCryptoService } from './org-provisioning-crypto.service.js';

const context = {
  tenantId: 'tenant-001',
  requestId: 'request-001',
  employeeId: 'employee-001',
  channel: 'feishu' as const,
};

const build = () => {
  const activeKey = randomBytes(32).toString('base64url');
  const oldKey = randomBytes(32).toString('base64url');
  const resolve = vi.fn().mockResolvedValue(JSON.stringify({
    activeKeyId: 'key-active-001',
    keys: [
      { keyId: 'key-active-001', keyBase64url: activeKey, status: 'active' },
      { keyId: 'key-old-001', keyBase64url: oldKey, status: 'decrypt_only' },
    ],
  }));
  return {
    resolve,
    service: new OrgProvisioningCryptoService({ resolve }),
  };
};

describe('OrgProvisioningCryptoService', () => {
  it('使用 AES-GCM 加密且可以按 AAD 完整解密', async () => {
    const store = build();
    const contact = {
      email: 'Person@Example.COM',
      mobile: { countryCode: '+86', subscriberNumber: '13800138000' },
    };
    const protectedPayload = await store.service.protect(context, contact);
    expect(protectedPayload.payloadCiphertext).not.toContain('Person');
    expect(JSON.stringify(protectedPayload)).not.toContain('13800138000');
    expect(protectedPayload.inputDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(store.service.unprotect({ ...context, ...protectedPayload })).resolves.toEqual({
      email: 'person@example.com',
      mobile: { countryCode: '+86', subscriberNumber: '13800138000' },
    });
  });

  it('密文绑定租户、请求、员工和渠道，任一漂移均失败关闭', async () => {
    const store = build();
    const payload = await store.service.protect(context, { email: 'person@example.com' });
    await expect(store.service.unprotect({
      ...context,
      tenantId: 'tenant-002',
      ...payload,
    })).rejects.toMatchObject({ code: 'ORG_PROVISIONING_PAYLOAD_INVALID' });
  });

  it('幂等摘要使用指定密钥并常量时间比较', async () => {
    const store = build();
    const contact = { email: 'person@example.com' };
    const payload = await store.service.protect(context, contact);
    await expect(store.service.matchesDigest(
      context,
      payload.payloadKeyId,
      payload.inputDigest,
      contact,
    )).resolves.toBe(true);
    await expect(store.service.matchesDigest(
      context,
      payload.payloadKeyId,
      payload.inputDigest,
      { email: 'other@example.com' },
    )).resolves.toBe(false);
  });

  it('拒绝缺失联系方式、非法密钥环和已移除的旧密钥', async () => {
    const store = build();
    await expect(store.service.protect(context, {})).rejects.toMatchObject({
      code: 'ORG_PROVISIONING_CONTACT_INVALID',
    });
    store.resolve.mockResolvedValueOnce(JSON.stringify({ activeKeyId: 'x', keys: [] }));
    await expect(store.service.protect(context, { email: 'person@example.com' }))
      .rejects.toMatchObject({ code: 'ORG_PROVISIONING_KEY_INVALID' });
    const payload = await store.service.protect(context, { email: 'person@example.com' });
    store.resolve.mockResolvedValueOnce(JSON.stringify({
      activeKeyId: 'key-new-001',
      keys: [{
        keyId: 'key-new-001',
        keyBase64url: randomBytes(32).toString('base64url'),
        status: 'active',
      }],
    }));
    await expect(store.service.unprotect({ ...context, ...payload })).rejects.toMatchObject({
      code: 'ORG_PROVISIONING_KEY_UNAVAILABLE',
    });
  });

  it('拒绝国家码与号码合计超过 E.164 15 位上限', async () => {
    const store = build();
    await expect(store.service.protect(context, {
      mobile: { countryCode: '+1234', subscriberNumber: '123456789012' },
    })).rejects.toMatchObject({ code: 'ORG_PROVISIONING_CONTACT_INVALID' });
  });

  it('身份上下文、请求标识和幂等摘要形态均在密钥解析前失败关闭', async () => {
    const store = build();
    for (const invalidContext of [
      { ...context, tenantId: '$bad' },
      { ...context, employeeId: '$bad' },
      { ...context, requestId: '$bad' },
      { ...context, channel: 'op' as const },
    ]) {
      await expect(store.service.protect(invalidContext, { email: 'person@example.com' }))
        .rejects.toMatchObject({ code: 'ORG_PROVISIONING_PAYLOAD_INVALID' });
    }
    await expect(store.service.matchesDigest(
      context,
      '$bad',
      'a'.repeat(43),
      { email: 'person@example.com' },
    )).resolves.toBe(false);
    await expect(store.service.matchesDigest(
      context,
      'key-active-001',
      'invalid',
      { email: 'person@example.com' },
    )).resolves.toBe(false);
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('密文信封严格校验 keyId、Base64URL 和真实 IV/AuthTag 长度', async () => {
    const store = build();
    const payload = await store.service.protect(context, { email: 'person@example.com' });
    for (const override of [
      { payloadKeyId: '$bad' },
      { payloadIv: '$bad' },
      { payloadCiphertext: '$bad' },
      { payloadAuthTag: '$bad' },
      { payloadIv: 'a'.repeat(15) },
      { payloadAuthTag: 'a'.repeat(21) },
    ]) {
      await expect(store.service.unprotect({
        ...context,
        ...payload,
        ...override,
      })).rejects.toMatchObject({ code: 'ORG_PROVISIONING_PAYLOAD_INVALID' });
    }
  });

  it('篡改密文和解密后不符合联系方式 Schema 的明文均失败关闭', async () => {
    const store = build();
    const payload = await store.service.protect(context, { email: 'person@example.com' });
    const last = payload.payloadCiphertext.at(-1) === 'A' ? 'B' : 'A';
    await expect(store.service.unprotect({
      ...context,
      ...payload,
      payloadCiphertext: `${payload.payloadCiphertext.slice(0, -1)}${last}`,
    })).rejects.toMatchObject({ code: 'ORG_PROVISIONING_PAYLOAD_INVALID' });

    const mobileOnly = await store.service.protect(context, {
      mobile: { countryCode: '+86', subscriberNumber: '13800138000' },
    });
    await expect(store.service.unprotect({ ...context, ...mobileOnly })).resolves.toEqual({
      mobile: { countryCode: '+86', subscriberNumber: '13800138000' },
    });
  });

  it('密钥环拒绝非法 JSON、重复 keyId、多 active 和 activeKeyId 漂移', async () => {
    const store = build();
    const key = randomBytes(32).toString('base64url');
    const invalidRings: unknown[] = [
      'not-json',
      JSON.stringify({
        activeKeyId: 'key-001',
        keys: [
          { keyId: 'key-001', keyBase64url: key, status: 'active' },
          { keyId: 'key-001', keyBase64url: key, status: 'decrypt_only' },
        ],
      }),
      JSON.stringify({
        activeKeyId: 'key-001',
        keys: [
          { keyId: 'key-001', keyBase64url: key, status: 'active' },
          { keyId: 'key-002', keyBase64url: key, status: 'active' },
        ],
      }),
      JSON.stringify({
        activeKeyId: 'key-missing',
        keys: [{ keyId: 'key-001', keyBase64url: key, status: 'active' }],
      }),
    ];
    for (const ring of invalidRings) {
      store.resolve.mockResolvedValueOnce(ring);
      await expect(store.service.protect(context, { email: 'person@example.com' }))
        .rejects.toMatchObject({ code: 'ORG_PROVISIONING_KEY_INVALID' });
    }
  });

  it('联系方式对象拒绝未知字段、空白邮箱和非法手机号组成', async () => {
    const store = build();
    for (const contact of [
      { email: 'person@example.com', unexpected: true },
      { email: ' ' },
      { mobile: { countryCode: '+0', subscriberNumber: '13800138000' } },
      { mobile: { countryCode: '+86', subscriberNumber: '0123456' } },
    ]) {
      await expect(store.service.protect(context, contact)).rejects.toMatchObject({
        code: 'ORG_PROVISIONING_CONTACT_INVALID',
      });
    }
  });
});
