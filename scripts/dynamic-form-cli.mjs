#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const TOKEN = /^[A-Za-z0-9._~-]{40,4096}$/u;

const fail = (code, detail) => {
  process.stderr.write(`${code}${detail === undefined ? '' : `: ${detail}`}\n`);
  process.exitCode = 1;
};

const help = () => process.stdout.write(`GaoQ 动态数据 CLI

环境变量：
  GAOQ_API_ORIGIN     ERP API 根地址，例如 https://aio.gaoq.com
  GAOQ_ACCESS_TOKEN   由身份服务签发的短时访问令牌

命令：
  forms list
  records list   --form <ULID> [--limit 1..200]
  records get    --form <ULID> --record <ULID>
  records create --form <ULID> --file <values.json> --key <Idempotency-Key>
  records bulk   --form <ULID> --file <items.json>  --key <Idempotency-Key>
  records update --form <ULID> --record <ULID> --version <n> --file <values.json> --key <Idempotency-Key>
`);

const parseOptions = (args, allowed) => {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (typeof name !== 'string' || !name.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('CLI_ARGUMENT_INVALID');
    const key = name.slice(2);
    if (!allowed.has(key) || options.has(key)) throw new Error('CLI_ARGUMENT_INVALID');
    options.set(key, value);
  }
  return options;
};

const required = (options, name, pattern, code) => {
  const value = options.get(name);
  if (value === undefined || !pattern.test(value)) throw new Error(code);
  return value;
};

const readJson = async (path) => {
  if (path.length > 1_024 || path.includes('\0')) throw new Error('CLI_FILE_INVALID');
  const bytes = await readFile(path);
  if (bytes.byteLength > 8 * 1_024 * 1_024) throw new Error('CLI_FILE_TOO_LARGE');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('CLI_JSON_OBJECT_REQUIRED');
  return value;
};

const config = () => {
  const rawOrigin = process.env.GAOQ_API_ORIGIN;
  const token = process.env.GAOQ_ACCESS_TOKEN;
  if (rawOrigin === undefined || token === undefined || !TOKEN.test(token)) throw new Error('CLI_ENV_INVALID');
  const origin = new URL(rawOrigin);
  const local = ['localhost', '127.0.0.1', '::1'].includes(origin.hostname);
  if ((!local && origin.protocol !== 'https:') || (local && !['http:', 'https:'].includes(origin.protocol)) || origin.username !== '' || origin.password !== '' || origin.search !== '' || origin.hash !== '' || !['', '/'].includes(origin.pathname)) throw new Error('CLI_API_ORIGIN_INVALID');
  return { origin: origin.origin, token };
};

const request = async (path, init = {}) => {
  const { origin, token } = config();
  const response = await fetch(`${origin}/api${path}`, {
    ...init,
    redirect: 'error',
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...init.headers },
  });
  const traceId = response.headers.get('x-trace-id');
  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(body.code)) code = body.code;
    } catch {}
    throw new Error(`${code}${traceId === null ? '' : `:${traceId}`}`);
  }
  return response.json();
};

const main = async () => {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === '--') argumentsList.shift();
  const [resource, action, ...tail] = argumentsList;
  if (resource === undefined || ['help', '--help', '-h'].includes(resource)) return help();
  if (resource === 'forms' && action === 'list' && tail.length === 0) return print(await request('/dynamic-forms'));
  if (resource !== 'records' || !['list', 'get', 'create', 'bulk', 'update'].includes(action ?? '')) throw new Error('CLI_COMMAND_INVALID');

  const allowed = new Set(action === 'list' ? ['form', 'limit'] : action === 'get' ? ['form', 'record'] : action === 'update' ? ['form', 'record', 'version', 'file', 'key'] : ['form', 'file', 'key']);
  const options = parseOptions(tail, allowed);
  const form = required(options, 'form', ULID, 'CLI_FORM_ID_INVALID');
  if (action === 'list') {
    const limit = options.get('limit') ?? '100';
    if (!/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/u.test(limit)) throw new Error('CLI_LIMIT_INVALID');
    return print(await request(`/dynamic-forms/${form}/records?limit=${limit}`));
  }
  const record = action === 'get' || action === 'update' ? required(options, 'record', ULID, 'CLI_RECORD_ID_INVALID') : null;
  if (action === 'get') return print(await request(`/dynamic-forms/${form}/records/${record}`));

  const file = required(options, 'file', /^.{1,1024}$/u, 'CLI_FILE_REQUIRED');
  const key = required(options, 'key', KEY, 'CLI_IDEMPOTENCY_KEY_INVALID');
  const json = await readJson(file);
  const headers = { 'content-type': 'application/json', 'idempotency-key': key };
  if (action === 'create') return print(await request(`/dynamic-forms/${form}/records`, { method: 'POST', headers, body: JSON.stringify({ values: json }) }));
  if (action === 'bulk') return print(await request(`/dynamic-forms/${form}/records/bulk`, { method: 'POST', headers, body: JSON.stringify(json) }));
  const version = required(options, 'version', /^[1-9][0-9]*$/u, 'CLI_VERSION_INVALID');
  const numericVersion = Number(version);
  if (!Number.isSafeInteger(numericVersion) || numericVersion >= Number.MAX_SAFE_INTEGER) throw new Error('CLI_VERSION_INVALID');
  return print(await request(`/dynamic-forms/${form}/records/${record}`, { method: 'PUT', headers: { ...headers, 'if-match': `"${version}"` }, body: JSON.stringify({ values: json }) }));
};

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

main().catch((error) => fail(error instanceof Error && /^[A-Z][A-Z0-9_]*(?::[A-Za-z0-9._:-]+)?$/u.test(error.message) ? error.message : 'CLI_REQUEST_FAILED'));
