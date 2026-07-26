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
    const refreshToken = generateToken();
    const familyId = randomUUID();
    await this.tokens.create(
      [
        {
          tokenHash: hashToken(refreshToken),
          tenantId: input.tenantId,
          actorId: input.actorId,
          sessionId: input.sessionId,
          familyId,
          clientId: input.clientId,
          generation: 0,
          expiresAt: input.expiresAt,
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
    if (!/^rt_[A-Za-z0-9_-]{64}$/.test(presentedToken)) {
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

    const refreshToken = generateToken();
    const replacementHash = hashToken(refreshToken);
    await this.tokens.create(
      [
        {
          tokenHash: replacementHash,
          tenantId: current.tenantId,
          actorId: current.actorId,
          sessionId: current.sessionId,
          familyId: current.familyId,
          clientId: current.clientId,
          generation: current.generation + 1,
          expiresAt: current.expiresAt,
        },
      ],
      { session: mongoSession },
    );
    await this.tokens.updateOne(
      { _id: current._id, tokenHash },
      { $set: { replacedByHash: replacementHash } },
      { session: mongoSession },
    );
    return {
      status: 'rotated',
      refreshToken,
      tenantId: current.tenantId,
      actorId: current.actorId,
      sessionId: current.sessionId,
      clientId: current.clientId,
      expiresAt: current.expiresAt,
    };
  }

  /** 按可信租户与 sessionId 吊销该登录会话的全部刷新令牌。 */
  async revokeBySession(
    tenantId: string,
    sessionId: string,
    mongoSession: ClientSession,
  ): Promise<void> {
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
    const revokedAt = new Date();
    await this.tokens.updateMany(
      { tenantId: existing.tenantId, familyId: existing.familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt } },
      { session: mongoSession },
    );
    await this.sessions.revoke(existing.tenantId, existing.sessionId, mongoSession);
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
