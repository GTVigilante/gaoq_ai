import type { ActorType } from '@gaoq/shared-types';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

const extraSchema = z.object({
  tenantId: z.string().min(1),
  actorId: z.string().min(1),
  actorType: z.enum(['user', 'service', 'mcp_client', 'system_job']),
  roleCodes: z.array(z.string()),
  departmentIds: z.array(z.string()),
  traceId: z.string().min(1),
});

export interface McpIdentity {
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorType: ActorType;
  readonly roleCodes: readonly string[];
  readonly scopes: readonly string[];
  readonly departmentIds: readonly string[];
  readonly traceId: string;
  readonly clientId: string;
}

/** 从 SDK 验证后的 AuthInfo 读取身份，禁止使用 Tool 参数声明租户。 */
export const parseMcpIdentity = (authInfo: AuthInfo | undefined): McpIdentity => {
  const result = extraSchema.safeParse(authInfo?.extra);
  if (!result.success || authInfo === undefined) {
    throw new UnauthorizedException('MCP 可信身份缺失');
  }
  return {
    ...result.data,
    scopes: authInfo.scopes,
    clientId: authInfo.clientId,
  };
};
