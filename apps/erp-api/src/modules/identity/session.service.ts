import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { IdentitySession, type IdentitySessionDocument } from './session.schema.js';

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
  async isActive(tenantId: string, sessionId: string, requireExisting: boolean): Promise<boolean> {
    const session = await this.sessions
      .findOne({ tenantId, sessionId }, { revokedAt: 1, expiresAt: 1 })
      .lean()
      .exec();
    if (session === null) {
      return !requireExisting;
    }
    return session.revokedAt === undefined && session.expiresAt > new Date();
  }

  /** 创建新的人员会话；sessionId 必须由授权设施生成且不可复用。 */
  async open(input: OpenIdentitySessionInput): Promise<void> {
    await this.sessions.create({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      actorId: input.actorId,
      expiresAt: input.expiresAt,
    });
  }

  /** 吊销指定租户的会话，不允许跨租户更新。 */
  async revoke(tenantId: string, sessionId: string): Promise<boolean> {
    const result = await this.sessions.updateOne(
      { tenantId, sessionId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }
}
