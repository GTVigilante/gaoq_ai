import { performance } from 'node:perf_hooks';

const baseUrl = process.env.LOAD_BASE_URL ?? 'http://localhost:3001';
const durationSeconds = boundedInteger(process.env.LOAD_DURATION_SECONDS, 30, 5, 300);
const concurrency = boundedInteger(process.env.LOAD_CONCURRENCY, 20, 1, 200);
const deadline = performance.now() + durationSeconds * 1_000;
const paths = ['/api/health/live', '/.well-known/oauth-authorization-server'];
const durations = [];
let requests = 0;
let failures = 0;

await Promise.all(Array.from({ length: concurrency }, (_, worker) => runWorker(worker)));

durations.sort((left, right) => left - right);
const result = {
  baseUrl,
  durationSeconds,
  concurrency,
  requests,
  failures,
  errorRate: requests === 0 ? 1 : failures / requests,
  p50Ms: percentile(durations, 0.5),
  p95Ms: percentile(durations, 0.95),
  p99Ms: percentile(durations, 0.99),
  maxMs: durations.at(-1) ?? 0,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.errorRate > 0.001 || result.p95Ms > 250 || result.p99Ms > 500) process.exitCode = 1;

async function runWorker(worker) {
  let sequence = worker;
  while (performance.now() < deadline) {
    const startedAt = performance.now();
    try {
      const response = await fetch(new URL(paths[sequence % paths.length], baseUrl), {
        signal: AbortSignal.timeout(2_000),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    }
    durations.push(performance.now() - startedAt);
    requests += 1;
    sequence += concurrency;
  }
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
}

function boundedInteger(raw, fallback, minimum, maximum) {
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`参数必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return parsed;
}
