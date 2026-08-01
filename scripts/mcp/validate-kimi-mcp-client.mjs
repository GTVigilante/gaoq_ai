import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { catalog } from './validate-phase-5-mcp-catalog.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = fileURLToPath(
  new URL('../../apps/erp-api/scripts/mcp-catalog-stdio-fixture.mjs', import.meta.url),
);
const EXPECTED_TOOL_COUNT = catalog.tools.length;
const REQUEST_TIMEOUT_MS = 30_000;

/** 通过 Kimi ACP 的本地 `/mcp` 命令验证真实客户端目录发现，不调用模型。 */
async function run() {
  const executable = process.env.KIMI_EXECUTABLE?.trim() || 'kimi';
  const version = await readVersion(executable);
  const client = new AcpClient(executable);
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'gaoq-mcp-compatibility-probe',
        title: 'GaoQ MCP 兼容性探针',
        version: '1.0.0',
      },
    });
    equal(initialized?.agentInfo?.name, 'Kimi Code CLI', 'KIMI_MCP_AGENT_INVALID');
    equal(initialized?.agentInfo?.version, version, 'KIMI_MCP_VERSION_MISMATCH');

    const created = await client.request('session/new', {
      cwd: ROOT,
      mcpServers: [{
        name: 'gaoq-erp',
        command: process.execPath,
        args: [FIXTURE],
        env: [],
      }],
    });
    if (typeof created?.sessionId !== 'string' || created.sessionId.length < 8) {
      fail('KIMI_MCP_SESSION_INVALID');
    }

    const statusText = await waitForMcpStatus(client, created.sessionId);
    const summary = parseMcpStatus(statusText);
    process.stdout.write(`${JSON.stringify({
      formatVersion: 1,
      suite: 'gaoq.mcp.client.kimi.v1',
      source: Object.freeze({ catalogHash: catalog.catalogHash }),
      client: Object.freeze({ name: 'Kimi Code CLI', version }),
      transport: 'stdio-via-acp',
      server: 'gaoq-erp',
      serverConnected: summary.serverConnected,
      toolCount: summary.toolCount,
      modelInvoked: false,
    }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

/** 等待 Kimi 异步完成 MCP 启动和工具发现，仅重复本地 `/mcp` 状态命令。 */
async function waitForMcpStatus(client, sessionId) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const notificationStart = client.notifications.length;
    await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/mcp' }],
    });
    const statusText = extractAgentText(
      client.notifications.slice(notificationStart),
      sessionId,
    );
    const state = readServerState(statusText);
    if (state === 'connected') return statusText;
    if (state === 'failed') fail('KIMI_MCP_CLIENT_CONNECTION_FAILED');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail('KIMI_MCP_CLIENT_CONNECTION_TIMEOUT');
}

/** 读取实体客户端版本，拒绝异常或带控制字符的输出。 */
async function readVersion(executable) {
  const child = spawn(executable, ['--version'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const output = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) fail('KIMI_MCP_CLIENT_UNAVAILABLE');
  const version = output.join('').trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
    fail('KIMI_MCP_VERSION_INVALID');
  }
  return version;
}

/** 从 ACP 通知提取本地 `/mcp` 的低敏文本响应。 */
function extractAgentText(notifications, sessionId) {
  const chunks = [];
  for (const message of notifications) {
    if (message?.method !== 'session/update' || message.params?.sessionId !== sessionId) continue;
    const update = message.params.update;
    if (update?.sessionUpdate !== 'agent_message_chunk') continue;
    if (update.content?.type === 'text' && typeof update.content.text === 'string') {
      chunks.push(update.content.text);
    }
  }
  if (chunks.length === 0) fail('KIMI_MCP_STATUS_RESPONSE_MISSING');
  return chunks.join('');
}

/** 解析 Kimi 当前 `/mcp` 状态文本，只保留连接结论和目录数量。 */
function parseMcpStatus(text) {
  if (typeof text !== 'string' || text.length < 10 || text.length > 256 * 1_024) {
    fail('KIMI_MCP_STATUS_RESPONSE_INVALID');
  }
  if (readServerState(text) !== 'connected') fail('KIMI_MCP_CLIENT_NOT_CONNECTED');
  const counts = [
    ...text.matchAll(/\b(?:Tools?|工具)\s*(?:\(|:)?\s*(\d{1,4})\b/giu),
    ...text.matchAll(/\b(\d{1,4})\s*(?:Tools?|工具)\b/giu),
  ].map((match) => Number(match[1]));
  if (!counts.includes(EXPECTED_TOOL_COUNT)) fail('KIMI_MCP_TOOL_COUNT_INVALID');
  return Object.freeze({ serverConnected: true, toolCount: EXPECTED_TOOL_COUNT });
}

/** 读取指定服务器的低敏状态，拒绝未知输出。 */
function readServerState(text) {
  const serverLine = text.split('\n').find((line) => line.includes('gaoq-erp'));
  if (serverLine === undefined) fail('KIMI_MCP_STATUS_RESPONSE_INVALID');
  if (/\bconnected\b/iu.test(serverLine)) return 'connected';
  if (/\bfailed\b/iu.test(serverLine)) return 'failed';
  if (/\b(?:pending|connecting)\b/iu.test(serverLine)) return 'pending';
  fail('KIMI_MCP_STATUS_RESPONSE_INVALID');
}

class AcpClient {
  constructor(executable) {
    this.child = spawn(executable, ['acp'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.notifications = [];
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = [];
    this.closed = false;
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr.push(String(chunk).replaceAll(ROOT, '<workspace>'));
      if (this.stderr.length > 20) this.stderr.splice(0, this.stderr.length - 20);
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    this.child.once('error', () => this.rejectAll('KIMI_MCP_CLIENT_START_FAILED'));
    this.child.once('exit', () => this.rejectAll('KIMI_MCP_CLIENT_EXITED'));
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('KIMI_MCP_CLIENT_CLOSED'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('KIMI_MCP_CLIENT_TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id, method, params,
      })}\n`);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    const exited = await Promise.race([
      new Promise((resolve) => this.child.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    if (!exited) this.child.kill('SIGTERM');
    this.rejectAll('KIMI_MCP_CLIENT_CLOSED');
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.rejectAll('KIMI_MCP_PROTOCOL_INVALID');
      return;
    }
    if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') ||
        Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error !== undefined) {
        pending.reject(new Error(`KIMI_MCP_ACP_ERROR_${Number(message.error.code) || 'UNKNOWN'}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message?.method === 'string' && !Object.hasOwn(message, 'id')) {
      this.notifications.push(message);
      return;
    }
    if (typeof message?.method === 'string' && Object.hasOwn(message, 'id')) {
      this.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32_601, message: 'Method not supported by compatibility probe' },
      })}\n`);
    }
  }

  rejectAll(code) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(code));
    }
    this.pending.clear();
  }
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function expectFailure(operation, code) {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message === code) return;
    throw error;
  }
  fail(`EXPECTED_${code}`);
}

function fail(code) {
  throw new Error(code);
}

if (process.argv.length !== 3) fail('KIMI_MCP_ARGUMENT_INVALID');
equal(catalog.tools.length, EXPECTED_TOOL_COUNT, 'KIMI_MCP_CATALOG_TOOL_COUNT_INVALID');
if (process.argv[2] === '--self-test') {
  const summary = parseMcpStatus([
    'MCP servers (1):',
    '- gaoq-erp (connected)',
    `  Tools (${EXPECTED_TOOL_COUNT}): get_my_permissions, approval_get_inbox`,
  ].join('\n'));
  equal(summary.serverConnected, true, 'KIMI_MCP_SELF_TEST_SERVER_MISSING');
  equal(summary.toolCount, EXPECTED_TOOL_COUNT, 'KIMI_MCP_SELF_TEST_TOOL_COUNT_INVALID');
  equal(
    parseMcpStatus(
      `MCP servers (1):\n- gaoq-erp: connected (stdio, ${EXPECTED_TOOL_COUNT} tools)`,
    ).toolCount,
    EXPECTED_TOOL_COUNT,
    'KIMI_MCP_SELF_TEST_CURRENT_FORMAT_INVALID',
  );
  equal(
    readServerState('MCP servers (1):\n- gaoq-erp: pending (stdio, 0 tools)'),
    'pending',
    'KIMI_MCP_SELF_TEST_PENDING_INVALID',
  );
  expectFailure(
    () => parseMcpStatus('MCP servers (1):\n- gaoq-erp (failed)'),
    'KIMI_MCP_CLIENT_NOT_CONNECTED',
  );
  expectFailure(
    () => parseMcpStatus('MCP servers (1):\n- gaoq-erp: connected (stdio, 46 tools)'),
    'KIMI_MCP_TOOL_COUNT_INVALID',
  );
  process.stdout.write('Kimi MCP 实体客户端探针自测通过。\n');
} else if (process.argv[2] === '--run') {
  await run();
} else {
  fail('KIMI_MCP_ARGUMENT_INVALID');
}
