import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JWK } from 'jose';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import { ERP_AUTHORIZATION_SCOPE_PATTERN } from './authorization-scope.js';

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;

const commonCredentialSchema = z.object({
  credentialId: z.string().regex(CLIENT_ID_PATTERN),
  notBefore: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  status: z.enum(['active', 'revoked']),
});

const rsaJwkSchema = z.object({
  kty: z.literal('RSA'),
  kid: z.string().regex(CLIENT_ID_PATTERN),
  alg: z.literal('RS256'),
  use: z.literal('sig'),
  key_ops: z.tuple([z.literal('verify')]),
  n: z.string().min(342).max(1_024).regex(KEY_VALUE_PATTERN),
  e: z.string().min(1).max(16).regex(KEY_VALUE_PATTERN),
}).strict();

const ecJwkSchema = z.object({
  kty: z.literal('EC'),
  kid: z.string().regex(CLIENT_ID_PATTERN),
  alg: z.literal('ES256'),
  use: z.literal('sig'),
  key_ops: z.tuple([z.literal('verify')]),
  crv: z.literal('P-256'),
  x: z.string().length(43).regex(KEY_VALUE_PATTERN),
  y: z.string().length(43).regex(KEY_VALUE_PATTERN),
}).strict();

const secretCredentialSchema = commonCredentialSchema.extend({
  secretSha256: z.string().length(43).regex(KEY_VALUE_PATTERN),
}).strict();

const jwtCredentialSchema = commonCredentialSchema.extend({
  publicJwk: z.discriminatedUnion('kty', [rsaJwkSchema, ecJwkSchema]),
}).strict();

const serviceClientSchema = z.object({
  clientId: z.string().regex(CLIENT_ID_PATTERN),
  clientName: z.string().min(1).max(128),
  tenantId: z.string().regex(ID_PATTERN),
  actorId: z.string().regex(ID_PATTERN),
  allowedScopes: z.array(z.string().min(1).max(128).regex(ERP_AUTHORIZATION_SCOPE_PATTERN)).min(1).max(100),
  roleCodes: z.array(z.string().regex(ID_PATTERN)).max(100),
  departmentIds: z.array(z.string().regex(ID_PATTERN)).max(500),
  status: z.enum(['active', 'disabled']),
  authentication: z.discriminatedUnion('method', [
    z.object({
      method: z.literal('client_secret_basic'),
      credentials: z.array(secretCredentialSchema).min(1).max(5),
    }).strict(),
    z.object({
      method: z.literal('private_key_jwt'),
      credentials: z.array(jwtCredentialSchema).min(1).max(5),
    }).strict(),
  ]),
}).strict();

const registrySchema = z.array(serviceClientSchema).max(100);

export type OAuthServiceClient = Readonly<z.infer<typeof serviceClientSchema>>;
export type OAuthSecretCredential = Readonly<z.infer<typeof secretCredentialSchema>>;
export type OAuthJwtCredential = Readonly<z.infer<typeof jwtCredentialSchema>>;
export type OAuthServiceCredential = OAuthSecretCredential | OAuthJwtCredential;
export type OAuthServiceAuthMethod = OAuthServiceClient['authentication']['method'];

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};

const hasDuplicates = (items: readonly string[]): boolean => new Set(items).size !== items.length;

/** 启动时解析无人值守客户端配置；错误信息不得回显凭据摘要或公钥。 */
const parseRegistry = (raw: string): ReadonlyMap<string, OAuthServiceClient> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === '' ? '[]' : raw);
  } catch {
    throw new Error('MCP_SERVICE_CLIENTS_JSON 配置无效：不是合法 JSON');
  }
  const result = registrySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('MCP_SERVICE_CLIENTS_JSON 配置无效：字段、类型或密钥约束不符合规范');
  }

  const clients = new Map<string, OAuthServiceClient>();
  const credentialIds = new Set<string>();
  const keyIds = new Set<string>();
  for (const client of result.data) {
    if (clients.has(client.clientId)) {
      throw new Error('MCP_SERVICE_CLIENTS_JSON 配置无效：clientId 必须全局唯一');
    }
    if (
      hasDuplicates(client.allowedScopes) || hasDuplicates(client.roleCodes) ||
      hasDuplicates(client.departmentIds)
    ) {
      throw new Error('MCP_SERVICE_CLIENTS_JSON 配置无效：授权数组不得包含重复项');
    }
    for (const credential of client.authentication.credentials) {
      if (new Date(credential.notBefore).getTime() >= new Date(credential.expiresAt).getTime()) {
        throw new Error('MCP_SERVICE_CLIENTS_JSON 配置无效：凭据有效期顺序错误');
      }
      if (credentialIds.has(credential.credentialId)) {
        throw new Error('MCP_SERVICE_CLIENTS_JSON 配置无效：credentialId 必须全局唯一');
      }
      credentialIds.add(credential.credentialId);
      if ('publicJwk' in credential) {
        if (keyIds.has(credential.publicJwk.kid)) {
          throw new Error('MCP_SERVICE_CLIENTS_JSON 配置无效：JWK kid 必须全局唯一');
        }
        keyIds.add(credential.publicJwk.kid);
      }
    }
    clients.set(client.clientId, deepFreeze(client));
  }
  return clients;
};

/** 无人值守 MCP 客户端只读注册表，支持重叠轮换与配置级即时吊销。 */
@Injectable()
export class OAuthServiceClientRegistry {
  private readonly clients: ReadonlyMap<string, OAuthServiceClient>;

  constructor(config: ConfigService<AppEnvironment, true>) {
    this.clients = parseRegistry(config.get('MCP_SERVICE_CLIENTS_JSON', { infer: true }) ?? '[]');
  }

  resolveActive(clientId: string): OAuthServiceClient | undefined {
    const client = this.clients.get(clientId);
    return client?.status === 'active' ? client : undefined;
  }

  listCurrentCredentials(
    client: OAuthServiceClient,
    at: Date = new Date(),
  ): readonly OAuthServiceCredential[] {
    const now = at.getTime();
    return deepFreeze(client.authentication.credentials.filter((credential) =>
      credential.status === 'active' &&
      new Date(credential.notBefore).getTime() <= now &&
      now < new Date(credential.expiresAt).getTime(),
    ));
  }

  filterAllowedScopes(
    client: OAuthServiceClient,
    requestedScopes?: readonly string[],
  ): readonly string[] {
    const requested = requestedScopes ?? client.allowedScopes;
    if (requested.length === 0 || hasDuplicates(requested)) {
      throw new BadRequestException({ code: 'OAUTH_SCOPE_INVALID', message: 'scope 请求非法' });
    }
    const allowed = new Set(client.allowedScopes);
    if (!requested.every((scope) => allowed.has(scope))) {
      throw new ForbiddenException({ code: 'OAUTH_SCOPE_DENIED', message: 'scope 超出客户端授权范围' });
    }
    return deepFreeze([...requested]);
  }

  isActiveTokenIdentity(input: {
    readonly clientId: string;
    readonly tenantId: string;
    readonly actorId: string;
    readonly credentialId: string;
    readonly scopes: readonly string[];
    readonly roleCodes: readonly string[];
    readonly departmentIds: readonly string[];
  }): boolean {
    const client = this.resolveActive(input.clientId);
    if (
      client === undefined || client.tenantId !== input.tenantId || client.actorId !== input.actorId ||
      !sameStringSet(input.scopes, input.scopes.filter((scope) => client.allowedScopes.includes(scope))) ||
      !sameStringSet(input.roleCodes, client.roleCodes) ||
      !sameStringSet(input.departmentIds, client.departmentIds)
    ) return false;
    return this.listCurrentCredentials(client).some(
      (credential) => credential.credentialId === input.credentialId,
    );
  }

  listSupportedAuthMethods(): readonly OAuthServiceAuthMethod[] {
    return deepFreeze(['client_secret_basic', 'private_key_jwt']);
  }

  listSupportedScopes(): readonly string[] {
    const scopes = new Set<string>();
    for (const client of this.clients.values()) {
      if (client.status === 'active') for (const scope of client.allowedScopes) scopes.add(scope);
    }
    return deepFreeze([...scopes].sort());
  }

  /** 供 JWT 验证器导入公钥，返回类型明确排除私钥材料。 */
  getPublicJwk(credential: OAuthJwtCredential): JWK {
    return credential.publicJwk;
  }
}

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && new Set(left).size === left.length &&
  left.every((item) => right.includes(item));
