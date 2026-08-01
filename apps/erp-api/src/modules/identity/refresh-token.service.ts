import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import {
  IdentityRefreshToken,
  type IdentityRefreshTokenDocument,
} from './refresh-token.schema.js';
import { SessionService } from './session.service.js';

export interface InitialRefreshTokenInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly clientId: string;
  readonly expiresAt: Date;
}

export interface RotatedRefreshToken {
  readonly status: 'rotated';
  readonly refreshToken: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly clientId: string;
  readonly expiresAt: Date;
}

export type RefreshRotationResult =
  | RotatedRefreshToken
  | { readonly status: 'invalid' | 'replay' };

const hashToken = (token: string): string => createHash('sha256').update(token).digest('base64url');
const generateToken = (): string => `rt_${randomBytes(48).toString('base64url')}`;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REFRESH_TOKEN_PATTERN = /^rt_[A-Za-z0-9_-]{64}$/;
const FAMILY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_REFRESH_GENERATION = 1_000_000;

const requireId = (value: unknown): string => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error('刷新令牌持久化状态非法');
  }
  return value;
};

const requireFutureDate = (value: unknown, now: Date): Date => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value <= now) {
    throw new Error('刷新令牌持久化状态非法');
  }
  return value;
};

const requireFamilyId = (value: unknown): string => {
  if (typeof value !== 'string' || !FAMILY_ID_PATTERN.test(value)) {
    throw new Error('刷新令牌持久化状态非法');
  }
  return value;
};

const requireGeneration = (value: unknown): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_REFRESH_GENERATION
  ) {
    throw new Error('刷新令牌持久化状态非法');
  }
  return value;
};

@Injectable()
export class RefreshTokenService {
  constructor(
    @InjectModel(IdentityRefreshToken.name)
    private readonly tokens: Model<IdentityRefreshTokenDocument>,
    private readonly sessions: SessionService,
  ) {}

  /** 创建首个高熵刷新令牌；数据库只保存 SHA-256 摘要。 */
  async issueInitial(
    input: InitialRefreshTokenInput,
    mongoSession: ClientSession,
  ): Promise<{ readonly refreshToken: string; readonly familyId: string }> {
    const now = new Date();
    const tenantId = requireId(input.tenantId);
    const actorId = requireId(input.actorId);
    const sessionId = requireId(input.sessionId);
    const clientId = requireId(input.clientId);
    const expiresAt = requireFutureDate(input.expiresAt, now);
    const refreshToken = generateToken();
    const familyId = randomUUID();
    await this.tokens.create(
      [
        {
          tokenHash: hashToken(refreshToken),
          tenantId,
          actorId,
          sessionId,
          familyId,
          clientId,
          generation: 0,
          expiresAt,
        },
      ],
      { session: mongoSession },
    );
    return { refreshToken, familyId };
  }

  /**
   * 原子消费并轮换刷新令牌；已消费令牌再次出现时吊销整个 family 与人员会话。
   */
  async rotate(
    presentedToken: string,
    expectedClientId: string,
    mongoSession: ClientSession,
  ): Promise<RefreshRotationResult> {
    if (!REFRESH_TOKEN_PATTERN.test(presentedToken) || !ID_PATTERN.test(expectedClientId)) {
      return { status: 'invalid' };
    }
    const tokenHash = hashToken(presentedToken);
    const consumedAt = new Date();
    const current = await this.tokens.findOneAndUpdate(
      {
        tokenHash,
        clientId: expectedClientId,
        consumedAt: { $exists: false },
        revokedAt: { $exists: false },
        expiresAt: { $gt: consumedAt },
      },
      { $set: { consumedAt } },
      { returnDocument: 'after', session: mongoSession },
    );
    if (current === null) {
      return this.handleInvalidOrReplay(tokenHash, mongoSession);
    }

    const tenantId = requireId(current.tenantId);
    const actorId = requireId(current.actorId);
    const sessionId = requireId(current.sessionId);
    const familyId = requireFamilyId(current.familyId);
    const clientId = requireId(current.clientId);
    const expiresAt = requireFutureDate(current.expiresAt, consumedAt);
    const generation = requireGeneration(current.generation);
    if (clientId !== expectedClientId || generation === MAX_REFRESH_GENERATION) {
      throw new Error('刷新令牌持久化状态非法');
    }
    const refreshToken = generateToken();
    const replacementHash = hashToken(refreshToken);
    await this.tokens.create(
      [
        {
          tokenHash: replacementHash,
          tenantId,
          actorId,
          sessionId,
          familyId,
          clientId,
          generation: generation + 1,
          expiresAt,
        },
      ],
      { session: mongoSession },
    );
    const linked = await this.tokens.updateOne(
      {
        _id: current._id,
        tokenHash,
        consumedAt,
        replacedByHash: { $exists: false },
      },
      { $set: { replacedByHash: replacementHash } },
      { session: mongoSession },
    );
    if (linked.matchedCount !== 1 || linked.modifiedCount !== 1) {
      throw new Error('刷新令牌轮换链写入冲突');
    }
    return {
      status: 'rotated',
      refreshToken,
      tenantId,
      actorId,
      sessionId,
      clientId,
      expiresAt,
    };
  }

  /** 按可信租户与 sessionId 吊销该登录会话的全部刷新令牌。 */
  async revokeBySession(
    tenantId: string,
    sessionId: string,
    mongoSession: ClientSession,
  ): Promise<void> {
    requireId(tenantId);
    requireId(sessionId);
    await this.tokens.updateMany(
      { tenantId, sessionId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
      { session: mongoSession },
    );
  }

  /** 离职编排在既有事务内吊销租户中一组主体的全部活动刷新令牌。 */
  async revokeAllByActors(
    tenantId: string,
    actorIds: readonly string[],
    mongoSession: ClientSession,
  ): Promise<number> {
    const normalized = this.normalizeActors(tenantId, actorIds);
    const result = await this.tokens.updateMany(
      {
        tenantId,
        actorId: { $in: normalized },
        revokedAt: { $exists: false },
      },
      { $set: { revokedAt: new Date() } },
      { session: mongoSession },
    );
    return result.modifiedCount;
  }

  private async handleInvalidOrReplay(
    tokenHash: string,
    mongoSession: ClientSession,
  ): Promise<RefreshRotationResult> {
    const existing = await this.tokens.findOne({ tokenHash }).session(mongoSession).lean().exec();
    if (existing === null) {
      return { status: 'invalid' };
    }
    const tenantId = requireId(existing.tenantId);
    requireId(existing.actorId);
    const sessionId = requireId(existing.sessionId);
    const familyId = requireFamilyId(existing.familyId);
    requireId(existing.clientId);
    requireFutureDate(existing.expiresAt, new Date(0));
    requireGeneration(existing.generation);
    const revokedAt = new Date();
    await this.tokens.updateMany(
      { tenantId, familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt } },
      { session: mongoSession },
    );
    await this.sessions.revoke(tenantId, sessionId, mongoSession);
    return { status: 'replay' };
  }

  private normalizeActors(tenantId: string, actorIds: readonly string[]): readonly string[] {
    const untrustedActors: unknown = actorIds;
    if (!ID_PATTERN.test(tenantId) || !Array.isArray(untrustedActors)) {
      throw new Error('批量刷新令牌吊销参数非法');
    }
    const normalized: string[] = [];
    if (untrustedActors.length < 1 || untrustedActors.length > 100) {
      throw new Error('批量刷新令牌吊销参数非法');
    }
    for (const actorId of untrustedActors as readonly unknown[]) {
      if (typeof actorId !== 'string' || !ID_PATTERN.test(actorId)) {
        throw new Error('批量刷新令牌吊销参数非法');
      }
      normalized.push(actorId);
    }
    return [...new Set(normalized)];
  }
}
