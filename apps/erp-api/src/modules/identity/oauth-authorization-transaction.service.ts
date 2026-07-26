import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants.js';
import { OAuthClientRegistry } from './oauth-client-registry.js';
import type { BrowserOAuthIdentity } from './token-grant.service.js';
import { requireAuthorizationResource } from './authorization-resources.js';

const AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 60;
const REQUEST_KEY_PREFIX = 'gaoq:oauth:request:';
const CODE_KEY_PREFIX = 'gaoq:oauth:code:';
const RANDOM_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE_PATTERN = /^[\x21-\x7E]{1,512}$/;
const MAX_RANDOM_ATTEMPTS = 3;

const storedRequestSchema = z.object({
  clientId: z.string().min(8).max(128),
  redirectUri: z.string().min(1).max(2_048),
  scopes: z.array(z.string().min(1).max(128)).min(1).max(100),
  resource: z.string().url().max(2_048),
  state: z.string().min(1).max(512),
  codeChallenge: z.string().regex(RANDOM_VALUE_PATTERN),
}).strict();

const storedCodeSchema = z.object({
  tenantId: z.string().min(1).max(128),
  actorId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  clientId: z.string().min(8).max(128),
  redirectUri: z.string().min(1).max(2_048),
  scopes: z.array(z.string().min(1).max(128)).min(1).max(100),
  resource: z.string().url().max(2_048),
  codeChallenge: z.string().regex(RANDOM_VALUE_PATTERN),
}).strict();

export interface BeginOAuthAuthorizationInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly state: string;
  readonly codeChallenge: string;
}

export interface OAuthAuthorizationRequestView {
  readonly requestId: string;
  readonly clientName: string;
  readonly redirectOrigin: string;
  readonly scopes: readonly string[];
  readonly expiresIn: number;
}

export interface OAuthAuthorizationDecision {
  readonly redirectTo: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface OAuthAuthorizationCodeGrant {
  readonly tenantId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
}

const digestKey = (prefix: string, value: string): string =>
  prefix + createHash('sha256').update(value, 'utf8').digest('hex');

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * OAuth 授权请求与授权码事务服务。
 * Redis 仅保存随机值摘要作为键，授权请求和授权码均一次性、短时且资源绑定。
 */
@Injectable()
export class OAuthAuthorizationTransactionService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly clients: OAuthClientRegistry,
  ) {}

  /** 校验预注册客户端、精确回调、PKCE 与资源后创建一次性同意请求。 */
  async begin(input: BeginOAuthAuthorizationInput): Promise<OAuthAuthorizationRequestView> {
    this.assertProtocolInput(input);
    const client = this.clients.resolveActive(input.clientId);
    if (client === undefined) throw this.invalidClient();
    this.clients.assertRedirect(client, input.redirectUri);
    const scopes = this.clients.filterAllowedScopes(client, input.scopes);
    const payload = storedRequestSchema.parse({ ...input, scopes: [...scopes] });
    for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
      const requestId = randomBytes(32).toString('base64url');
      const created = await this.redis.set(
        digestKey(REQUEST_KEY_PREFIX, requestId),
        JSON.stringify(payload),
        'EX',
        AUTHORIZATION_REQUEST_TTL_SECONDS,
        'NX',
      );
      if (created === 'OK') {
        return Object.freeze({
          requestId,
          clientName: client.clientName,
          redirectOrigin: new URL(input.redirectUri).origin,
          scopes: Object.freeze([...scopes]),
          expiresIn: AUTHORIZATION_REQUEST_TTL_SECONDS,
        });
      }
    }
    throw new ServiceUnavailableException({
      code: 'OAUTH_REQUEST_UNAVAILABLE',
      message: '授权请求创建失败，请稍后重试',
    });
  }

  /** 以不可猜测 requestId 获取同意页最小展示信息，不返回租户或主体。 */
  async describe(requestId: string): Promise<OAuthAuthorizationRequestView> {
    const stored = await this.readRequest(requestId);
    const client = this.clients.resolveActive(stored.clientId);
    if (client === undefined) throw this.invalidRequest();
    return Object.freeze({
      requestId,
      clientName: client.clientName,
      redirectOrigin: new URL(stored.redirectUri).origin,
      scopes: Object.freeze([...stored.scopes]),
      expiresIn: AUTHORIZATION_REQUEST_TTL_SECONDS,
    });
  }

  /** 同意时从可信浏览器会话绑定租户和主体；拒绝时不创建授权码。 */
  async decide(
    requestId: string,
    approved: boolean,
    identity: BrowserOAuthIdentity,
  ): Promise<OAuthAuthorizationDecision> {
    const requestKey = this.requestKey(requestId);
    const raw = await this.redis.get(requestKey);
    if (raw === null) throw this.invalidRequest();
    const parsed = storedRequestSchema.safeParse(parseJson(raw));
    if (!parsed.success) throw this.invalidRequest();
    const client = this.clients.resolveActive(parsed.data.clientId);
    if (client === undefined) throw this.invalidRequest();
    this.clients.assertTenant(client, identity.tenantId);
    const redirect = new URL(parsed.data.redirectUri);
    if (!approved) {
      const consumed = await this.compareAndDelete(requestKey, raw);
      if (!consumed) throw this.invalidRequest();
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('state', parsed.data.state);
      redirect.searchParams.set('iss', this.config.get('AUTH_ISSUER', { infer: true }));
      return {
        redirectTo: redirect.toString(),
        clientId: parsed.data.clientId,
        scopes: Object.freeze([...parsed.data.scopes]),
      };
    }
    if (!parsed.data.scopes.every((scope) => identity.scopes.includes(scope))) {
      throw new ForbiddenException({
        code: 'OAUTH_SCOPE_NOT_GRANTED',
        message: '主体未获请求的权限范围',
      });
    }
    const codePayload = storedCodeSchema.parse({
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      sessionId: identity.sessionId,
      clientId: parsed.data.clientId,
      redirectUri: parsed.data.redirectUri,
      scopes: parsed.data.scopes,
      resource: parsed.data.resource,
      codeChallenge: parsed.data.codeChallenge,
    });
    for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
      const code = `oc_${randomBytes(32).toString('base64url')}`;
      const issued = await this.consumeRequestAndIssueCode(
        requestKey,
        raw,
        this.codeKey(code),
        JSON.stringify(codePayload),
      );
      if (issued === 'collision') continue;
      if (issued === 'stale') throw this.invalidRequest();
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', parsed.data.state);
      redirect.searchParams.set('iss', this.config.get('AUTH_ISSUER', { infer: true }));
      return {
        redirectTo: redirect.toString(),
        clientId: parsed.data.clientId,
        scopes: Object.freeze([...parsed.data.scopes]),
      };
    }
    throw new ServiceUnavailableException({
      code: 'OAUTH_CODE_UNAVAILABLE',
      message: '授权码签发失败，请稍后重试',
    });
  }

  /** 校验客户端、回调、资源和 PKCE 后原子消费一次性授权码。 */
  async exchange(input: {
    readonly code: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly resource: string;
    readonly codeVerifier: string;
  }): Promise<OAuthAuthorizationCodeGrant> {
    if (!/^oc_[A-Za-z0-9_-]{43}$/.test(input.code)) throw this.invalidGrant();
    if (!CODE_VERIFIER_PATTERN.test(input.codeVerifier)) throw this.invalidGrant();
    const codeKey = this.codeKey(input.code);
    const raw = await this.redis.get(codeKey);
    if (raw === null) throw this.invalidGrant();
    const parsed = storedCodeSchema.safeParse(parseJson(raw));
    if (!parsed.success) throw this.invalidGrant();
    if (
      parsed.data.clientId !== input.clientId ||
      parsed.data.redirectUri !== input.redirectUri ||
      parsed.data.resource !== input.resource ||
      !this.pkceMatches(parsed.data.codeChallenge, input.codeVerifier)
    ) throw this.invalidGrant();
    const client = this.clients.resolveActive(input.clientId);
    if (client === undefined) throw this.invalidGrant();
    this.clients.assertRedirect(client, input.redirectUri);
    const consumed = await this.compareAndDelete(codeKey, raw);
    if (!consumed) throw this.invalidGrant();
    return Object.freeze({
      tenantId: parsed.data.tenantId,
      actorId: parsed.data.actorId,
      sessionId: parsed.data.sessionId,
      clientId: parsed.data.clientId,
      scopes: Object.freeze([...parsed.data.scopes]),
      resource: parsed.data.resource,
    });
  }

  private assertProtocolInput(input: BeginOAuthAuthorizationInput): void {
    requireAuthorizationResource(this.config, input.resource);
    if (!STATE_PATTERN.test(input.state)) {
      throw new BadRequestException({ code: 'OAUTH_STATE_INVALID', message: 'state 非法' });
    }
    if (!RANDOM_VALUE_PATTERN.test(input.codeChallenge)) {
      throw new BadRequestException({ code: 'OAUTH_PKCE_INVALID', message: 'PKCE challenge 非法' });
    }
  }

  private async readRequest(requestId: string): Promise<z.infer<typeof storedRequestSchema>> {
    const raw = await this.redis.get(this.requestKey(requestId));
    if (raw === null) throw this.invalidRequest();
    const parsed = storedRequestSchema.safeParse(parseJson(raw));
    if (!parsed.success) throw this.invalidRequest();
    return parsed.data;
  }

  private requestKey(requestId: string): string {
    if (!RANDOM_VALUE_PATTERN.test(requestId)) throw this.invalidRequest();
    return digestKey(REQUEST_KEY_PREFIX, requestId);
  }

  private codeKey(code: string): string {
    return digestKey(CODE_KEY_PREFIX, code);
  }

  private pkceMatches(expected: string, codeVerifier: string): boolean {
    const actual = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const actualBuffer = Buffer.from(actual, 'utf8');
    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  }

  private async compareAndDelete(key: string, expectedRaw: string): Promise<boolean> {
    const result = await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      key,
      expectedRaw,
    );
    return result === 1;
  }

  private async consumeRequestAndIssueCode(
    requestKey: string,
    expectedRequest: string,
    codeKey: string,
    codePayload: string,
  ): Promise<'issued' | 'stale' | 'collision'> {
    const result = await this.redis.eval(
      "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end " +
      "if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end " +
      "redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]); redis.call('DEL', KEYS[1]); return 1",
      2,
      requestKey,
      codeKey,
      expectedRequest,
      codePayload,
      String(AUTHORIZATION_CODE_TTL_SECONDS),
    );
    if (result === 1) return 'issued';
    if (result === -1) return 'collision';
    return 'stale';
  }

  private invalidClient(): UnauthorizedException {
    return new UnauthorizedException({ code: 'OAUTH_INVALID_CLIENT', message: '客户端无效' });
  }

  private invalidRequest(): BadRequestException {
    return new BadRequestException({ code: 'OAUTH_REQUEST_INVALID', message: '授权请求无效或已过期' });
  }

  private invalidGrant(): BadRequestException {
    return new BadRequestException({ code: 'OAUTH_INVALID_GRANT', message: '授权码无效或已过期' });
  }
}
