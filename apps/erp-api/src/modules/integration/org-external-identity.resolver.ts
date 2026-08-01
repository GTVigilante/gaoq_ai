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

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const externalIdSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/);
const accessTokenSchema = z.string().regex(/^[\x21-\x7e]{1,4096}$/);
const requestSchema = z.object({
  tenantId: idSchema,
  channel: z.enum(['dingtalk', 'feishu', 'op']),
  employeeId: idSchema,
}).strict();
const bindingSchema = z.object({
  externalTenantId: idSchema,
}).strict();
const identitySchema = z.object({
  externalUserId: externalIdSchema,
  unionId: externalIdSchema,
}).strict();
const dingtalkAccessSchema = z.object({
  accessToken: accessTokenSchema,
  externalTenantId: idSchema,
  clientId: idSchema,
}).strict();
const dingtalkResolutionSchema = z.object({
  errcode: z.number().int(),
  result: z.object({
    userid: externalIdSchema,
  }).passthrough().optional(),
}).passthrough();

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
    const input = requestSchema.safeParse({ tenantId, channel, employeeId });
    if (!input.success) return null;
    const binding = await this.bindings.findOne(
      {
        tenantId: input.data.tenantId,
        channel: input.data.channel,
        status: 'active',
      },
      { externalTenantId: 1, _id: 0 },
    ).lean().exec();
    if (binding === null) return null;
    const parsedBinding = bindingSchema.safeParse(binding);
    if (!parsedBinding.success) {
      throw new OrgPushError(
        'ORG_EXTERNAL_IDENTITY_STATE_INVALID',
        'business',
        '组织外部身份状态无效',
      );
    }
    const identity = await this.identities.findOne(
      {
        tenantId: input.data.tenantId,
        provider: input.data.channel,
        externalTenantId: parsedBinding.data.externalTenantId,
        employeeId: input.data.employeeId,
        status: 'bound',
      },
      { externalUserId: 1, unionId: 1, _id: 0 },
    ).lean().exec();
    if (identity === null) return null;
    const parsedIdentity = identitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      throw new OrgPushError(
        'ORG_EXTERNAL_IDENTITY_STATE_INVALID',
        'business',
        '组织外部身份状态无效',
      );
    }
    if (input.data.channel !== 'dingtalk') {
      return parsedIdentity.data.externalUserId;
    }
    const access = dingtalkAccessSchema.safeParse(
      await this.tokens.getAccess(input.data.tenantId, 'dingtalk'),
    );
    if (
      !access.success ||
      access.data.externalTenantId !== parsedBinding.data.externalTenantId
    ) {
      throw new OrgPushError(
        'DINGTALK_TENANT_CONTEXT_MISMATCH',
        'business',
        '钉钉租户上下文不一致',
      );
    }
    const response = await this.http.request({
      origin: 'https://oapi.dingtalk.com',
      path: '/topapi/user/getbyunionid',
      method: 'POST',
      sensitiveQuery: { access_token: access.data.accessToken },
      body: { unionid: parsedIdentity.data.unionId },
    });
    const parsed = dingtalkResolutionSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.errcode !== 0 || parsed.data.result === undefined) {
      throw new OrgPushError('DINGTALK_USER_ID_RESOLUTION_FAILED', 'retryable', '钉钉员工标识解析失败');
    }
    return parsed.data.result.userid;
  }
}
