import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const [dockerfile, compose, generator, mongoInit] = await Promise.all([
  readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/standalone/compose.yaml', import.meta.url), 'utf8'),
  readFile(new URL('./generate-production-runtime.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../docker/mongo-init.js', import.meta.url), 'utf8'),
]);
const [main, metadataController, bearerGuard] = await Promise.all([
  readFile(new URL('../apps/payroll-api/src/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/payroll-api/src/mcp/mcp-metadata.controller.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/payroll-api/src/identity/bearer-auth.guard.ts', import.meta.url), 'utf8'),
]);

for (const marker of [
  'FROM runtime-base AS payroll-api',
  'FROM runtime-base AS payroll-worker',
  'FROM runtime-base AS payroll-web',
  'USER 65532:65532',
  'pnpm install --frozen-lockfile',
  'NEXT_PUBLIC_PAYROLL_ORIGIN',
]) if (!dockerfile.includes(marker)) throw new Error('PAYROLL_IMAGE_BASELINE_INCOMPLETE');

if ((dockerfile.match(/^HEALTHCHECK /gmu) ?? []).length !== 3) {
  throw new Error('PAYROLL_IMAGE_HEALTHCHECK_INCOMPLETE');
}

for (const marker of [
  'name: gaoq-payroll',
  '127.0.0.1:${PAYROLL_API_PORT:-3211}:3101',
  '127.0.0.1:${PAYROLL_WEB_PORT:-3210}:3100',
  'name: gaoq-payroll-data',
  'name: gaoq-payroll-egress',
  'internal: true',
  'name: gaoq-payroll-mongo-data',
  'name: gaoq-payroll-redis-data',
  '--auth',
  '--keyFile',
  'read_only: true',
  'cap_drop: ["ALL"]',
  'no-new-privileges:true',
]) if (!compose.includes(marker)) throw new Error('PAYROLL_STANDALONE_ISOLATION_INCOMPLETE');

if (/\n\s+ports:\s*\n\s+- ["']?\$\{?PAYROLL_MONGO_PORT/mu.test(compose) ||
  /\n\s+ports:\s*\n\s+- ["']?\$\{?PAYROLL_REDIS_PORT/mu.test(compose)) {
  throw new Error('PAYROLL_DATASTORE_PORT_EXPOSED');
}

for (const marker of [
  'PAYROLL_RUNTIME_FILE_ALREADY_EXISTS',
  "['mongo-keyfile', `${randomBytes(512).toString('base64')}\\n`, 0o400]",
  'PAYROLL_RUNTIME_GENERATOR_REQUIRES_ROOT_FOR_MONGO_KEYFILE',
  'await chown(target, 999, 999)',
  'mongo:7.0@sha256:35a5926f71f8b6cb19206bee928c5a85f241a8be99f20c81abe35ae78a73415d',
  'redis:7.2-alpine@sha256:05a97a479bc73de66f087dc05b569010772880f778cc8671fa6b8aadee32e5c6',
  'PAYROLL_DATA_ENCRYPTION_KEYS',
  'PAYROLL_BLIND_INDEX_KEYS',
]) if (!generator.includes(marker)) throw new Error('PAYROLL_RUNTIME_GENERATOR_INCOMPLETE');

if (
  !/payroll-mongo:[\s\S]*?networks: \[data\]/u.test(compose) ||
  !/payroll-redis:[\s\S]*?networks: \[data\]/u.test(compose) ||
  !/payroll-api:[\s\S]*?networks: \[data, egress\]/u.test(compose) ||
  !/payroll-worker:[\s\S]*?networks: \[data, egress\]/u.test(compose)
) throw new Error('PAYROLL_DATA_NETWORK_BOUNDARY_INCOMPLETE');

for (const marker of [
  'admin.auth(rootUsername, rootPassword)',
  "role: 'readWrite'",
  "_id: 'payroll-rs0'",
  "host: 'payroll-mongo:27017'",
]) if (!mongoInit.includes(marker)) throw new Error('PAYROLL_MONGO_BOOTSTRAP_INCOMPLETE');

for (const marker of [
  "path: '.well-known/oauth-protected-resource/api/payroll/v1'",
  'method: RequestMethod.GET',
]) if (!main.includes(marker)) throw new Error('PAYROLL_RFC9728_PREFIX_EXCLUSION_INCOMPLETE');
if (!metadataController.includes("@Controller('.well-known/oauth-protected-resource/api/payroll/v1')")) {
  throw new Error('PAYROLL_RFC9728_METADATA_ROUTE_INCOMPLETE');
}
if (
  !bearerGuard.includes('WWW-Authenticate') ||
  !bearerGuard.includes('Bearer resource_metadata=')
) throw new Error('PAYROLL_MCP_AUTH_DISCOVERY_CHALLENGE_INCOMPLETE');

process.stdout.write('算薪生产镜像、独立编排、凭据和数据边界静态校验通过。\n');
