import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { catalog as expectedCatalog } from '../../../scripts/mcp/validate-phase-5-mcp-catalog.mjs';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const entryFile = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const port = 30_112;
const issuer = `http://127.0.0.1:${port}`;
const resource = `${issuer}/mcp`;
const clientId = 'local-mcp-smoke-client';
const credentialId = 'local-mcp-smoke-credential';
const clientSecret = randomBytes(32).toString('base64url');
const auditKey = randomBytes(32).toString('base64url');
const MCP_SMOKE_STABLE_READY_MS = 5_000;
const signingKey = generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}).toString();
const now = Date.now();

const serviceClients = [{
  clientId,
  clientName: '本地 MCP SDK 冒烟客户端',
  tenantId: 'local-smoke-tenant',
  actorId: 'local-smoke-agent',
  allowedScopes: ['erp:mcp:server:connect'],
  allowedResources: [resource],
  roleCodes: ['service-reader'],
  departmentIds: [],
  status: 'active',
  authentication: {
    method: 'client_secret_basic',
    credentials: [{
      credentialId,
      secretSha256: createHash('sha256').update(clientSecret).digest('base64url'),
      notBefore: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1_000).toISOString(),
      status: 'active',
    }],
  },
}];

const environment = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(port),
  MONGODB_URI:
    process.env.GAOQ_SMOKE_MONGODB_URI ??
    'mongodb://127.0.0.1:27020/gaoq_sdk_smoke?replicaSet=rs0&directConnection=true',
  REDIS_URL: process.env.GAOQ_SMOKE_REDIS_URL ?? 'redis://127.0.0.1:6391/1',
  WEB_ORIGIN: 'http://127.0.0.1:3010',
  LOG_LEVEL: 'warn',
  AUTH_ISSUER: issuer,
  AUTH_AUDIENCE: 'gaoq-erp',
  AUTH_RESOURCE: resource,
  AUTH_JWKS_URI: `${issuer}/.well-known/jwks.json`,
  AUTH_SIGNING_PRIVATE_KEY_BASE64: Buffer.from(signingKey).toString('base64'),
  AUTH_SIGNING_KEY_ID: 'local-mcp-smoke-signing',
  AUDIT_INTEGRITY_KEYS: JSON.stringify({
    activeKeyId: 'local-mcp-smoke-audit',
    keys: [{
      keyId: 'local-mcp-smoke-audit',
      keyBase64url: auditKey,
      status: 'active',
    }],
  }),
  MCP_AUTHORIZATION_SERVER: issuer,
  MCP_ALLOWED_ORIGINS: 'http://127.0.0.1:3010',
  MCP_OAUTH_CLIENTS_JSON: '[]',
  MCP_SERVICE_CLIENTS_JSON: JSON.stringify(serviceClients),
};

const logs = [];
const api = spawn(process.execPath, [entryFile], {
  cwd: apiRoot,
  env: environment,
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [api.stdout, api.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    logs.push(...String(chunk).split('\n').filter(Boolean));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  });
}

try {
  await waitUntilReady(api);
  const token = await issueToken();
  await verifyMcpSdk(token);
  process.stdout.write('真实 OAuth Client Credentials + 官方 MCP SDK 冒烟验证通过。\n');
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(
    `MCP 实测失败：${reason}\nAPI 最近日志：\n${logs.slice(-20).join('\n')}`,
    { cause: error },
  );
} finally {
  await stopChild(api);
}

/**
 * 等待 API 就绪，子进程提前退出时仅返回经过边界截断的非敏感日志。
 *
 * @param {import('node:child_process').ChildProcess} child - API 子进程。
 * @returns {Promise<void>}
 */
async function waitUntilReady(child) {
  const deadline = Date.now() + 30_000;
  let readySince;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`MCP 冒烟 API 提前退出：${logs.slice(-20).join('\n')}`);
    }
    try {
      const response = await globalThis.fetch(`${issuer}/api/health/ready`, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        readySince ??= Date.now();
        if (Date.now() - readySince >= MCP_SMOKE_STABLE_READY_MS) return;
      } else {
        readySince = undefined;
      }
    } catch {
      // API 正在启动；固定短间隔重试，不回显连接错误。
      readySince = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`MCP 冒烟 API 就绪超时：${logs.slice(-20).join('\n')}`);
}

/**
 * 使用只存摘要的 Basic 凭据换取资源绑定访问令牌。
 *
 * @returns {Promise<string>} 访问令牌。
 */
async function issueToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    resource,
    scope: 'erp:mcp:server:connect',
  });
  const response = await globalThis.fetch(`${issuer}/api/auth/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: globalThis.AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, `OAuth token 端点返回 ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.token_type, 'Bearer');
  assert.equal(payload.scope, 'erp:mcp:server:connect');
  assert.equal(typeof payload.access_token, 'string');
  assert.ok(payload.access_token.length > 100);
  return payload.access_token;
}

/**
 * 使用官方 SDK 完成 initialize 与四类目录发现，并验证 R3 能力未暴露。
 *
 * @param {string} token - OAuth 访问令牌。
 * @returns {Promise<void>}
 */
async function verifyMcpSdk(token) {
  const client = new Client({ name: 'gaoq-live-smoke', version: '1.0.0' });
  const authorizedFetch = async (input, init) => {
    const headers = new globalThis.Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('origin', 'http://127.0.0.1:3010');
    return globalThis.fetch(input, { ...init, headers });
  };
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    fetch: authorizedFetch,
  });
  try {
    await client.connect(transport);
    const [tools, resources, templates, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);
    assert.deepEqual(
      tools.tools.map(({ name }) => name).sort(),
      expectedCatalog.tools.map(({ name }) => name).sort(),
      '运行时 Tool 目录与受控目录不一致',
    );
    assert.deepEqual(
      resources.resources.map(({ name, uri }) => `${name}\0${uri}`).sort(),
      expectedCatalog.resources.map(({ name, uri }) => `${name}\0${uri}`).sort(),
      '运行时 Resource 目录与受控目录不一致',
    );
    assert.deepEqual(
      templates.resourceTemplates.map(({ name, uriTemplate }) =>
        `${name}\0${uriTemplate}`).sort(),
      expectedCatalog.resourceTemplates.map(({ name, uriTemplate }) =>
        `${name}\0${uriTemplate}`).sort(),
      '运行时 Resource Template 目录与受控目录不一致',
    );
    assert.deepEqual(
      prompts.prompts.map(({ name }) => name).sort(),
      expectedCatalog.prompts.map(({ name }) => name).sort(),
      '运行时 Prompt 目录与受控目录不一致',
    );
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    for (const forbidden of [
      'treasury_disbursement_submit',
      'treasury_bank_account_attest',
      'payroll_tax_filing_submit',
      'payroll_period_lock',
    ]) {
      assert.equal(toolNames.has(forbidden), false, `MCP 暴露了 R3 工具 ${forbidden}`);
    }
    assert.ok(client.getServerCapabilities()?.extensions?.[
      'io.modelcontextprotocol/oauth-client-credentials'
    ] !== undefined);
  } finally {
    await client.close();
  }
}

/**
 * 优雅终止本脚本创建的 API 子进程。
 *
 * @param {import('node:child_process').ChildProcess} child - API 子进程。
 * @returns {Promise<void>}
 */
async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
