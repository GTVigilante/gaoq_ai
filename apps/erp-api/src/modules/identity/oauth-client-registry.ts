import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';
import { ERP_AUTHORIZATION_SCOPE_PATTERN } from './authorization-scope.js';
import { requireAuthorizationResource } from './authorization-resources.js';

/** 预注册公共客户端的稳定状态。 */
export type OAuthClientStatus = 'active' | 'disabled';

/** 对外暴露的客户端视图，全部字段只读且深冻结。 */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly allowedResources: readonly string[];
  readonly tenantIds: readonly string[];
  readonly status: OAuthClientStatus;
}

/** clientId 与 tenantId 共用的标识字符集。 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** 允许使用 http 明文协议的本机回环主机名。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 稳定错误码：回调地址未注册。 */
export const OAUTH_REDIRECT_DENIED_CODE = 'MCP_OAUTH_REDIRECT_URI_DENIED';

/** 稳定错误码：客户端无权访问该租户。 */
export const OAUTH_TENANT_DENIED_CODE = 'MCP_OAUTH_TENANT_DENIED';

/** 稳定错误码：scope 请求本身非法（为空、重复、格式错误）。 */
export const OAUTH_SCOPE_INVALID_CODE = 'MCP_OAUTH_SCOPE_INVALID';

/** 稳定错误码：scope 超出客户端授权范围。 */
export const OAUTH_SCOPE_DENIED_CODE = 'MCP_OAUTH_SCOPE_DENIED';

/** 稳定错误码：resource 超出客户端授权范围。 */
export const OAUTH_RESOURCE_DENIED_CODE = 'MCP_OAUTH_RESOURCE_DENIED';

/**
 * 校验单个 redirectUri：
 * - 必须是绝对 URI；
 * - 禁止携带用户名/口令等凭据与 fragment；
 * - 仅允许 https，或指向 127.0.0.1 / localhost / [::1] 的 http 回环地址。
 */
const isAllowedRedirectUri = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.username !== '' || url.password !== '') {
    return false;
  }
  if (url.hash !== '') {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
};

const redirectUriSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isAllowedRedirectUri, {
    message: 'redirectUri 必须是 https 或本机回环 http 地址，且禁止凭据与 fragment',
  });

/**
 * 单个客户端配置：strict 拒绝多余字段，allowedScopes 解析时去重。
 */
const oauthClientSchema = z
  .object({
    clientId: z.string().min(8).max(128).regex(IDENTIFIER_PATTERN),
    clientName: z.string().min(1).max(128),
    redirectUris: z.array(redirectUriSchema).min(1).max(20),
    allowedScopes: z
      .array(z.string().min(1).max(128).regex(ERP_AUTHORIZATION_SCOPE_PATTERN))
      .min(1)
      .max(100)
      .transform((scopes) => [...new Set(scopes)]),
    allowedResources: z.array(z.string().url().min(1).max(2_048)).min(1).max(20),
    tenantIds: z.array(z.string().min(1).max(128).regex(IDENTIFIER_PATTERN)).min(1).max(100),
    status: z.enum(['active', 'disabled']),
  })
  .strict();

const registrySchema = z.array(oauthClientSchema);

/** 递归冻结对象与数组，保证注册表内部状态不被调用方篡改。 */
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
};

/**
 * 严格解析 MCP_OAUTH_CLIENTS_JSON。
 * 未配置或仅空白字符时视为空注册表；任何格式错误都在启动阶段直接抛错。
 */
const parseRegistry = (
  raw: string,
  config: ConfigService<AppEnvironment, true>,
): ReadonlyMap<string, OAuthClient> => {
  if (raw.trim() === '') {
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MCP_OAUTH_CLIENTS_JSON 配置无效：不是合法 JSON');
  }

  const result = registrySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`MCP_OAUTH_CLIENTS_JSON 配置无效：${z.prettifyError(result.error)}`);
  }

  const clients = new Map<string, OAuthClient>();
  for (const client of result.data) {
    if (clients.has(client.clientId)) {
      throw new Error(`MCP_OAUTH_CLIENTS_JSON 配置无效：clientId 重复 ${client.clientId}`);
    }
    if (new Set(client.allowedResources).size !== client.allowedResources.length) {
      throw new Error('MCP_OAUTH_CLIENTS_JSON 配置无效：allowedResources 禁止重复');
    }
    try {
      for (const resource of client.allowedResources) {
        requireAuthorizationResource(config, resource);
      }
    } catch {
      throw new Error('MCP_OAUTH_CLIENTS_JSON 配置无效：allowedResources 包含未注册资源');
    }
    clients.set(client.clientId, deepFreeze<OAuthClient>({ ...client }));
  }
  return clients;
};

/**
 * MCP OAuth 预注册公共客户端注册表。
 * 客户端清单来自 MCP_OAUTH_CLIENTS_JSON，启动时严格解析并整体深冻结；
 * 只提供内存只读查询，不访问网络、不依赖请求上下文构造查询。
 */
@Injectable()
export class OAuthClientRegistry {
  private readonly clients: ReadonlyMap<string, OAuthClient>;

  constructor(config: ConfigService<AppEnvironment, true>) {
    this.clients = parseRegistry(
      config.get('MCP_OAUTH_CLIENTS_JSON', { infer: true }) ?? '[]',
      config,
    );
  }

  /**
   * 按 clientId 解析处于 active 状态的客户端。
   * 未注册或已 disabled 的客户端统一返回 undefined，不区分原因。
   * 纯内存只读查询，同步返回，调用方无需 await。
   */
  resolveActive(clientId: string): OAuthClient | undefined {
    const client = this.clients.get(clientId);
    if (client === undefined || client.status !== 'active') {
      return undefined;
    }
    return client;
  }

  /**
   * 校验 redirectUri 必须与预注册值逐字符精确一致，防止开放重定向。
   */
  assertRedirect(client: OAuthClient, redirectUri: string): void {
    if (!client.redirectUris.includes(redirectUri)) {
      throw new ForbiddenException({
        code: OAUTH_REDIRECT_DENIED_CODE,
        message: 'redirectUri 未在该客户端的预注册清单中',
      });
    }
  }

  /**
   * 校验客户端是否被授权访问指定租户，防止跨租户越权。
   */
  assertTenant(client: OAuthClient, tenantId: string): void {
    if (!client.tenantIds.includes(tenantId)) {
      throw new ForbiddenException({
        code: OAUTH_TENANT_DENIED_CODE,
        message: '该客户端无权访问目标租户',
      });
    }
  }

  /** 校验公共客户端只能申请其显式登记的资源，旧客户端不获得隐式默认授权。 */
  assertResource(client: OAuthClient, resource: string): void {
    if (!client.allowedResources.includes(resource)) {
      throw new ForbiddenException({
        code: OAUTH_RESOURCE_DENIED_CODE,
        message: '该客户端无权访问目标 resource',
      });
    }
  }

  /**
   * 过滤并校验请求 scope：必须非空、无重复、全部落在 allowedScopes 内。
   * 请求本身非法抛 BadRequest，越权 scope 抛 Forbidden，均使用稳定错误码。
   */
  filterAllowedScopes(
    client: OAuthClient,
    requestedScopes: readonly string[],
  ): readonly string[] {
    if (requestedScopes.length === 0 || new Set(requestedScopes).size !== requestedScopes.length) {
      throw new BadRequestException({
        code: OAUTH_SCOPE_INVALID_CODE,
        message: 'scope 请求必须非空且不重复',
      });
    }

    const allowed = new Set(client.allowedScopes);
    const granted = requestedScopes.filter((scope) => allowed.has(scope));
    if (granted.length !== requestedScopes.length) {
      throw new ForbiddenException({
        code: OAUTH_SCOPE_DENIED_CODE,
        message: '存在超出客户端授权范围的 scope',
      });
    }

    return deepFreeze([...granted]);
  }

  /** 授权服务器发现仅公布 active 客户端已配置 scope 的去重并集。 */
  listSupportedScopes(): readonly string[] {
    const scopes = new Set<string>();
    for (const client of this.clients.values()) {
      if (client.status !== 'active') continue;
      for (const scope of client.allowedScopes) scopes.add(scope);
    }
    return deepFreeze([...scopes].sort());
  }
}
