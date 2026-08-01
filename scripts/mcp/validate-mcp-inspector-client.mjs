import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { catalog } from './validate-phase-5-mcp-catalog.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = fileURLToPath(
  new URL('../../apps/erp-api/scripts/mcp-catalog-stdio-fixture.mjs', import.meta.url),
);
const INSPECTOR_LAUNCHER = fileURLToPath(new URL(
  '../../tools/mcp-inspector-client/node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js',
  import.meta.url,
));
const INSPECTOR_PACKAGE = fileURLToPath(new URL(
  '../../tools/mcp-inspector-client/node_modules/@modelcontextprotocol/inspector/package.json',
  import.meta.url,
));
const EXPECTED_INSPECTOR_VERSION = '2.0.0';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const METHODS = Object.freeze([
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

/** 使用锁定版本的官方 Inspector CLI 验证四类 MCP 目录，不读取业务内容。 */
async function run() {
  assertNodeVersion();
  const version = await readInspectorVersion();
  const results = new Map();
  for (const method of METHODS) {
    results.set(method, parseInspectorOutput(method, await executeInspector(method)));
  }
  validateInspectorResults(results);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.mcp.client.inspector.v1',
    source: Object.freeze({
      catalogHash: catalog.catalogHash,
      runtimeContractHash: catalog.runtimeContractHash,
    }),
    client: Object.freeze({ name: 'MCP Inspector CLI', version }),
    transport: 'stdio',
    server: 'gaoq-erp',
    serverConnected: true,
    counts: Object.freeze({
      tools: catalog.tools.length,
      resources: catalog.resources.length,
      resourceTemplates: catalog.resourceTemplates.length,
      prompts: catalog.prompts.length,
    }),
    methods: METHODS,
    businessToolInvoked: false,
    resourceContentRead: false,
    promptRendered: false,
    modelInvoked: false,
  }, null, 2)}\n`);
}

/** 执行 Inspector 单一目录方法，限制环境、时间和输出大小。 */
async function executeInspector(method) {
  const child = spawn(
    process.execPath,
    [
      INSPECTOR_LAUNCHER,
      '--cli',
      process.execPath,
      FIXTURE,
      '--method',
      method,
    ],
    {
      cwd: ROOT,
      env: minimalEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdout = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      child.kill('SIGTERM');
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR_BYTES) child.kill('SIGTERM');
  });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('MCP_INSPECTOR_CLIENT_TIMEOUT'));
    }, REQUEST_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  }).catch(() => fail('MCP_INSPECTOR_CLIENT_START_FAILED'));
  if (stdoutBytes > MAX_STDOUT_BYTES) fail('MCP_INSPECTOR_STDOUT_TOO_LARGE');
  if (stderrBytes > MAX_STDERR_BYTES) fail('MCP_INSPECTOR_STDERR_TOO_LARGE');
  if (code !== 0) fail('MCP_INSPECTOR_CLIENT_FAILED');
  return Buffer.concat(stdout).toString('utf8');
}

/** 只向 Inspector 与目录夹具提供启动必需的非敏感环境。 */
function minimalEnvironment() {
  const environment = {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  };
  for (const name of ['PATH', 'TMPDIR', 'TMP', 'TEMP']) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) environment[name] = value;
  }
  return environment;
}

/** 从锁定依赖元数据读取精确客户端版本，禁止依赖 latest。 */
async function readInspectorVersion() {
  let document;
  try {
    document = JSON.parse(await readFile(INSPECTOR_PACKAGE, 'utf8'));
  } catch {
    fail('MCP_INSPECTOR_PACKAGE_INVALID');
  }
  if (document?.name !== '@modelcontextprotocol/inspector' ||
      document.version !== EXPECTED_INSPECTOR_VERSION) {
    fail('MCP_INSPECTOR_VERSION_INVALID');
  }
  return document.version;
}

/** 解析 Inspector 的机器可读 JSON，拒绝夹杂 banner 或非目录响应。 */
function parseInspectorOutput(method, text) {
  if (typeof text !== 'string' || text.length < 2 || text.length > MAX_STDOUT_BYTES) {
    fail('MCP_INSPECTOR_OUTPUT_INVALID');
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    fail('MCP_INSPECTOR_OUTPUT_INVALID');
  }
  const field = Object.freeze({
    'tools/list': 'tools',
    'resources/list': 'resources',
    'resources/templates/list': 'resourceTemplates',
    'prompts/list': 'prompts',
  })[method];
  if (field === undefined || !Array.isArray(document?.[field])) {
    fail('MCP_INSPECTOR_DIRECTORY_INVALID');
  }
  return document[field];
}

/** 将 Inspector 实际目录与确定性完整目录逐字段比对。 */
function validateInspectorResults(results) {
  equalJson(
    sortedNames(results.get('tools/list')),
    sortedNames(catalog.tools),
    'MCP_INSPECTOR_TOOL_CATALOG_MISMATCH',
  );
  equalJson(
    normalizeResources(results.get('resources/list'), 'uri'),
    normalizeResources(catalog.resources, 'uri'),
    'MCP_INSPECTOR_RESOURCE_CATALOG_MISMATCH',
  );
  equalJson(
    normalizeResources(results.get('resources/templates/list'), 'uriTemplate'),
    normalizeResources(catalog.resourceTemplates, 'uriTemplate'),
    'MCP_INSPECTOR_RESOURCE_TEMPLATE_CATALOG_MISMATCH',
  );
  equalJson(
    normalizePrompts(results.get('prompts/list')),
    normalizePrompts(catalog.prompts),
    'MCP_INSPECTOR_PROMPT_CATALOG_MISMATCH',
  );
}

function sortedNames(items) {
  if (!Array.isArray(items)) fail('MCP_INSPECTOR_DIRECTORY_INVALID');
  const names = items.map((item) => item?.name);
  if (names.some((name) => typeof name !== 'string') ||
      new Set(names).size !== names.length) {
    fail('MCP_INSPECTOR_DIRECTORY_NAME_INVALID');
  }
  return names.toSorted();
}

function normalizeResources(items, locator) {
  if (!Array.isArray(items)) fail('MCP_INSPECTOR_DIRECTORY_INVALID');
  const normalized = items.map((item) => {
    if (typeof item?.name !== 'string' || typeof item?.[locator] !== 'string' ||
        typeof item?.mimeType !== 'string') {
      fail('MCP_INSPECTOR_RESOURCE_INVALID');
    }
    return { name: item.name, [locator]: item[locator], mimeType: item.mimeType };
  }).toSorted((left, right) => left.name.localeCompare(right.name, 'en'));
  if (new Set(normalized.map((item) => item.name)).size !== normalized.length) {
    fail('MCP_INSPECTOR_DIRECTORY_NAME_INVALID');
  }
  return normalized;
}

function normalizePrompts(items) {
  if (!Array.isArray(items)) fail('MCP_INSPECTOR_DIRECTORY_INVALID');
  const normalized = items.map((item) => {
    if (typeof item?.name !== 'string') fail('MCP_INSPECTOR_PROMPT_INVALID');
    const arguments_ = item.arguments ?? [];
    if (!Array.isArray(arguments_)) fail('MCP_INSPECTOR_PROMPT_INVALID');
    const names = arguments_.map((argument) =>
      typeof argument === 'string' ? argument : argument?.name);
    if (names.some((name) => typeof name !== 'string') ||
        new Set(names).size !== names.length) {
      fail('MCP_INSPECTOR_PROMPT_INVALID');
    }
    return { name: item.name, arguments: names.toSorted() };
  }).toSorted((left, right) => left.name.localeCompare(right.name, 'en'));
  if (new Set(normalized.map((item) => item.name)).size !== normalized.length) {
    fail('MCP_INSPECTOR_DIRECTORY_NAME_INVALID');
  }
  return normalized;
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) fail('MCP_INSPECTOR_NODE_VERSION_INVALID');
}

function validResults() {
  return new Map([
    ['tools/list', catalog.tools.map((item) => ({ name: item.name }))],
    ['resources/list', catalog.resources.map((item) => ({ ...item }))],
    ['resources/templates/list', catalog.resourceTemplates.map((item) => ({ ...item }))],
    ['prompts/list', catalog.prompts.map((item) => ({
      name: item.name,
      arguments: item.arguments.map((name) => ({ name })),
    }))],
  ]);
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

function equalJson(actual, expected, code) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code);
}

function fail(code) {
  throw new Error(code);
}

if (process.argv.length !== 3) fail('MCP_INSPECTOR_ARGUMENT_INVALID');
if (process.argv[2] === '--self-test') {
  validateInspectorResults(validResults());
  const missingTool = validResults();
  missingTool.get('tools/list').pop();
  expectFailure(
    () => validateInspectorResults(missingTool),
    'MCP_INSPECTOR_TOOL_CATALOG_MISMATCH',
  );
  const duplicateResource = validResults();
  duplicateResource.get('resources/list').push(duplicateResource.get('resources/list')[0]);
  expectFailure(
    () => validateInspectorResults(duplicateResource),
    'MCP_INSPECTOR_DIRECTORY_NAME_INVALID',
  );
  const changedTemplate = validResults();
  changedTemplate.get('resources/templates/list')[0].uriTemplate = 'erp://invalid/{id}';
  expectFailure(
    () => validateInspectorResults(changedTemplate),
    'MCP_INSPECTOR_RESOURCE_TEMPLATE_CATALOG_MISMATCH',
  );
  const changedPrompt = validResults();
  changedPrompt.get('prompts/list')[0].arguments = [{ name: 'unexpected' }];
  expectFailure(
    () => validateInspectorResults(changedPrompt),
    'MCP_INSPECTOR_PROMPT_CATALOG_MISMATCH',
  );
  expectFailure(
    () => parseInspectorOutput('tools/list', 'Inspector banner\n{}'),
    'MCP_INSPECTOR_OUTPUT_INVALID',
  );
  process.stdout.write('MCP Inspector 实体客户端探针自测通过。\n');
} else if (process.argv[2] === '--run') {
  await run();
} else {
  fail('MCP_INSPECTOR_ARGUMENT_INVALID');
}
