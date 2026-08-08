import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

const [runtimeDirectory, apiImage, workerImage, webImage] = process.argv.slice(2);
if (runtimeDirectory === undefined || !isAbsolute(runtimeDirectory)) {
  throw new Error('PAYROLL_RUNTIME_DIRECTORY_MUST_BE_ABSOLUTE');
}

const expectedImages = {
  PAYROLL_API_IMAGE: ['api', apiImage],
  PAYROLL_WORKER_IMAGE: ['worker', workerImage],
  PAYROLL_WEB_IMAGE: ['web', webImage],
};
for (const [environmentName, [component, image]] of Object.entries(expectedImages)) {
  const pattern = new RegExp(
    `^ghcr\\.io/gtvigilante/gaoq-payroll-${component}@sha256:[a-f0-9]{64}$`,
    'u',
  );
  if (image === undefined || !pattern.test(image)) {
    throw new Error(`PAYROLL_PRODUCTION_IMAGE_DIGEST_INVALID:${environmentName}`);
  }
}

const composeEnvironmentPath = join(runtimeDirectory, 'compose.env');
const metadata = await lstat(composeEnvironmentPath);
if (!metadata.isFile() || metadata.isSymbolicLink()) {
  throw new Error('PAYROLL_COMPOSE_ENV_MUST_BE_REGULAR_FILE');
}

let environment = await readFile(composeEnvironmentPath, 'utf8');
for (const [environmentName, [, image]] of Object.entries(expectedImages)) {
  const marker = new RegExp(`^${environmentName}=.*$`, 'gmu');
  const matches = environment.match(marker);
  if (matches?.length !== 1) {
    throw new Error(`PAYROLL_COMPOSE_IMAGE_KEY_INVALID:${environmentName}`);
  }
  environment = environment.replace(marker, `${environmentName}=${image}`);
}

const temporaryPath = `${composeEnvironmentPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, environment, { mode: 0o600, flag: 'wx' });
await rename(temporaryPath, composeEnvironmentPath);
process.stdout.write('算薪生产镜像已固定到 GHCR 内容摘要。\n');
