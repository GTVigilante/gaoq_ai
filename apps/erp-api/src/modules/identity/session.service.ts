import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { IdentitySession, type IdentitySessionDocument } from './session.schema.js';

@Injectable()
export class SessionService {
  constructor(
    @InjectModel(IdentitySession.name)
    private readonly sessions: Model<IdentitySessionDocument>,
  ) {}

  /** 查询租户内会话是否已吊销；不存在的服务令牌会话视为未吊销。 */
  async isRevoked(tenantId: string, sessionId: string): Promise<boolean> {
    const session = await this.sessions
      .findOne({ tenantId, sessionId }, { revokedAt: 1, expiresAt: 1 })
      .lean()
      .exec();
    return session?.revokedAt !== undefined || (session !== null && session.expiresAt <= new Date());
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
