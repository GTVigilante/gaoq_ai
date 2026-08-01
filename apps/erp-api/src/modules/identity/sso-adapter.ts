import { Injectable } from '@nestjs/common';

import type { ExternalIdentityProfile, SsoProviderCode } from './auth.types.js';

export interface SsoAuthorizationCodeInput {
  readonly code: string;
  readonly codeVerifier?: string;
  readonly expectedExternalTenantId: string;
}

export interface SsoAuthorizationUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
  readonly externalTenantId: string;
}

/** 外部 SSO 适配端口；外部令牌只能在适配器内部短暂使用。 */
export abstract class SsoAdapter {
  abstract readonly provider: SsoProviderCode;
  abstract buildAuthorizationUrl(input: SsoAuthorizationUrlInput): string;
  abstract exchangeAuthorizationCode(
    input: SsoAuthorizationCodeInput,
  ): Promise<ExternalIdentityProfile>;
}

export abstract class DingTalkSsoAdapterToken extends SsoAdapter {}
export abstract class FeishuSsoAdapterToken extends SsoAdapter {}
export abstract class OpSsoAdapterToken extends SsoAdapter {}

@Injectable()
export class SsoAdapterRegistry {
  private readonly adapters: ReadonlyMap<SsoProviderCode, SsoAdapter>;

  constructor(
    dingtalk: DingTalkSsoAdapterToken,
    feishu: FeishuSsoAdapterToken,
    op: OpSsoAdapterToken,
  ) {
    if (
      dingtalk.provider !== 'dingtalk' ||
      feishu.provider !== 'feishu' ||
      op.provider !== 'op'
    ) {
      throw new Error('SSO_ADAPTER_REGISTRATION_INVALID');
    }
    this.adapters = new Map([
      [dingtalk.provider, dingtalk],
      [feishu.provider, feishu],
      [op.provider, op],
    ]);
  }

  /** 仅允许注册过的平台编码，禁止由请求拼接类名或上游地址。 */
  get(provider: SsoProviderCode): SsoAdapter {
    const adapter = this.adapters.get(provider);
    if (adapter === undefined) {
      throw new Error(`未注册的 SSO 提供者：${provider}`);
    }
    return adapter;
  }
}
