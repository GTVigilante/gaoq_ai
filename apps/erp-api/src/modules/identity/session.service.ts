import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';

import { IdentitySession, type IdentitySessionDocument } from './session.schema.js';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const isValidId = (value: unknown): value is string =>
  typeof value === 'string' && ID_PATTERN.test(value);

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

export interface OpenIdentitySessionInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly expiresAt: Date;
}

@Injectable()
export class SessionService {
  constructor(
    @InjectModel(IdentitySession.name)
    private readonly sessions: Model<IdentitySessionDocument>,
  ) {}

  /**
   * 检查租户内会话是否可用。人员令牌必须存在本地会话，服务令牌可由外部授权服务器独立管理。
   */
  async isActive(
    tenantId: string,
    sessionId: string,
    requireExisting: boolean,
    mongoSession?: ClientSession,
  ): Promise<boolean> {
    if (!isValidId(tenantId) || !isValidId(sessionId)) return false;
    const query = this.sessions.findOne(
      { tenantId, sessionId },
      { revokedAt: 1, expiresAt: 1 },
    );
    if (mongoSession !== undefined) {
      query.session(mongoSession);
    }
    const session = await query.lean().exec();
    if (session === null) {
      return !requireExisting;
    }
    if (
      !isValidDate(session.expiresAt) ||
      (session.revokedAt !== undefined && !isValidDate(session.revokedAt))
    ) return false;
    return session.revokedAt === undefined && session.expiresAt > new Date();
  }

  /** 创建新的人员会话；sessionId 必须由授权设施生成且不可复用。 */
  async open(input: OpenIdentitySessionInput, mongoSession?: ClientSession): Promise<void> {
    if (
      !isValidId(input.tenantId) ||
      !isValidId(input.sessionId) ||
      !isValidId(input.actorId) ||
      !isValidDate(input.expiresAt) ||
      input.expiresAt <= new Date()
    ) throw new Error('会话创建参数非法');
    await this.sessions.create(
      [{
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        expiresAt: input.expiresAt,
      }],
      mongoSession === undefined ? {} : { session: mongoSession },
    );
  }

  /** 吊销指定租户的会话，不允许跨租户更新。 */
  async revoke(
    tenantId: string,
    sessionId: string,
    mongoSession?: ClientSession,
  ): Promise<boolean> {
    if (!isValidId(tenantId) || !isValidId(sessionId)) return false;
    const result = await this.sessions.updateOne(
      { tenantId, sessionId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
      mongoSession === undefined ? {} : { session: mongoSession },
    );
    return result.modifiedCount === 1;
  }

  /** 离职编排在既有事务内吊销租户中一组主体的全部活动会话。 */
  async revokeAllByActors(
    tenantId: string,
    actorIds: readonly string[],
    mongoSession: ClientSession,
  ): Promise<number> {
    const normalized = this.normalizeActors(tenantId, actorIds);
    const result = await this.sessions.updateMany(
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

  private normalizeActors(tenantId: string, actorIds: readonly string[]): readonly string[] {
    const untrustedActors: unknown = actorIds;
    if (!ID_PATTERN.test(tenantId) || !Array.isArray(untrustedActors)) {
      throw new Error('批量会话吊销参数非法');
    }
    const normalized: string[] = [];
    if (untrustedActors.length < 1 || untrustedActors.length > 100) {
      throw new Error('批量会话吊销参数非法');
    }
    for (const actorId of untrustedActors as readonly unknown[]) {
      if (typeof actorId !== 'string' || !ID_PATTERN.test(actorId)) {
        throw new Error('批量会话吊销参数非法');
      }
      normalized.push(actorId);
    }
    return [...new Set(normalized)];
  }
}
