import { readFile } from 'node:fs/promises';

const compose = await readFile(
  new URL('../deploy/standalone/compose.yaml', import.meta.url),
  'utf8',
);
const nginx = await readFile(
  new URL('../deploy/standalone/nginx/gaoq-ai.conf.example', import.meta.url),
  'utf8',
);
const nginxAcmeBootstrap = await readFile(
  new URL('../deploy/standalone/nginx/gaoq-ai-acme-bootstrap.conf.example', import.meta.url),
  'utf8',
);
const readme = await readFile(
  new URL('../deploy/standalone/README.md', import.meta.url),
  'utf8',
);
const productionInputs = await readFile(
  new URL('../deploy/standalone/PRODUCTION_INPUTS.md', import.meta.url),
  'utf8',
);
const productionInputEnvironment = await readFile(
  new URL(
    '../deploy/standalone/runtime/production-inputs.env.example',
    import.meta.url,
  ),
  'utf8',
);
const launchStatus = await readFile(
  new URL('../deploy/standalone/LAUNCH_STATUS.md', import.meta.url),
  'utf8',
);
const runtimeGenerator = await readFile(
  new URL('./generate-standalone-runtime.mjs', import.meta.url),
  'utf8',
);
const payrollSyncExample = await readFile(
  new URL('../deploy/standalone/runtime/payroll-sync.env.example', import.meta.url),
  'utf8',
);

for (const marker of [
  'name: gaoq-ai',
  'GAOQ_API_IMAGE:?',
  'GAOQ_WORKER_IMAGE:?',
  'GAOQ_WEB_IMAGE:?',
  'GAOQ_WEBSITE_IMAGE:?',
  'GAOQ_RELEASE_PROFILE:?',
  '127.0.0.1:${GAOQ_API_PORT:-3201}:3001',
  '127.0.0.1:${GAOQ_WEB_PORT:-3200}:3000',
  '127.0.0.1:${GAOQ_WEBSITE_PORT:-3202}:3002',
  'name: gaoq-ai-private',
  'name: gaoq-ai-redis-data',
  'user: "999:999"',
  'no-new-privileges:true',
  'read_only: true',
]) {
  if (!compose.includes(marker)) throw new Error('STANDALONE_DEPLOYMENT_ISOLATION_INCOMPLETE');
}

for (const marker of [
  "const payrollResource = 'https://payroll.gaoq.com/api/payroll/v1';",
  "const payrollWebClientId = 'payroll-web-production';",
  "const payrollSyncClientId = 'payroll-sync-production';",
  "'erp:payroll:master-data:read'",
  "'erp:payroll:master-data:sync'",
  "allowedResources: [erpResource, payrollResource]",
  "AUTH_ADDITIONAL_RESOURCES_JSON: JSON.stringify",
  "MCP_OAUTH_CLIENTS_JSON: oauthClients",
  "['payroll-sync.env', payrollSyncEnvironment]",
]) {
  if (!runtimeGenerator.includes(marker)) {
    throw new Error('STANDALONE_PAYROLL_OAUTH_INTEGRATION_INCOMPLETE');
  }
}
if (
  !payrollSyncExample.includes('GAOQ_SYNC_CLIENT_ID=payroll-sync-production') ||
  !payrollSyncExample.includes('GAOQ_SYNC_CLIENT_SECRET=')
) throw new Error('STANDALONE_PAYROLL_SYNC_SECRET_HANDOFF_INCOMPLETE');

for (const marker of [
  'OP_SSO_REDIRECT_URI=https://aio.gaoq.com/api/auth/sso/op/callback',
  'PAYROLL_WEB_ORIGIN=',
  'PAYROLL_TAX_GATEWAY_BEARER_TOKEN=',
  'TREASURY_BANK_SUBMISSION_BEARER_TOKEN=',
  'ESIGN_API_BASE_URL=https://openapi.esign.cn',
  'AUDIT_ANCHOR_SIGNING_PRIVATE_KEY_BASE64=',
]) {
  if (!productionInputEnvironment.includes(marker)) {
    throw new Error('STANDALONE_PRODUCTION_INPUT_ENVIRONMENT_INCOMPLETE');
  }
}
if (/example\.(?:com|net|org)|REPLACE|changeme|secret123/iu.test(productionInputEnvironment)) {
  throw new Error('STANDALONE_PRODUCTION_INPUT_ENVIRONMENT_PLACEHOLDER_UNSAFE');
}

if (
  /^\s{2}mongo:/mu.test(compose) ||
  /27017|MONGO_PORT|container_name:/u.test(compose) ||
  /mongodb:\/\/(?!\$\{)/iu.test(compose)
) throw new Error('STANDALONE_DEPLOYMENT_DATABASE_BOUNDARY_INVALID');

for (const marker of [
  'server_name aio.gaoq.com;',
  'server_name recruit.gaoq.com;',
  'server_name gaoq.com;',
  'server_name www.gaoq.com;',
  'ssl_protocols TLSv1.2 TLSv1.3;',
  'proxy_pass http://127.0.0.1:3200;',
  'proxy_pass http://127.0.0.1:3201;',
  'proxy_pass http://127.0.0.1:3202;',
  'location / { return 404; }',
  'location = /system-status.html {',
  'alias /var/www/gaoq-system-status/system-status.html;',
  'X-Robots-Tag "noindex, nofollow, noarchive"',
]) {
  if (!nginx.includes(marker)) throw new Error('STANDALONE_NGINX_ROUTE_INCOMPLETE');
}
if (/server_name\s+gaoq\.com\s+www\.gaoq\.com/u.test(nginx)) {
  throw new Error('STANDALONE_NGINX_ROOT_CERTIFICATE_BOUNDARY_INVALID');
}
if (
  !/server_name\s+gaoq\.com;[\s\S]*?location \^~ \/\.well-known\/acme-challenge\/[\s\S]*?return 301 https:\/\/www\.gaoq\.com\$request_uri;/u.test(
    nginx,
  )
) throw new Error('STANDALONE_NGINX_ROOT_ACME_REDIRECT_INCOMPLETE');
if (
  !/listen\s+443\s+ssl;[\s\S]*?server_name\s+gaoq\.com;[\s\S]*?ssl_certificate \/etc\/nginx\/ssl\/gaoq\.com\.pem;[\s\S]*?ssl_certificate_key \/etc\/nginx\/ssl\/gaoq\.com\.key;[\s\S]*?return 301 https:\/\/www\.gaoq\.com\$request_uri;/u.test(
    nginx,
  )
) throw new Error('STANDALONE_NGINX_ROOT_HTTPS_REDIRECT_INCOMPLETE');

for (const marker of [
  'server_name aio.gaoq.com recruit.gaoq.com www.gaoq.com;',
  'location ^~ /.well-known/acme-challenge/',
  'root /var/www/acme-challenge;',
  'try_files $uri =404;',
  'return 503;',
]) {
  if (!nginxAcmeBootstrap.includes(marker)) {
    throw new Error('STANDALONE_NGINX_ACME_BOOTSTRAP_INCOMPLETE');
  }
}
if (
  /listen\s+443|ssl_certificate|proxy_pass|gaoq\.com\s+aio\.gaoq\.com/u.test(nginxAcmeBootstrap) ||
  /(?:deputy|kxy|mjb)\.gaoq\.com/u.test(nginxAcmeBootstrap)
) throw new Error('STANDALONE_NGINX_ACME_BOOTSTRAP_BOUNDARY_INVALID');

for (const marker of [
  '本编排不创建、删除或重建数据库',
  '禁止安装 Nginx 配置或开放公网',
  '不得 reload Nginx',
  'initial',
]) {
  if (!readme.includes(marker)) throw new Error('STANDALONE_RUNBOOK_SAFETY_BOUNDARY_MISSING');
}

for (const marker of [
  'OP_SSO_CLIENT_SECRET',
  'PAYROLL_WEB_ORIGIN',
  'TREASURY_WORM_ARCHIVE_ENDPOINT',
  'PAYROLL_TAX_GATEWAY_ENDPOINT',
  'ESIGN_MALWARE_SCAN_ENDPOINT',
  'AUDIT_WORM_ENDPOINT',
  '禁止自动写入演示数据',
]) {
  if (!productionInputs.includes(marker)) {
    throw new Error('STANDALONE_PRODUCTION_INPUT_CHECKLIST_INCOMPLETE');
  }
}

for (const marker of [
  'GAOQ_RELEASE_PROFILE=initial',
  'https://aio.gaoq.com/',
  'https://recruit.gaoq.com/careers',
  'https://www.gaoq.com/zh-CN',
  'https://www.gaoq.com/system-status.html',
  '当前公开职位数为 0',
  '企业 SSO 尚未接入',
  '本次没有执行数据库迁移、写入演示数据、删库或',
  'rollback-pre-initial-20260806',
]) {
  if (!launchStatus.includes(marker)) {
    throw new Error('STANDALONE_LAUNCH_EVIDENCE_INCOMPLETE');
  }
}

process.stdout.write('单机隔离部署、数据库保护与三域名路由静态校验通过。\n');
