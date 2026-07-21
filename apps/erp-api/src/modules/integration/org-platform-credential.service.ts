import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';

import type { OrgDeliveryChannel } from './org-delivery.schemas.js';
import {
  OrgPlatformBinding,
  type OrgPlatformBindingDocument,
} from './org-platform-binding.schema.js';
import { OrgPushError } from './org-push.adapter.js';

const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const secretRefSchema = z.string().regex(/^GAOQ_ORG_PLATFORM_[A-Z0-9_]{1,96}$/);
const credentialSchema = z.object({
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().min(8).max(2048),
}).strict();

export interface OrgPlatformCredential {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly externalTenantId: string;
}

/** Secret Manager 解析端口；实现只返回秘密正文，调用方不得记录。 */
export abstract class OrgSecretResolver {
  abstract resolve(secretRef: string): Promise<string>;
}

/**
 * 默认解析器只读取受控名称的环境变量，适配 Kubernetes/云 Secret Manager 的环境注入。
 * 不允许任意环境变量名，避免借数据库记录读取进程内其他秘密。
 */
@Injectable()
export class EnvironmentOrgSecretResolver extends OrgSecretResolver {
  override resolve(secretRef: string): Promise<string> {
    const parsed = secretRefSchema.safeParse(secretRef);
    if (!parsed.success) {
      throw new OrgPushError('ORG_CREDENTIAL_REF_INVALID', 'business', '平台凭据引用无效');
    }
    const value = process.env[parsed.data];
    if (value === undefined || value.length === 0) {
      throw new OrgPushError('ORG_CREDENTIAL_UNAVAILABLE', 'retryable', '平台凭据暂不可用');
    }
    return Promise.resolve(value);
  }
}

/** 按可信 tenantId+channel 解析平台凭据，租户标识从任务记录而非客户端输入取得。 */
@Injectable()
export class OrgPlatformCredentialService {
  constructor(
    @InjectModel(OrgPlatformBinding.name)
    private readonly bindings: Model<OrgPlatformBindingDocument>,
    private readonly secrets: OrgSecretResolver,
  ) {}

  async resolve(
    tenantId: string,
    channel: OrgDeliveryChannel,
  ): Promise<OrgPlatformCredential> {
    const parsedTenantId = identifierSchema.safeParse(tenantId);
    if (!parsedTenantId.success) {
      throw new OrgPushError('ORG_TENANT_ID_INVALID', 'conflict', '租户标识无效');
    }
    const binding = await this.bindings.findOne(
      { tenantId: parsedTenantId.data, channel, status: 'active' },
      { externalTenantId: 1, credentialSecretRef: 1, _id: 0 },
    ).lean().exec();
    if (binding === null) {
      throw new OrgPushError('ORG_PLATFORM_BINDING_MISSING', 'business', '组织平台尚未绑定');
    }
    const rawSecret = await this.secrets.resolve(binding.credentialSecretRef);
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawSecret) as unknown;
    } catch {
      throw new OrgPushError('ORG_CREDENTIAL_INVALID', 'business', '平台凭据格式无效');
    }
    const credential = credentialSchema.safeParse(decoded);
    if (!credential.success) {
      throw new OrgPushError('ORG_CREDENTIAL_INVALID', 'business', '平台凭据格式无效');
    }
    return {
      ...credential.data,
      externalTenantId: binding.externalTenantId,
    };
  }
}
