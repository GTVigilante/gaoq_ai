import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { OrgDeliveryChannel } from './org-delivery.schemas.js';
import { OrgPlatformCredentialService } from './org-platform-credential.service.js';
import { OrgPlatformHttpClient } from './org-platform-http.client.js';
import { OrgPushError } from './org-push.adapter.js';

type OAuthOrgDeliveryChannel = Exclude<OrgDeliveryChannel, 'op'>;

const dingtalkTokenSchema = z.object({
  accessToken: z.string().min(1),
  expireIn: z.number().int().positive(),
}).passthrough();

const feishuTokenSchema = z.object({
  code: z.number().int(),
  tenant_access_token: z.string().min(1).optional(),
  expire: z.number().int().positive().optional(),
}).passthrough();

interface CachedAccessToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly externalTenantId: string;
  readonly clientId: string;
}

export interface OrgPlatformAccess {
  readonly accessToken: string;
  readonly externalTenantId: string;
  /** 非密钥的应用标识；钉钉机器人发信协议需要作为 robotCode。 */
  readonly clientId: string;
}

/**
 * 组织平台应用令牌服务。令牌只驻留进程内存并提前 60 秒失效，绝不写入数据库/Outbox/日志。
 * 同一实例按租户+渠道合并并发刷新；多 Worker 最多各自刷新一次。
 */
@Injectable()
export class OrgPlatformTokenService {
  private readonly cache = new Map<string, CachedAccessToken>();
  private readonly refreshing = new Map<string, Promise<CachedAccessToken>>();

  constructor(
    private readonly credentials: OrgPlatformCredentialService,
    private readonly http: OrgPlatformHttpClient,
  ) {}

  async getAccess(tenantId: string, channel: OAuthOrgDeliveryChannel): Promise<OrgPlatformAccess> {
    const key = `${tenantId}:${channel}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return this.toAccess(cached);
    }
    let pending = this.refreshing.get(key);
    if (pending === undefined) {
      pending = this.refresh(tenantId, channel);
      this.refreshing.set(key, pending);
    }
    try {
      const token = await pending;
      this.cache.set(key, token);
      return this.toAccess(token);
    } finally {
      if (this.refreshing.get(key) === pending) this.refreshing.delete(key);
    }
  }

  /** 仅在调用方仍持有当前缓存值时失效，避免并发请求误删另一请求刚刷新的令牌。 */
  invalidate(
    tenantId: string,
    channel: OAuthOrgDeliveryChannel,
    rejectedAccessToken: string,
  ): void {
    const key = `${tenantId}:${channel}`;
    const cached = this.cache.get(key);
    if (cached?.value === rejectedAccessToken) this.cache.delete(key);
  }

  private async refresh(
    tenantId: string,
    channel: OAuthOrgDeliveryChannel,
  ): Promise<CachedAccessToken> {
    const credential = await this.credentials.resolve(tenantId, channel);
    if (channel === 'dingtalk') {
      const response = await this.http.request({
        origin: 'https://api.dingtalk.com',
        path: '/v1.0/oauth2/accessToken',
        method: 'POST',
        body: { appKey: credential.clientId, appSecret: credential.clientSecret },
      });
      const parsed = dingtalkTokenSchema.safeParse(response.body);
      if (!parsed.success) {
        throw new OrgPushError('DINGTALK_TOKEN_RESPONSE_INVALID', 'retryable', '钉钉令牌响应无效');
      }
      return this.cached(
        parsed.data.accessToken,
        parsed.data.expireIn,
        credential.externalTenantId,
        credential.clientId,
      );
    }
    const response = await this.http.request({
      origin: 'https://open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      body: { app_id: credential.clientId, app_secret: credential.clientSecret },
    });
    const parsed = feishuTokenSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.code !== 0 || parsed.data.tenant_access_token === undefined || parsed.data.expire === undefined) {
      throw new OrgPushError('FEISHU_TOKEN_RESPONSE_INVALID', 'retryable', '飞书令牌响应无效');
    }
    return this.cached(
      parsed.data.tenant_access_token,
      parsed.data.expire,
      credential.externalTenantId,
      credential.clientId,
    );
  }

  private cached(
    value: string,
    expiresInSeconds: number,
    externalTenantId: string,
    clientId: string,
  ): CachedAccessToken {
    const safeLifetimeSeconds = Math.max(1, expiresInSeconds - 60);
    return {
      value,
      externalTenantId,
      clientId,
      expiresAt: Date.now() + safeLifetimeSeconds * 1_000,
    };
  }

  private toAccess(token: CachedAccessToken): OrgPlatformAccess {
    return {
      accessToken: token.value,
      externalTenantId: token.externalTenantId,
      clientId: token.clientId,
    };
  }
}
