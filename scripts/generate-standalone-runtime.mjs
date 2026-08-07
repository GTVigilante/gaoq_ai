import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const [runtimeDirectory, releaseTag] = process.argv.slice(2);
if (runtimeDirectory === undefined || !isAbsolute(runtimeDirectory)) {
  throw new Error('RUNTIME_DIRECTORY_MUST_BE_ABSOLUTE');
}
if (releaseTag === undefined || !/^\d{8}-[a-f0-9]{12}$/u.test(releaseTag)) {
  throw new Error('RELEASE_TAG_INVALID');
}

const protectedFiles = [
  'api.env',
  'web.env',
  'website.env',
  'compose.env',
  'payroll-sync.env',
];
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
for (const fileName of protectedFiles) {
  try {
    await lstat(join(runtimeDirectory, fileName));
    throw new Error(`RUNTIME_FILE_ALREADY_EXISTS:${fileName}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RUNTIME_FILE_ALREADY_EXISTS:')) throw error;
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

process.stdout.write('请输入目标 MongoDB URI（输入不会显示）：');
const mongodbUri = await readHiddenLine();
validateMongoUri(mongodbUri);

const date = releaseTag.slice(0, 8);
const signingKey = Buffer.from(
  generateKeyPairSync('rsa', {
    modulusLength: 2_048,
    publicExponent: 0x1_00_01,
  }).privateKey.export({ format: 'pem', type: 'pkcs8' }),
  'utf8',
).toString('base64');
const erpResource = 'https://aio.gaoq.com/mcp';
const payrollResource = 'https://payroll.gaoq.com/api/payroll/v1';
const portalSecret = secret();
const portalClientId = 'recruit-portal-001';
const payrollWebClientId = 'payroll-web-production';
const payrollSyncClientId = 'payroll-sync-production';
const payrollSyncSecret = secret();
const notBefore = new Date(Date.now() - 5 * 60 * 1_000).toISOString();
const expiresAt = new Date(Date.now() + 366 * 24 * 60 * 60 * 1_000).toISOString();
const serviceClients = JSON.stringify([
  {
    clientId: portalClientId,
    clientName: 'GaoQ 招聘门户',
    tenantId: 'tenant-gaoq',
    actorId: 'recruitment-portal',
    allowedScopes: [
      'erp:recruitment:portal:read',
      'erp:recruitment:application:create',
    ],
    allowedResources: [erpResource],
    roleCodes: ['recruitment-portal'],
    departmentIds: [],
    status: 'active',
    authentication: {
      method: 'client_secret_basic',
      credentials: [{
        credentialId: `recruit-portal-${date}-001`,
        secretSha256: createHash('sha256').update(portalSecret, 'utf8').digest('base64url'),
        notBefore,
        expiresAt,
        status: 'active',
      }],
    },
  },
  {
    clientId: payrollSyncClientId,
    clientName: 'GaoQ 专业算薪主数据同步',
    tenantId: 'tenant-gaoq',
    actorId: 'payroll-master-data-sync',
    allowedScopes: [
      'erp:payroll:master-data:read',
      'erp:payroll:master-data:sync',
    ],
    allowedResources: [erpResource, payrollResource],
    roleCodes: ['payroll-sync'],
    departmentIds: [],
    status: 'active',
    authentication: {
      method: 'client_secret_basic',
      credentials: [{
        credentialId: `payroll-sync-${date}-001`,
        secretSha256: createHash('sha256').update(payrollSyncSecret, 'utf8').digest('base64url'),
        notBefore,
        expiresAt,
        status: 'active',
      }],
    },
  },
]);
const oauthClients = JSON.stringify([{
  clientId: payrollWebClientId,
  clientName: 'GaoQ 专业算薪门户与 MCP',
  redirectUris: ['https://payroll.gaoq.com/api/auth/callback'],
  allowedScopes: [
    'erp:payroll:mcp:connect',
    'erp:payroll:payslip:self',
    'erp:payroll:period:read',
    'erp:payroll:reconciliation:read',
    'erp:payroll:tax:read',
  ],
  allowedResources: [payrollResource],
  tenantIds: ['tenant-gaoq'],
  status: 'active',
}]);

const apiEnvironment = lines({
  MONGODB_URI: mongodbUri,
  WEB_ORIGIN: 'https://aio.gaoq.com',
  MARKETING_WEBSITE_ORIGIN: 'https://www.gaoq.com',
  MARKETING_PUBLIC_TENANT_ID: 'tenant-gaoq',
  MARKETING_PUBLIC_SITE_ID: 'gaoq',
  MARKETING_LEAD_ENCRYPTION_KEY_BASE64: secret(),
  MARKETING_LEAD_BLIND_INDEX_KEY_BASE64: secret(),
  LOG_LEVEL: 'info',
  AUTH_ISSUER: 'https://aio.gaoq.com',
  AUTH_AUDIENCE: 'gaoq-erp',
  AUTH_RESOURCE: erpResource,
  AUTH_ADDITIONAL_RESOURCES_JSON: JSON.stringify([{
    resource: payrollResource,
    audience: 'gaoq-payroll',
  }]),
  AUTH_JWKS_URI: 'https://aio.gaoq.com/.well-known/jwks.json',
  AUTH_JWKS_FETCH_URI: 'http://127.0.0.1:3001/.well-known/jwks.json',
  AUTH_SIGNING_PRIVATE_KEY_BASE64: signingKey,
  AUTH_SIGNING_KEY_ID: `auth-${date}-001`,
  PAYROLL_SYSTEM_MODE: 'external',
  PAYROLL_WEB_ORIGIN: 'https://payroll.gaoq.com',
  AUDIT_INTEGRITY_KEYS: keyRing(`audit-${date}-001`),
  APPROVAL_DATA_ENCRYPTION_KEYS: keyRing(`approval-${date}-001`),
  RECRUITMENT_DATA_ENCRYPTION_KEYS: keyRing(`recruitment-${date}-001`),
  RECRUITMENT_BLIND_INDEX_KEYS: keyRing(`recruitment-blind-${date}-001`),
  RECRUITMENT_RESUME_AI_PROVIDER: 'disabled',
  ATTENDANCE_DATA_ENCRYPTION_KEYS: keyRing(`attendance-${date}-001`),
  ATTENDANCE_BLIND_INDEX_KEYS: keyRing(`attendance-blind-${date}-001`),
  PAYROLL_DATA_ENCRYPTION_KEYS: keyRing(`payroll-${date}-001`),
  TREASURY_DATA_ENCRYPTION_KEYS: keyRing(`treasury-${date}-001`),
  TREASURY_BLIND_INDEX_KEYS: keyRing(`treasury-blind-${date}-001`),
  ESIGN_WEBHOOK_ENCRYPTION_KEYS: keyRing(`esign-${date}-001`),
  ESIGN_API_BASE_URL: 'https://smlopenapi.esign.cn',
  OP_WEBHOOK_ENCRYPTION_KEYS: keyRing(`op-webhook-${date}-001`),
  OP_APPROVAL_WEBHOOK_ENCRYPTION_KEYS: keyRing(`op-approval-${date}-001`),
  METRICS_BEARER_TOKEN: secret(),
  MCP_AUTHORIZATION_SERVER: 'https://aio.gaoq.com',
  MCP_ALLOWED_ORIGINS: 'https://aio.gaoq.com',
  MCP_OAUTH_CLIENTS_JSON: oauthClients,
  MCP_SERVICE_CLIENTS_JSON: serviceClients,
});
const webEnvironment = lines({
  NEXT_PUBLIC_ERP_API_ORIGIN: 'https://aio.gaoq.com',
  ERP_PORTAL_OAUTH_RESOURCE: 'https://aio.gaoq.com/mcp',
  ERP_PORTAL_CLIENT_ID: portalClientId,
  ERP_PORTAL_CLIENT_SECRET: portalSecret,
  ERP_MOBILE_FRAME_ANCESTORS: '',
});
const websiteEnvironment = lines({
  NEXT_PUBLIC_ERP_API_ORIGIN: 'https://aio.gaoq.com',
  NEXT_PUBLIC_WEBSITE_ORIGIN: 'https://www.gaoq.com',
  MARKETING_REVALIDATE_SECRET: secret(),
});
const composeEnvironment = lines({
  GAOQ_API_IMAGE: `gaoq-os/api:${releaseTag}`,
  GAOQ_WORKER_IMAGE: `gaoq-os/worker:${releaseTag}`,
  GAOQ_WEB_IMAGE: `gaoq-os/web:${releaseTag}`,
  GAOQ_WEBSITE_IMAGE: `gaoq-os/website:${releaseTag}`,
  GAOQ_RUNTIME_DIR: runtimeDirectory,
  GAOQ_NODE_ENV: 'development',
  GAOQ_RELEASE_PROFILE: 'initial',
  GAOQ_API_PORT: '3201',
  GAOQ_WEB_PORT: '3200',
  GAOQ_WEBSITE_PORT: '3202',
});
const payrollSyncEnvironment = lines({
  GAOQ_SYNC_CLIENT_ID: payrollSyncClientId,
  GAOQ_SYNC_CLIENT_SECRET: payrollSyncSecret,
});

for (const [fileName, content] of [
  ['api.env', apiEnvironment],
  ['web.env', webEnvironment],
  ['website.env', websiteEnvironment],
  ['compose.env', composeEnvironment],
  ['payroll-sync.env', payrollSyncEnvironment],
]) {
  await writeProtectedFile(join(runtimeDirectory, fileName), content);
}
process.stdout.write('运行时配置已生成；未输出任何密钥。\n');

/** 生成独立的 256 位 Base64url 密钥。 */
function secret() {
  return randomBytes(32).toString('base64url');
}

/** 生成仅包含一把 active 密钥的初始密钥环。 */
function keyRing(keyId) {
  return JSON.stringify({
    activeKeyId: keyId,
    keys: [{ keyId, keyBase64url: secret(), status: 'active' }],
  });
}

/** 序列化 dotenv 文件并拒绝换行注入。 */
function lines(values) {
  return `${Object.entries(values).map(([name, value]) => {
    if (/[\r\n]/u.test(value)) throw new Error(`ENV_VALUE_INVALID:${name}`);
    return `${name}=${value}`;
  }).join('\n')}\n`;
}

/** 原子创建受保护文件，禁止覆盖已有运行时配置。 */
async function writeProtectedFile(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 });
  await rename(temporaryPath, filePath);
}

/** 校验只允许明确提供的 gaoqos 目标库，避免误连其他数据库。 */
function validateMongoUri(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('MONGODB_URI_INVALID');
  }
  if (
    parsed.protocol !== 'mongodb:' || parsed.pathname !== '/gaoqos' ||
    parsed.username.length === 0 || parsed.password.length === 0 ||
    parsed.searchParams.get('authSource') !== 'admin'
  ) throw new Error('MONGODB_URI_TARGET_INVALID');
}

/** 从交互终端读取一行且关闭回显，避免凭据出现在终端记录中。 */
async function readHiddenLine() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('MONGODB_URI_REQUIRES_TTY');
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const onData = (chunk) => {
        for (const character of chunk.toString('utf8')) {
          if (character === '\u0003') {
            process.stdin.off('data', onData);
            reject(new Error('INPUT_CANCELLED'));
            return;
          }
          if (character === '\r' || character === '\n') {
            process.stdin.off('data', onData);
            resolve(value);
            return;
          }
          value += character;
          if (value.length > 2_048) {
            process.stdin.off('data', onData);
            reject(new Error('MONGODB_URI_TOO_LONG'));
            return;
          }
        }
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
  }
}
