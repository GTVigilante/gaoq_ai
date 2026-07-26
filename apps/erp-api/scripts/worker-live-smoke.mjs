import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const entryFile = fileURLToPath(new URL('../dist/worker-main.js', import.meta.url));
const port = 30_113;
const endpoint = `http://127.0.0.1:${port}`;
const metricsToken = randomBytes(32).toString('base64url');
const auditKey = randomBytes(32).toString('base64url');
const logs = [];

const worker = spawn(process.execPath, [entryFile], {
  cwd: apiRoot,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    MONGODB_URI:
      process.env.GAOQ_SMOKE_MONGODB_URI ??
      'mongodb://127.0.0.1:27020/gaoq_worker_smoke?replicaSet=rs0&directConnection=true',
    REDIS_URL: process.env.GAOQ_SMOKE_REDIS_URL ?? 'redis://127.0.0.1:6391/2',
    WORKER_METRICS_PORT: String(port),
    METRICS_BEARER_TOKEN: metricsToken,
    AUDIT_INTEGRITY_KEYS: JSON.stringify({
      activeKeyId: 'local-worker-smoke-audit',
      keys: [{
        keyId: 'local-worker-smoke-audit',
        keyBase64url: auditKey,
        status: 'active',
      }],
    }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [worker.stdout, worker.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    logs.push(...String(chunk).split('\n').filter(Boolean));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  });
}

try {
  await waitUntilLive(worker);
  await verifyEndpoints();
  process.stdout.write('真实 Worker 健康、鉴权指标与队列启动冒烟验证通过。\n');
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Worker 实测失败：${reason}\nWorker 最近日志：\n${logs.slice(-20).join('\n')}`,
    { cause: error },
  );
} finally {
  await stopChild(worker);
}

/**
 * 等待 Worker 指标服务器上线。
 *
 * @param {import('node:child_process').ChildProcess} child - Worker 子进程。
 * @returns {Promise<void>}
 */
async function waitUntilLive(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Worker 提前退出：${logs.slice(-20).join('\n')}`);
    }
    try {
      const response = await globalThis.fetch(`${endpoint}/health/live`, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      if (response.status === 200 && await response.text() === 'OK') return;
    } catch {
      // Worker 正在装配队列；固定短间隔重试且不回显连接错误。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Worker 健康端点就绪超时');
}

/** 验证指标端点默认拒绝、正确令牌放行且输出 Prometheus 格式。 */
async function verifyEndpoints() {
  const unauthorized = await globalThis.fetch(`${endpoint}/metrics`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('cache-control'), 'no-store');

  const wrongToken = await globalThis.fetch(`${endpoint}/metrics`, {
    headers: { authorization: `Bearer ${'x'.repeat(43)}` },
  });
  assert.equal(wrongToken.status, 401);

  const metrics = await globalThis.fetch(`${endpoint}/metrics`, {
    headers: { authorization: `Bearer ${metricsToken}` },
  });
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get('content-type') ?? '', /^text\/plain/u);
  assert.equal(metrics.headers.get('cache-control'), 'no-store');
  assert.match(await metrics.text(), /# HELP /u);

  const missing = await globalThis.fetch(`${endpoint}/unknown`);
  assert.equal(missing.status, 404);
}

/**
 * 优雅终止本脚本创建的 Worker 子进程。
 *
 * @param {import('node:child_process').ChildProcess} child - Worker 子进程。
 * @returns {Promise<void>}
 */
async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
