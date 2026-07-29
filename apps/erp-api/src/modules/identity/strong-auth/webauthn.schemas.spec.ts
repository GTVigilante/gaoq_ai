import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  WebAuthnCeremonyRecordSchema,
  WebAuthnCredentialRecordSchema,
  type WebAuthnCeremonyRecord,
} from './webauthn.schemas.js';

const mongoose = new Mongoose();
const CeremonyModel = mongoose.model<WebAuthnCeremonyRecord>(
  'SpecWebAuthnCeremony',
  WebAuthnCeremonyRecordSchema,
);

function ceremony(): Record<string, unknown> {
  return {
    ceremonyId: '01J8ZQK7V0A2M4N6P8R0T2W4Y6',
    tenantId: 'tenant-001',
    actorId: 'actor-001',
    sessionId: 'session-001',
    type: 'authentication',
    challenge: 'a'.repeat(43),
    operationId: '01J8ZQK7V0A2M4N6P8R0T2W4Y7',
    status: 'pending',
    credentialId: null,
    verifiedAt: null,
    expiresAt: new Date('2026-07-21T00:10:00.000Z'),
  };
}

describe('WebAuthnSchemas', () => {
  it('凭据仅保存公钥与计数器，不定义私钥、口令或令牌字段', () => {
    expect(WebAuthnCredentialRecordSchema.path('publicKey')).toBeDefined();
    expect(WebAuthnCredentialRecordSchema.path('counter')).toBeDefined();
    expect(WebAuthnCredentialRecordSchema.path('privateKey')).toBeUndefined();
    expect(WebAuthnCredentialRecordSchema.path('password')).toBeUndefined();
    expect(WebAuthnCredentialRecordSchema.path('accessToken')).toBeUndefined();
  });

  it('认证仪式必须绑定操作，注册仪式禁止绑定操作', async () => {
    await expect(new CeremonyModel({ ...ceremony(), operationId: null }).validate())
      .rejects.toThrow('强认证仪式必须绑定业务操作');
    await expect(new CeremonyModel({
      ...ceremony(), type: 'registration', operationId: ceremony().operationId,
    }).validate()).rejects.toThrow('注册仪式不能绑定业务操作');
  });

  it('已验证仪式必须保留凭据标识和验证时间', async () => {
    await expect(new CeremonyModel({ ...ceremony(), status: 'verified' }).validate())
      .rejects.toThrow('已验证仪式必须记录凭据与时间');
    await expect(new CeremonyModel({
      ...ceremony(), status: 'verified', credentialId: 'credential-001',
      verifiedAt: new Date('2026-07-21T00:01:00.000Z'),
    }).validate()).resolves.toBeUndefined();
    await expect(new CeremonyModel({
      ...ceremony(), type: 'registration', operationId: null,
    }).validate()).resolves.toBeUndefined();
  });

  it('凭据和仪式都有唯一标识及过期清理索引', () => {
    const credentialUnique = WebAuthnCredentialRecordSchema.indexes()
      .find(([spec]) => spec.credentialId === 1);
    const ceremonyUnique = WebAuthnCeremonyRecordSchema.indexes()
      .find(([spec]) => spec.ceremonyId === 1);
    const expiry = WebAuthnCeremonyRecordSchema.indexes()
      .find(([spec]) => spec.expiresAt === 1);
    expect(credentialUnique?.[1]?.unique).toBe(true);
    expect(ceremonyUnique?.[1]?.unique).toBe(true);
    expect(expiry?.[1]?.expireAfterSeconds).toBe(86_400);
  });
});
