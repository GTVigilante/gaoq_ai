import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  McpAuthenticatedStdioTransport,
} from '../dist/modules/mcp/mcp-authenticated-stdio.transport.js';
import {
  McpRuntimeService,
} from '../dist/modules/mcp/mcp-runtime.service.js';

const authInfo = Object.freeze({
  token: randomUUID(),
  clientId: 'catalog-compatibility-fixture',
  scopes: ['erp:mcp:server:connect'],
  expiresAt: 2_000_000_000,
  resource: new URL('https://erp.example.invalid/mcp'),
  extra: Object.freeze({
    tenantId: 'catalog-compatibility-tenant',
    actorId: 'catalog-compatibility-agent',
    actorType: 'service',
    roleCodes: Object.freeze(['catalog-reader']),
    departmentIds: Object.freeze([]),
    traceId: 'catalog-compatibility-trace',
  }),
});

const config = Object.freeze({
  get(name) {
    if (name === 'MCP_ALLOWED_ORIGINS') return 'https://agent.example.invalid';
    throw new Error('MCP_CLIENT_FIXTURE_CONFIG_KEY_FORBIDDEN');
  },
});

const unavailableTools = new Proxy(Object.create(null), {
  get() {
    return async () => {
      throw new Error('MCP_CLIENT_FIXTURE_TOOL_CALL_FORBIDDEN');
    };
  },
});

let server;
let transport;
let closing;

try {
  const runtime = new McpRuntimeService(config, unavailableTools);
  const innerTransport = new StdioServerTransport();
  transport = new McpAuthenticatedStdioTransport(
    innerTransport,
    async () => authInfo,
  );
  server = await runtime.connect(transport);
} catch {
  process.stderr.write('MCP_CLIENT_FIXTURE_START_FAILED\n');
  process.exitCode = 1;
}

/** 关闭只读目录夹具，不向协议通道输出运行日志。 */
const close = async () => {
  if (closing !== undefined) return closing;
  closing = Promise.allSettled([
    server?.close(),
    transport?.close(),
  ]).then(() => undefined);
  return closing;
};

process.stdin.once('end', () => {
  void close();
});
process.once('SIGINT', () => {
  void close().finally(() => {
    process.exitCode = 130;
  });
});
process.once('SIGTERM', () => {
  void close().finally(() => {
    process.exitCode = 143;
  });
});
