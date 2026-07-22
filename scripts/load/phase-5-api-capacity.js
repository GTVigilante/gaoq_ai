/* global __ENV, __VU, open */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const baseUrl = requireBaseUrl(__ENV.PERFORMANCE_BASE_URL);
const asOf = requireDate(__ENV.PERFORMANCE_AS_OF);
const resultPath = requireOutputPath(__ENV.PERFORMANCE_API_RESULT_PATH);
const inspectOnly = __ENV.PERFORMANCE_INSPECT_ONLY === 'true';
const tokens = new SharedArray('performance-access-tokens', () => {
  if (inspectOnly) return [];
  const tokenPath = __ENV.PERFORMANCE_TOKEN_FILE;
  if (typeof tokenPath !== 'string' || tokenPath.length === 0) fail('PERFORMANCE_TOKEN_FILE_REQUIRED');
  const document = JSON.parse(open(tokenPath));
  if (!Array.isArray(document) || document.length < 1_000 ||
    document.some((token) => typeof token !== 'string' || token.length < 32)) {
    fail('PERFORMANCE_TOKEN_POOL_INVALID');
  }
  if (new Set(document).size !== document.length) fail('PERFORMANCE_TOKEN_POOL_NOT_UNIQUE');
  return document;
});

const businessErrors = new Rate('business_errors');
const coreApiDuration = new Trend('core_api_duration', true);
const dashboardDuration = new Trend('dashboard_duration', true);

export const options = {
  discardResponseBodies: true,
  noConnectionReuse: false,
  scenarios: {
    read_capacity: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5m', target: 1_000 },
        { duration: '20m', target: 1_000 },
        { duration: '5m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    business_errors: ['rate<=0.001'],
    core_api_duration: ['p(95)<500', 'p(99)<1000'],
    dashboard_duration: ['p(95)<=2000', 'p(99)<=5000'],
  },
};

const corePaths = ['/api/org/chart', '/api/approvals/instances/inbox'];

/** 使用 1000 个独立测试身份执行只读混合负载，禁止任何业务写入。 */
export default function capacityScenario() {
  if (inspectOnly) fail('PERFORMANCE_INSPECT_MODE_CANNOT_RUN');
  const token = tokens[(__VU - 1) % tokens.length];
  const dashboard = __VU % 5 === 0;
  const path = dashboard
    ? `/api/analytics/management-dashboard?asOf=${encodeURIComponent(asOf)}`
    : corePaths[__VU % corePaths.length];
  const response = http.get(`${baseUrl}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    redirects: 0,
    tags: { workload: dashboard ? 'dashboard' : 'core-read' },
    timeout: '10s',
  });
  const durationMs = response.timings.duration;
  const succeeded = check(response, { '只读请求返回 200': (result) => result.status === 200 });
  businessErrors.add(!succeeded);
  if (dashboard) dashboardDuration.add(durationMs);
  else coreApiDuration.add(durationMs);
  sleep(1);
}

/** 原始 k6 汇总不包含 Token；结果仍必须进入受控证据目录。 */
export function handleSummary(data) {
  return { [resultPath]: JSON.stringify(data) };
}

function requireBaseUrl(value) {
  if (typeof value !== 'string') fail('PERFORMANCE_BASE_URL_REQUIRED');
  const httpsFqdn =
    /^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::443)?\/?$/;
  if (value.length > 264 || !httpsFqdn.test(value)) fail('PERFORMANCE_BASE_URL_INVALID');
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function requireDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('PERFORMANCE_AS_OF_INVALID');
  }
  return value;
}

function requireOutputPath(value) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9._/-]+\.json$/.test(value) || value.includes('..')) {
    fail('PERFORMANCE_API_RESULT_PATH_INVALID');
  }
  return value;
}

function fail(code) {
  throw new Error(code);
}
