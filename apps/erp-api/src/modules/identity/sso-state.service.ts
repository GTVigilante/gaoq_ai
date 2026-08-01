import { createHash, randomBytes } from 'node:crypto';

import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants.js';
import type { SsoProviderCode } from './auth.types.js';

/** 发起 SSO 登录时创建一次性状态的输入。 */
export interface IssueSsoStateInput {
  readonly tenantId: string;
  readonly provider: SsoProviderCode;
  readonly externalTenantId: string;
  readonly returnPath: string;
}

/** issue 返回值：state 交给浏览器，codeChallenge 交给外部平台（PKCE）。 */
export interface IssuedSsoState {
  readonly state: string;
  readonly codeChallenge: string;
}

/** consume 返回值：一次性状态承载的完整上下文，含 PKCE codeVerifier。 */
export interface ConsumedSsoState {
  readonly tenantId: string;
  readonly provider: SsoProviderCode;
  readonly externalTenantId: string;
  readonly codeVerifier: string;
  readonly returnPath: string;
}

const STATE_TTL_SECONDS = 300;
const STATE_KEY_PREFIX = 'gaoq:sso:state:';
const MAX_ISSUE_ATTEMPTS = 3;
const SSO_STATE_INVALID_CODE = 'SSO_STATE_INVALID';
const identifierSchema =
  z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const externalTenantIdSchema =
  z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/);
const providerSchema = z.enum(['dingtalk', 'feishu', 'op']);
const opaqueStateSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * 登录完成后的回跳地址只允许站内相对路径：
 * 必须以单个 `/` 开头，禁止 `//`（协议相对地址）、反斜线与冒号（防协议伪装），长度不超过 512。
 */
const isSafeReturnPath = (value: string): boolean =>
  value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.includes('\\') &&
  !value.includes(':') &&
  !/\p{Cc}/u.test(value);

const returnPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isSafeReturnPath, { message: 'returnPath 必须是站内相对路径' });

/** Redis 中存储的状态载荷，使用 strict 拒绝多余字段，防止注入意外数据。 */
const storedStateSchema = z
  .object({
    tenantId: identifierSchema,
    provider: providerSchema,
    externalTenantId: externalTenantIdSchema,
    codeVerifier: opaqueStateSchema,
    returnPath: returnPathSchema,
  })
  .strict();

type StoredSsoState = z.infer<typeof storedStateSchema>;

/** state 原文禁止作为 Redis key，仅保存其 sha256 摘要。 */
const stateKey = (state: string): string =>
  STATE_KEY_PREFIX + createHash('sha256').update(state).digest('hex');

/** PKCE：codeChallenge = base64url(sha256(codeVerifier))。 */
const pkceChallenge = (codeVerifier: string): string =>
  createHash('sha256').update(codeVerifier).digest('base64url');

/** 所有校验失败统一抛出稳定错误码，不泄露 state 原文或存储内容。 */
const invalidStateError = (): UnauthorizedException =>
  new UnauthorizedException({
    code: SSO_STATE_INVALID_CODE,
    message: 'SSO 登录状态无效或已过期',
  });

const unavailableStateError = (): ServiceUnavailableException =>
  new ServiceUnavailableException({
    code: 'SSO_STATE_UNAVAILABLE',
    message: 'SSO 登录状态服务暂时不可用',
  });

/**
 * SSO 一次性登录状态服务。
 * 负责签发与消费防 CSRF 的 state 及 PKCE codeVerifier，状态只允许被消费一次。
 */
@Injectable()
export class SsoStateService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * 签发一次性 SSO 状态。
   * state 与 codeVerifier 各由 32 字节加密随机数生成；
   * Redis key 使用 sha256(state)，值带 300 秒 TTL 并以 SET NX 防覆盖。
   */
  async issue(input: IssueSsoStateInput): Promise<IssuedSsoState> {
    this.assertValidInput(input);

    for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
      const state = randomBytes(32).toString('base64url');
      const codeVerifier = randomBytes(32).toString('base64url');
      const payload: StoredSsoState = {
        tenantId: input.tenantId,
        provider: input.provider,
        externalTenantId: input.externalTenantId,
        codeVerifier,
        returnPath: input.returnPath,
      };
      let created: string | null;
      try {
        created = await this.redis.set(
          stateKey(state),
          JSON.stringify(payload),
          'EX',
          STATE_TTL_SECONDS,
          'NX',
        );
      } catch {
        throw unavailableStateError();
      }
      if (created === 'OK') {
        return Object.freeze({ state, codeChallenge: pkceChallenge(codeVerifier) });
      }
      // SET NX 冲突说明随机 state 碰撞，换一组随机数重试。
    }

    throw new ServiceUnavailableException({
      code: 'SSO_STATE_UNAVAILABLE',
      message: 'SSO 登录状态签发失败，请稍后重试',
    });
  }

  /**
   * 消费一次性 SSO 状态。
   * 使用 GETDEL 原子读取并删除，保证同一 state 只能成功消费一次；
   * 过期、缺失、JSON 异常、provider 不匹配均抛出统一的 SSO_STATE_INVALID。
   */
  async consume(state: string, expectedProvider: SsoProviderCode): Promise<ConsumedSsoState> {
    if (
      !opaqueStateSchema.safeParse(state).success ||
      !providerSchema.safeParse(expectedProvider).success
    ) {
      throw invalidStateError();
    }
    let raw: string | null;
    try {
      raw = await this.redis.getdel(stateKey(state));
    } catch {
      throw unavailableStateError();
    }
    if (raw === null) {
      throw invalidStateError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidStateError();
    }

    const result = storedStateSchema.safeParse(parsed);
    if (!result.success) {
      throw invalidStateError();
    }
    if (result.data.provider !== expectedProvider) {
      throw invalidStateError();
    }

    return Object.freeze({
      tenantId: result.data.tenantId,
      provider: result.data.provider,
      externalTenantId: result.data.externalTenantId,
      codeVerifier: result.data.codeVerifier,
      returnPath: result.data.returnPath,
    });
  }

  /** 签发前校验入参，失败与消费失败保持同一稳定错误码，避免泄露原值。 */
  private assertValidInput(input: IssueSsoStateInput): void {
    if (
      !identifierSchema.safeParse(input.tenantId).success ||
      !providerSchema.safeParse(input.provider).success ||
      !externalTenantIdSchema.safeParse(input.externalTenantId).success ||
      !returnPathSchema.safeParse(input.returnPath).success
    ) {
      throw invalidStateError();
    }
  }
}
