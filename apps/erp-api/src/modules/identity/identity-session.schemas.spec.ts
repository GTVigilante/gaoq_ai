import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  IdentityRefreshTokenSchema,
  type IdentityRefreshToken,
} from './refresh-token.schema.js';
import {
  IdentitySessionSchema,
  type IdentitySession,
} from './session.schema.js';

const mongoose = new Mongoose();
const RefreshToken = mongoose.model<IdentityRefreshToken>(
  'SpecIdentityRefreshToken',
  IdentityRefreshTokenSchema,
);
const Session = mongoose.model<IdentitySession>('SpecIdentitySession', IdentitySessionSchema);

const validRefreshToken = () => ({
  tokenHash: 'A'.repeat(43),
  tenantId: 'tenant-001',
  actorId: 'actor-001',
  sessionId: 'session-001',
  familyId: '0192f81f-18aa-4e7b-8d2e-b3795f476603',
  clientId: 'gaoq-web',
  generation: 0,
  expiresAt: new Date(Date.now() + 60_000),
});

describe('身份会话持久化 Schema', () => {
  it('接受规范会话和刷新令牌，并保留租户内唯一会话与 family 代次索引', async () => {
    await expect(new Session({
      tenantId: 'tenant-001',
      actorId: 'actor-001',
      sessionId: 'session-001',
      expiresAt: new Date(Date.now() + 60_000),
    }).validate()).resolves.toBeUndefined();
    await expect(new RefreshToken(validRefreshToken()).validate()).resolves.toBeUndefined();
    expect(IdentitySessionSchema.indexes()).toContainEqual([
      { tenantId: 1, sessionId: 1 },
      { unique: true },
    ]);
    expect(IdentityRefreshTokenSchema.indexes()).toContainEqual([
      { tenantId: 1, familyId: 1, generation: 1 },
      { unique: true },
    ]);
  });

  it.each([
    ['令牌摘要', { tokenHash: 'not-a-hash' }],
    ['操作符租户', { tenantId: '$where' }],
    ['family UUID', { familyId: 'family-001' }],
    ['非整数代次', { generation: 1.5 }],
    ['后继摘要', { replacedByHash: 'plaintext-token' }],
  ])('刷新令牌拒绝非法%s', async (_name, override) => {
    await expect(new RefreshToken({
      ...validRefreshToken(),
      ...override,
    }).validate()).rejects.toThrow();
  });

  it('会话拒绝非法租户、主体和会话标识', async () => {
    await expect(new Session({
      tenantId: 'tenant-001',
      actorId: 'bad actor',
      sessionId: 'session-001',
      expiresAt: new Date(Date.now() + 60_000),
    }).validate()).rejects.toThrow();
  });
});
