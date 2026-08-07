import { randomBytes } from 'node:crypto';
import { chown, lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

const [runtimeDirectory, releaseTag] = process.argv.slice(2);
if (runtimeDirectory === undefined || !isAbsolute(runtimeDirectory)) {
  throw new Error('PAYROLL_RUNTIME_DIRECTORY_MUST_BE_ABSOLUTE');
}
if (releaseTag === undefined || !/^\d{8}-[a-f0-9]{12}$/u.test(releaseTag)) {
  throw new Error('PAYROLL_RELEASE_TAG_INVALID');
}
if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  throw new Error('PAYROLL_RUNTIME_GENERATOR_REQUIRES_ROOT_FOR_MONGO_KEYFILE');
}

const protectedFiles = [
  'api.env', 'worker.env', 'web.env', 'mongo.env', 'compose.env', 'mongo-keyfile',
];
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
for (const fileName of protectedFiles) {
  try {
    await lstat(join(runtimeDirectory, fileName));
    throw new Error(`PAYROLL_RUNTIME_FILE_ALREADY_EXISTS:${fileName}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PAYROLL_RUNTIME_FILE_ALREADY_EXISTS:')) {
      throw error;
    }
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

const date = releaseTag.slice(0, 8);
const rootUsername = 'payroll-root';
const applicationUsername = 'payroll-app';
const rootPassword = secret(36);
const applicationPassword = secret(36);
const database = 'gaoq_payroll';
const encodedUsername = encodeURIComponent(applicationUsername);
const encodedPassword = encodeURIComponent(applicationPassword);

const apiEnvironment = lines({
  MONGODB_URI: `mongodb://${encodedUsername}:${encodedPassword}@payroll-mongo:27017/${database}?authSource=${database}&replicaSet=payroll-rs0`,
  WEB_ORIGIN: 'https://payroll.gaoq.com',
  AUTH_ISSUER: 'https://aio.gaoq.com',
  AUTH_AUDIENCE: 'gaoq-payroll',
  AUTH_RESOURCE: 'https://payroll.gaoq.com/api/payroll/v1',
  AUTH_JWKS_URI: 'https://aio.gaoq.com/.well-known/jwks.json',
  MCP_ALLOWED_ORIGINS: 'https://payroll.gaoq.com',
  PAYROLL_DATA_ENCRYPTION_KEYS: keyRing(`payroll-data-${date}-001`),
  PAYROLL_BLIND_INDEX_KEYS: keyRing(`payroll-blind-${date}-001`),
});
const workerEnvironment = lines({
  MASTER_DATA_SYNC_ENABLED: 'false',
  MASTER_DATA_SYNC_INTERVAL_MS: '300000',
  GAOQ_OAUTH_TOKEN_URL: 'https://aio.gaoq.com/api/auth/oauth/token',
  GAOQ_SYNC_CLIENT_ID: '',
  GAOQ_SYNC_CLIENT_SECRET: '',
  GAOQ_ERP_RESOURCE: 'https://aio.gaoq.com/mcp',
  GAOQ_PAYROLL_RESOURCE: 'https://payroll.gaoq.com/api/payroll/v1',
  GAOQ_ERP_API_URL: 'https://aio.gaoq.com',
  PAYROLL_API_URL: 'http://payroll-api:3101',
});
const webEnvironment = lines({
  GAOQ_AUTHORIZATION_ENDPOINT: 'https://aio.gaoq.com/api/auth/oauth/authorize',
  GAOQ_TOKEN_ENDPOINT: 'https://aio.gaoq.com/api/auth/oauth/token',
  GAOQ_PAYROLL_CLIENT_ID: 'payroll-web-production',
  GAOQ_PAYROLL_REDIRECT_URI: 'https://payroll.gaoq.com/api/auth/callback',
  AUTH_RESOURCE: 'https://payroll.gaoq.com/api/payroll/v1',
  GAOQ_PAYROLL_SCOPES: 'erp:payroll:payslip:self',
});
const mongoEnvironment = lines({
  MONGO_INITDB_ROOT_USERNAME: rootUsername,
  MONGO_INITDB_ROOT_PASSWORD: rootPassword,
  MONGO_INITDB_DATABASE: database,
  PAYROLL_MONGO_APP_USERNAME: applicationUsername,
  PAYROLL_MONGO_APP_PASSWORD: applicationPassword,
});
const composeEnvironment = lines({
  PAYROLL_RUNTIME_DIR: runtimeDirectory,
  PAYROLL_MONGO_IMAGE: 'mongo:7.0@sha256:35a5926f71f8b6cb19206bee928c5a85f241a8be99f20c81abe35ae78a73415d',
  PAYROLL_REDIS_IMAGE: 'redis:7.2-alpine@sha256:05a97a479bc73de66f087dc05b569010772880f778cc8671fa6b8aadee32e5c6',
  PAYROLL_API_IMAGE: `gaoq-payroll/api:${releaseTag}`,
  PAYROLL_WORKER_IMAGE: `gaoq-payroll/worker:${releaseTag}`,
  PAYROLL_WEB_IMAGE: `gaoq-payroll/web:${releaseTag}`,
  PAYROLL_API_PORT: '3211',
  PAYROLL_WEB_PORT: '3210',
});

for (const [fileName, value, mode] of [
  ['api.env', apiEnvironment, 0o600],
  ['worker.env', workerEnvironment, 0o600],
  ['web.env', webEnvironment, 0o600],
  ['mongo.env', mongoEnvironment, 0o600],
  ['compose.env', composeEnvironment, 0o600],
  ['mongo-keyfile', `${randomBytes(512).toString('base64')}\n`, 0o400],
]) {
  const target = join(runtimeDirectory, fileName);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, value, { mode, flag: 'wx' });
  await rename(temporary, target);
  if (fileName === 'mongo-keyfile') {
    // MongoDB 官方镜像以固定 999:999 身份运行，KeyFile 必须仅由该身份读取。
    await chown(target, 999, 999);
  }
}

process.stdout.write(`算薪生产运行时已生成：${runtimeDirectory}\n`);

function secret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function keyRing(keyId) {
  return JSON.stringify([{ keyId, keyBase64: randomBytes(32).toString('base64'), status: 'active' }]);
}

function lines(values) {
  return `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`;
}
