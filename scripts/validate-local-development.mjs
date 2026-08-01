import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const [compose, runtime, packageJson, readme, runbook, gitignore] = await Promise.all([
  readFile(path.join(root, 'docker-compose.yml'), 'utf8'),
  readFile(path.join(root, 'scripts/dev/local-runtime.mjs'), 'utf8'),
  readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'README.md'), 'utf8'),
  readFile(path.join(root, 'docs/phase-1/07-local-development-runtime.md'), 'utf8'),
  readFile(path.join(root, '.gitignore'), 'utf8'),
]);

assert.equal(packageJson.scripts['dev:up'], 'node scripts/dev/local-runtime.mjs up');
assert.equal(packageJson.scripts['dev:down'], 'node scripts/dev/local-runtime.mjs down');
assert.match(packageJson.scripts['deployment:local-runtime:validate'], /local-runtime\.mjs --self-test/u);
assert.match(packageJson.scripts['deployment:local-runtime:validate'], /validate-local-development\.mjs/u);

for (const marker of [
  'object-store:',
  'object-store-init:',
  'quay.io/minio/minio:RELEASE.',
  'quay.io/minio/mc:RELEASE.',
  'condition: service_healthy',
  'mc mb --ignore-existing',
  'mc anonymous set none',
  'gaoq-object-store-data:',
]) {
  assert.ok(compose.includes(marker), `docker-compose.yml 缺少 ${marker}`);
}
for (const variable of [
  'DEV_OBJECT_STORAGE_ACCESS_KEY',
  'DEV_OBJECT_STORAGE_SECRET_KEY',
  'DEV_OBJECT_STORAGE_BUCKET',
]) {
  assert.match(
    compose,
    new RegExp(`\\$\\{${variable}:\\?`, 'u'),
    `${variable} 必须由运行时显式注入`,
  );
}
assert.match(
  compose,
  /^\s+MINIO_ROOT_USER: \$\{DEV_OBJECT_STORAGE_ACCESS_KEY:\?/mu,
);
assert.match(
  compose,
  /^\s+MINIO_ROOT_PASSWORD: \$\{DEV_OBJECT_STORAGE_SECRET_KEY:\?/mu,
);
assert.doesNotMatch(compose, /(?:minio|minio\/mc):latest/u);
assert.match(
  runtime,
  /\['up', '-d', '--wait', 'mongo', 'redis', 'object-store'\]/u,
);
assert.match(runtime, /\['run', '--rm', '--no-deps', 'mongo-init'\]/u);
assert.match(runtime, /\['run', '--rm', '--no-deps', 'object-store-init'\]/u);
assert.match(gitignore, /^\.local-runtime\/$/mu);
assert.match(readme, /pnpm dev:up/u);
assert.match(readme, /\.local-runtime\/object-storage\.env/u);
assert.match(runbook, /不替代 GitHub Actions/u);
assert.match(runbook, /本入口不\s*自动删除卷/u);

console.log('本地开发一键启动、对象存储与凭据失败关闭契约校验通过。');
