import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';

import {
  ExternalIdentity,
  type ExternalIdentityDocument,
} from '../identity/external-identity.schema.js';
import type { OrgDeliveryChannel } from './org-delivery.schemas.js';
import {
  OrgPlatformBinding,
  type OrgPlatformBindingDocument,
} from './org-platform-binding.schema.js';
import { OrgPlatformHttpClient } from './org-platform-http.client.js';
import { OrgPlatformTokenService } from './org-platform-token.service.js';
import { OrgPushError } from './org-push.adapter.js';

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

/** 只按租户+平台+员工精确读取已验证外部身份，禁止按手机号/邮箱模糊合并。 */
@Injectable()
export class OrgExternalIdentityResolver {
  constructor(
    @InjectModel(ExternalIdentity.name)
    private readonly identities: Model<ExternalIdentityDocument>,
    @InjectModel(OrgPlatformBinding.name)
    private readonly bindings: Model<OrgPlatformBindingDocument>,
    private readonly tokens: OrgPlatformTokenService,
    private readonly http: OrgPlatformHttpClient,
  ) {}

  async findBoundExternalUserId(
    tenantId: string,
    channel: OrgDeliveryChannel,
    employeeId: string,
  ): Promise<string | null> {
    if (!idSchema.safeParse(tenantId).success || !idSchema.safeParse(employeeId).success) return null;
    const binding = await this.bindings.findOne(
      { tenantId, channel, status: 'active' },
      { externalTenantId: 1, _id: 0 },
    ).lean().exec();
    if (binding === null) return null;
    const identity = await this.identities.findOne(
      {
        tenantId,
        provider: channel,
        externalTenantId: binding.externalTenantId,
        employeeId,
        status: 'bound',
      },
      { externalUserId: 1, unionId: 1, _id: 0 },
    ).lean().exec();
    if (identity === null) return null;
    if (channel === 'feishu') return identity.externalUserId;
    const access = await this.tokens.getAccess(tenantId, 'dingtalk');
    const response = await this.http.request({
      origin: 'https://oapi.dingtalk.com',
      path: '/topapi/user/getbyunionid',
      method: 'POST',
      sensitiveQuery: { access_token: access.accessToken },
      body: { unionid: identity.unionId },
    });
    const parsed = z.object({
      errcode: z.number().int(),
      result: z.object({ userid: z.string().min(1) }).optional(),
    }).passthrough().safeParse(response.body);
    if (!parsed.success || parsed.data.errcode !== 0 || parsed.data.result === undefined) {
      throw new OrgPushError('DINGTALK_USER_ID_RESOLUTION_FAILED', 'retryable', '钉钉员工标识解析失败');
    }
    return parsed.data.result.userid;
  }
}
