import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/environment.js';

const resourceSchema = z.object({
  resource: z.string().url().max(2_048),
  audience: z.string().min(1).max(256),
}).strict();

const additionalResourcesSchema = z.array(resourceSchema).max(20);

export interface AuthorizationResource {
  readonly resource: string;
  readonly audience: string;
}

/** 解析主资源与额外受众资源，确保每个 resource 只绑定一个 audience。 */
export const listAuthorizationResources = (
  config: ConfigService<AppEnvironment, true>,
): readonly AuthorizationResource[] => {
  const primary = {
    resource: config.get('AUTH_RESOURCE', { infer: true }),
    audience: config.get('AUTH_AUDIENCE', { infer: true }),
  };
  const raw = config.get('AUTH_ADDITIONAL_RESOURCES_JSON', { infer: true }) ?? '[]';
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('AUTH_ADDITIONAL_RESOURCES_JSON 不是合法 JSON');
  }
  const parsed = additionalResourcesSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`AUTH_ADDITIONAL_RESOURCES_JSON 配置无效：${z.prettifyError(parsed.error)}`);
  }
  const result = [primary, ...parsed.data];
  const resources = new Set<string>();
  for (const item of result) {
    const url = new URL(item.resource);
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      resources.has(item.resource)
    ) {
      throw new Error('授权资源禁止凭据、fragment 或重复配置');
    }
    resources.add(item.resource);
  }
  return Object.freeze(result.map((item) => Object.freeze({ ...item })));
};

/** 解析已注册 resource 对应的 audience，未知资源一律拒绝。 */
export const requireAuthorizationResource = (
  config: ConfigService<AppEnvironment, true>,
  resource: string,
): AuthorizationResource => {
  const resolved = listAuthorizationResources(config).find(
    (candidate) => candidate.resource === resource,
  );
  if (resolved === undefined) {
    throw new BadRequestException({
      code: 'OAUTH_RESOURCE_INVALID',
      message: 'resource 非法',
    });
  }
  return resolved;
};
