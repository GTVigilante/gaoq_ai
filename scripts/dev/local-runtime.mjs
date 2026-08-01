import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const credentialFile = path.join(root, '.local-runtime/object-storage.env');
const bucketName = 'gaoq-local';
const credentialKeys = new Set([
  'DEV_OBJECT_STORAGE_ACCESS_KEY',
  'DEV_OBJECT_STORAGE_SECRET_KEY',
  'DEV_OBJECT_STORAGE_BUCKET',
]);

/**
 * 运行子进程并返回退出码。
 *
 * @param {string} command - 可执行文件。
 * @param {readonly string[]} args - 参数。
 * @param {NodeJS.ProcessEnv} env - 子进程环境。
 * @param {'inherit'|'ignore'} stdio - 输出模式。
 * @returns {Promise<number>} 退出码。
 */
async function run(command, args, env, stdio = 'inherit') {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        resolve(128);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * 探测 Compose 命令，优先使用 Docker 插件。
 *
 * @param {(command: string, args: readonly string[]) => Promise<number>} probe - 探针。
 * @returns {Promise<{readonly command: string; readonly prefix: readonly string[]}>} 命令。
 */
export async function resolveComposeCommand(probe = async (command, args) =>
  await run(command, args, process.env, 'ignore')) {
  const candidates = [
    { command: 'docker', prefix: ['compose'] },
    { command: 'docker-compose', prefix: [] },
  ];
  for (const candidate of candidates) {
    try {
      if (await probe(candidate.command, [...candidate.prefix, 'version']) === 0) {
        return candidate;
      }
    } catch {
      // 继续探测兼容命令。
    }
  }
  throw new Error('未找到可用的 docker compose 或 docker-compose');
}

/**
 * 生成符合 MinIO 长度要求的高熵本地凭据。
 *
 * @returns {Readonly<Record<string, string>>} 凭据。
 */
export function generateObjectStorageCredentials() {
  return Object.freeze({
    DEV_OBJECT_STORAGE_ACCESS_KEY: `gaoq${randomBytes(10).toString('hex')}`,
    DEV_OBJECT_STORAGE_SECRET_KEY: randomBytes(32).toString('base64url'),
    DEV_OBJECT_STORAGE_BUCKET: bucketName,
  });
}

/**
 * 严格解析凭据文件。
 *
 * @param {string} source - 文件正文。
 * @returns {Readonly<Record<string, string>>} 凭据。
 */
export function parseCredentialFile(source) {
  const entries = source.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('本地对象存储凭据文件格式非法');
    return [line.slice(0, separator), line.slice(separator + 1)];
  });
  const credentials = Object.fromEntries(entries);
  if (
    entries.length !== credentialKeys.size ||
    entries.some(([key]) => !credentialKeys.has(key)) ||
    !/^gaoq[a-f0-9]{20}$/u.test(credentials.DEV_OBJECT_STORAGE_ACCESS_KEY ?? '') ||
    !/^[A-Za-z0-9_-]{43}$/u.test(credentials.DEV_OBJECT_STORAGE_SECRET_KEY ?? '') ||
    credentials.DEV_OBJECT_STORAGE_BUCKET !== bucketName
  ) {
    throw new Error('本地对象存储凭据字段、长度或编码非法');
  }
  return Object.freeze(credentials);
}

/**
 * 读取或原子创建本地凭据。
 *
 * @param {string} file - 凭据文件路径。
 * @returns {Promise<Readonly<Record<string, string>>>} 凭据。
 */
async function loadOrCreateCredentials(file) {
  try {
    const existing = parseCredentialFile(await readFile(file, 'utf8'));
    await chmod(file, 0o600);
    return existing;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const generated = generateObjectStorageCredentials();
  const source = `${Object.entries(generated).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  try {
    await writeFile(file, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return parseCredentialFile(await readFile(file, 'utf8'));
  }
}

/**
 * 构造只供 Compose 使用的环境，不向应用进程传播对象存储管理凭据。
 *
 * @param {Readonly<Record<string, string>>} credentials - 凭据。
 * @returns {NodeJS.ProcessEnv} 环境。
 */
function composeEnvironment(credentials) {
  return { ...process.env, ...credentials };
}

/**
 * 分阶段启动长期服务并显式执行一次性初始化任务。
 *
 * @param {{readonly command: string; readonly prefix: readonly string[]}} compose - Compose 命令。
 * @param {Readonly<Record<string, string>>} credentials - 本地对象存储凭据。
 * @param {typeof run} runner - 子进程执行器。
 * @returns {Promise<void>}
 */
export async function startInfrastructure(compose, credentials, runner = run) {
  const environment = composeEnvironment(credentials);
  const stages = [
    {
      name: '长期基础设施',
      args: [...compose.prefix, 'up', '-d', '--wait', 'mongo', 'redis', 'object-store'],
    },
    {
      name: 'MongoDB 副本集初始化',
      args: [...compose.prefix, 'run', '--rm', '--no-deps', 'mongo-init'],
    },
    {
      name: '对象存储桶初始化',
      args: [...compose.prefix, 'run', '--rm', '--no-deps', 'object-store-init'],
    },
  ];
  for (const stage of stages) {
    const code = await runner(compose.command, stage.args, environment);
    if (code !== 0) throw new Error(`${stage.name}失败（退出码 ${code}）`);
  }
}

/**
 * 等待开发应用，任一进程退出即收敛其余进程。
 *
 * @param {readonly import('node:child_process').ChildProcess[]} children - 子进程。
 * @returns {Promise<number>} 首个退出码。
 */
async function supervise(children) {
  let stopping = false;
  const stop = (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
    const timer = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }, 5_000);
    timer.unref();
  };
  let resolveSignalExit;
  const signalExit = new Promise((resolve) => {
    resolveSignalExit = resolve;
  });
  const onSigint = () => {
    stop('SIGTERM');
    resolveSignalExit(0);
  };
  const onSigterm = () => {
    stop('SIGTERM');
    resolveSignalExit(0);
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  const childExit = Promise.race(children.map((child) => new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code, signal) => resolve(signal === null ? (code ?? 1) : 128));
  })));
  const code = await Promise.race([signalExit, childExit]);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  stop('SIGTERM');
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('close', resolve);
  })));
  return code;
}

/** 启动基础设施与全部开发应用。 */
async function up() {
  const compose = await resolveComposeCommand();
  const credentials = await loadOrCreateCredentials(credentialFile);
  await startInfrastructure(compose, credentials);
  console.log('本地依赖已就绪，正在启动 API、Worker、ERP Web 与官网。');
  const children = [
    spawn('pnpm', ['dev'], { cwd: root, env: process.env, stdio: 'inherit' }),
    spawn('pnpm', ['--filter', '@gaoq/erp-api', 'dev:worker'], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    }),
  ];
  process.exitCode = await supervise(children);
}

/** 停止本地基础设施并保留数据卷。 */
async function down() {
  const compose = await resolveComposeCommand();
  let credentials;
  try {
    credentials = parseCredentialFile(await readFile(credentialFile, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    credentials = generateObjectStorageCredentials();
  }
  const code = await run(
    compose.command,
    [...compose.prefix, 'down'],
    composeEnvironment(credentials),
  );
  if (code !== 0) throw new Error(`本地基础设施停止失败（退出码 ${code}）`);
}

/** 运行不依赖 Docker 的确定性自测。 */
async function selfTest() {
  const selectedPlugin = await resolveComposeCommand(async (command) =>
    command === 'docker' ? 0 : 1);
  assert.deepEqual(selectedPlugin, { command: 'docker', prefix: ['compose'] });
  const selectedStandalone = await resolveComposeCommand(async (command) =>
    command === 'docker-compose' ? 0 : 1);
  assert.deepEqual(selectedStandalone, { command: 'docker-compose', prefix: [] });
  await assert.rejects(
    resolveComposeCommand(async () => 1),
    /未找到可用/u,
  );
  const first = generateObjectStorageCredentials();
  const second = generateObjectStorageCredentials();
  assert.notEqual(first.DEV_OBJECT_STORAGE_SECRET_KEY, second.DEV_OBJECT_STORAGE_SECRET_KEY);
  assert.deepEqual(parseCredentialFile(
    `${Object.entries(first).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
  ), first);
  assert.throws(
    () => parseCredentialFile('DEV_OBJECT_STORAGE_ACCESS_KEY=admin\n'),
    /非法/u,
  );
  const composeCalls = [];
  await startInfrastructure(
    { command: 'docker-compose', prefix: [] },
    first,
    async (command, args, env) => {
      composeCalls.push({ command, args, env });
      return 0;
    },
  );
  assert.deepEqual(
    composeCalls.map(({ command, args }) => ({ command, args })),
    [
      {
        command: 'docker-compose',
        args: ['up', '-d', '--wait', 'mongo', 'redis', 'object-store'],
      },
      {
        command: 'docker-compose',
        args: ['run', '--rm', '--no-deps', 'mongo-init'],
      },
      {
        command: 'docker-compose',
        args: ['run', '--rm', '--no-deps', 'object-store-init'],
      },
    ],
  );
  assert.equal(
    composeCalls.every(({ env }) =>
      env.DEV_OBJECT_STORAGE_SECRET_KEY === first.DEV_OBJECT_STORAGE_SECRET_KEY),
    true,
  );
  await assert.rejects(
    startInfrastructure(
      { command: 'docker-compose', prefix: [] },
      first,
      async (_command, args) => args.includes('mongo-init') ? 9 : 0,
    ),
    /MongoDB 副本集初始化失败（退出码 9）/u,
  );
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'gaoq-local-runtime-'));
  try {
    const generated = await loadOrCreateCredentials(path.join(temporaryRoot, 'credentials.env'));
    const reused = await loadOrCreateCredentials(path.join(temporaryRoot, 'credentials.env'));
    assert.deepEqual(reused, generated);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  const failedChild = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => process.exit(7), 10)'],
    { stdio: 'ignore' },
  );
  const sibling = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { stdio: 'ignore' },
  );
  assert.equal(await supervise([failedChild, sibling]), 7);
  assert.notEqual(sibling.signalCode, null);
  console.log('本地开发编排器凭据、Compose 探测与恢复自测通过。');
}

const command = process.argv[2];
try {
  if (command === 'up') await up();
  else if (command === 'down') await down();
  else if (command === '--self-test') await selfTest();
  else throw new Error('用法：local-runtime.mjs <up|down|--self-test>');
} catch (error) {
  console.error(error instanceof Error ? error.message : '本地开发编排失败');
  process.exitCode = 1;
}
