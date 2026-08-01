import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { z } from 'zod';

import type { SsoProviderCode } from './auth.types.js';
import {
  SsoTenantBinding,
  type SsoTenantBindingDocument,
} from './sso-tenant-binding.schema.js';

const loginSlugSchema = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const providerSchema = z.enum(['dingtalk', 'feishu', 'op']);
const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const externalTenantIdSchema =
  z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/);
const resolvedBindingSchema = z.object({
  tenantId: identifierSchema,
  provider: providerSchema,
  externalTenantId: externalTenantIdSchema,
}).strict();

export interface ResolvedSsoTenant {
  readonly tenantId: string;
  readonly provider: SsoProviderCode;
  readonly externalTenantId: string;
}

@Injectable()
export class SsoTenantBindingRepository {
  constructor(
    @InjectModel(SsoTenantBinding.name)
    private readonly bindings: Model<SsoTenantBindingDocument>,
  ) {}

  /**
   * 通过公开登录别名解析可信租户。该查询是登录前唯一允许的跨租户解析点，且只返回最小绑定。
   */
  async resolveActive(
    loginSlug: string,
    provider: SsoProviderCode,
  ): Promise<ResolvedSsoTenant | null> {
    const parsedSlug = loginSlugSchema.safeParse(loginSlug);
    if (!parsedSlug.success) {
      throw new BadRequestException({ code: 'SSO_TENANT_SLUG_INVALID', message: '租户登录别名无效' });
    }
    const parsedProvider = providerSchema.safeParse(provider);
    if (!parsedProvider.success) {
      throw new BadRequestException({ code: 'SSO_PROVIDER_INVALID', message: 'SSO 提供者无效' });
    }
    const normalizedSlug = parsedSlug.data;
    const result = await this.bindings
      .findOne(
        { loginSlug: normalizedSlug, provider: parsedProvider.data, status: 'active' },
        { tenantId: 1, provider: 1, externalTenantId: 1, _id: 0 },
      )
      .lean()
      .exec();
    if (result === null) {
      return null;
    }
    const parsedBinding = resolvedBindingSchema.safeParse({
      tenantId: result.tenantId,
      provider: result.provider,
      externalTenantId: result.externalTenantId,
    });
    if (!parsedBinding.success || parsedBinding.data.provider !== parsedProvider.data) {
      throw new Error('SSO_TENANT_BINDING_CORRUPT');
    }
    return Object.freeze(parsedBinding.data);
  }
}
