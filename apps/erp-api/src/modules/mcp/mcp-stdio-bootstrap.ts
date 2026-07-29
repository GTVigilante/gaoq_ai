import { randomUUID } from 'node:crypto';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { INestApplicationContext } from '@nestjs/common';
import { z } from 'zod';

import { AccessTokenVerifier } from '../identity/access-token-verifier.js';
import { buildMcpAuthInfo } from './mcp-auth-context.js';
import {
  McpAuthenticatedStdioTransport,
  type McpStdioAuthProvider,
} from './mcp-authenticated-stdio.transport.js';
import { McpRuntimeService } from './mcp-runtime.service.js';

export const MCP_STDIO_CONNECT_SCOPE = 'erp:mcp:server:connect' as const;

const stdioEnvironmentSchema = z.object({
  MCP_STDIO_ACCESS_TOKEN: z.string()
    .min(64)
    .max(8_192)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u),
  MCP_STDIO_TRACE_ID: z.string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/u)
    .optional(),
});

export interface McpStdioBootstrapConfig {
  readonly accessToken: string;
  readonly traceId: string;
}

export interface McpStdioConnection {
  readonly server: McpServer;
  readonly transport: McpAuthenticatedStdioTransport;
}

export interface ConnectMcpStdioOptions {
  readonly application: INestApplicationContext;
  readonly innerTransport: Transport;
  readonly config: McpStdioBootstrapConfig;
  readonly onClose?: () => void;
  readonly onError?: (error: Error) => void;
}

/** 解析 stdio 专用短时令牌；错误只返回稳定码，禁止回显环境变量。 */
export const parseMcpStdioEnvironment = (
  environment: NodeJS.ProcessEnv,
  createTraceId: () => string = randomUUID,
): McpStdioBootstrapConfig => {
  const parsed = stdioEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error('MCP_STDIO_ENVIRONMENT_INVALID');
  }
  return Object.freeze({
    accessToken: parsed.data.MCP_STDIO_ACCESS_TOKEN,
    traceId: parsed.data.MCP_STDIO_TRACE_ID ?? createTraceId(),
  });
};

/** 每条 stdio 消息复用统一 JWT、会话、客户端吊销和 Scope 验证链。 */
export const createMcpStdioAuthProvider = (
  verifier: AccessTokenVerifier,
  config: McpStdioBootstrapConfig,
): McpStdioAuthProvider => async (): Promise<AuthInfo> => {
  const verified = await verifier.verify(config.accessToken);
  if (!verified.scopes.includes(MCP_STDIO_CONNECT_SCOPE)) {
    throw new Error('MCP_STDIO_CONNECT_SCOPE_REQUIRED');
  }
  return buildMcpAuthInfo(config.accessToken, verified, config.traceId);
};

/**
 * 将 Nest 应用服务目录连接到官方 stdio transport。
 *
 * 连接前先执行一次认证预检；连接后包装器会对每条消息重新验证，以支持令牌过期、
 * 会话失效和服务客户端凭据吊销的即时失败关闭。
 */
export const connectMcpStdio = async (
  options: ConnectMcpStdioOptions,
): Promise<McpStdioConnection> => {
  const verifier = options.application.get(AccessTokenVerifier);
  const runtime = options.application.get(McpRuntimeService);
  const provideAuthInfo = createMcpStdioAuthProvider(verifier, options.config);
  await provideAuthInfo();

  const transport = new McpAuthenticatedStdioTransport(
    options.innerTransport,
    provideAuthInfo,
  );
  if (options.onClose !== undefined) transport.onclose = options.onClose;
  if (options.onError !== undefined) transport.onerror = options.onError;
  const server = await runtime.connect(transport);
  return Object.freeze({ server, transport });
};
