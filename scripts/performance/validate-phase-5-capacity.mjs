import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{2,31}$/u;
const REGION = /^[a-z0-9-]{2,32}$/u;
const SIGNOFF_ROLES = ['performance_owner', 'platform_owner', 'security_owner'];
const K6_BINARY_SHA256 =
  'sha256:2ae87d976f6cdba17185bdd980d8819a3a98e9092c6f0638cd58272ecefc8b90';
const HARNESS_SOURCE = await readFile(
  new URL('../load/phase-5-api-capacity.js', import.meta.url),
  'utf8',
);
const HARNESS_SHA256 = digest(HARNESS_SOURCE);

if (process.argv[2] === '--self-test') {
  await validateHarnessSource();
  runSelfTest();
  process.stdout.write('Phase 5 性能容量证据门禁自测通过。\n');
} else {
  const argumentsList = process.argv.slice(2);
  const enforceEnvironment = argumentsList[0] === '--enforce-environment';
  const paths = argumentsList.slice(enforceEnvironment ? 1 : 0);
  if (paths.length !== 3) fail('PHASE5_PERFORMANCE_THREE_RUNS_REQUIRED');
  const documents = await Promise.all(paths.map(async (path) => {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
      metadata.size > 256 * 1_024 || (metadata.mode & 0o022) !== 0) {
      fail('PHASE5_PERFORMANCE_EVIDENCE_FILE_INVALID');
    }
    return JSON.parse(await readFile(path, 'utf8'));
  }));
  const summaries = documents.map((document) => validateEvidence(document, enforceEnvironment));
  validateComparable(summaries);
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    suite: 'gaoq.phase5.capacity.comparison',
    runIds: summaries.map((summary) => summary.runId),
    commitSha: summaries[0].commitSha,
    comparisonChecksum: digest(canonical(summaries)),
  }, null, 2)}\n`);
}

async function validateHarnessSource() {
  const workflow = await readFile(
    new URL('../../.github/workflows/phase-5-security.yml', import.meta.url),
    'utf8',
  );
  for (const marker of [
    "executor: 'ramping-vus'",
    "{ duration: '20m', target: 1_000 }",
    "business_errors: ['rate<=0.001']",
    "core_api_duration: ['p(95)<500', 'p(99)<1000']",
    "dashboard_duration: ['p(95)<=2000', 'p(99)<=5000']",
    'document.length < 1_000',
    "if (inspectOnly) fail('PERFORMANCE_INSPECT_MODE_CANNOT_RUN')",
    "const corePaths = ['/api/org/chart', '/api/approvals/instances/inbox']",
    'value.length > 264',
  ]) {
    if (!HARNESS_SOURCE.includes(marker)) fail('PHASE5_PERFORMANCE_HARNESS_INCOMPLETE');
  }
  if (/http\.(?:post|put|patch|del)\(/u.test(HARNESS_SOURCE)) {
    fail('PHASE5_PERFORMANCE_WRITE_REQUEST_FORBIDDEN');
  }
  if (HARNESS_SOURCE.includes('new URL(')) fail('PHASE5_PERFORMANCE_K6_API_INCOMPATIBLE');
  for (const marker of [
    'performance-contract:',
    'grafana/k6/releases/download/v2.0.0/k6-v2.0.0-linux-amd64.tar.gz',
    '2ae87d976f6cdba17185bdd980d8819a3a98e9092c6f0638cd58272ecefc8b90',
    '--env PERFORMANCE_INSPECT_ONLY=true',
    '--env PERFORMANCE_BASE_URL=https://erp.example.invalid',
    '--env PERFORMANCE_AS_OF=2026-07-01',
    '--env PERFORMANCE_API_RESULT_PATH=/tmp/phase-5-k6-inspect.json',
    'node scripts/performance/validate-phase-5-capacity.mjs --self-test',
  ]) {
    if (!workflow.includes(marker)) fail('PHASE5_PERFORMANCE_CI_GATE_INCOMPLETE');
  }
  if (workflow.includes('--include-system-env-vars')) {
    fail('PHASE5_PERFORMANCE_CI_ENV_EXPOSURE_FORBIDDEN');
  }
}

function validateEvidence(document, enforceEnvironment = false) {
  object(document, [
    'formatVersion', 'suite', 'runId', 'environment', 'source', 'images', 'dataset',
    'api', 'payroll', 'infrastructure', 'artifacts', 'signoffs',
  ]);
  equal(document.formatVersion, 1, 'PHASE5_PERFORMANCE_FORMAT_INVALID');
  equal(document.suite, 'gaoq.phase5.capacity.v1', 'PHASE5_PERFORMANCE_SUITE_INVALID');
  pattern(document.runId, ULID, 'PHASE5_PERFORMANCE_RUN_ID_INVALID');

  object(document.environment, [
    'name', 'region', 'productionEquivalent', 'productionTraffic', 'startedAt', 'endedAt',
  ]);
  pattern(document.environment.name, ENVIRONMENT_NAME, 'PHASE5_PERFORMANCE_ENV_INVALID');
  if (/(?:^|-)prod(?:-|$)|production/u.test(document.environment.name)) {
    fail('PHASE5_PERFORMANCE_PROD_FORBIDDEN');
  }
  if (!/(?:^|-)(?:capacity|load|performance|stage|staging|preprod|uat)(?:-|$)/u
    .test(document.environment.name)) fail('PHASE5_PERFORMANCE_ENV_INVALID');
  pattern(document.environment.region, REGION, 'PHASE5_PERFORMANCE_REGION_INVALID');
  equal(document.environment.productionEquivalent, true, 'PHASE5_PERFORMANCE_ENV_NOT_EQUIVALENT');
  equal(document.environment.productionTraffic, false, 'PHASE5_PERFORMANCE_PROD_TRAFFIC_FORBIDDEN');
  const startedAt = timestamp(document.environment.startedAt);
  const endedAt = timestamp(document.environment.endedAt);
  if (endedAt <= startedAt) fail('PHASE5_PERFORMANCE_TIME_INVALID');

  object(document.source, [
    'commitSha', 'k6Version', 'k6BinarySha256', 'harnessSha256', 'deploymentManifestHash',
  ]);
  pattern(document.source.commitSha, COMMIT, 'PHASE5_PERFORMANCE_COMMIT_INVALID');
  equal(document.source.k6Version, '2.0.0', 'PHASE5_PERFORMANCE_K6_VERSION_INVALID');
  equal(document.source.k6BinarySha256, K6_BINARY_SHA256, 'PHASE5_PERFORMANCE_K6_DIGEST_INVALID');
  equal(document.source.harnessSha256, HARNESS_SHA256, 'PHASE5_PERFORMANCE_HARNESS_DIGEST_INVALID');
  pattern(
    document.source.deploymentManifestHash,
    SHA256,
    'PHASE5_PERFORMANCE_DEPLOYMENT_MANIFEST_INVALID',
  );

  object(document.images, ['api', 'worker', 'web', 'website']);
  for (const value of Object.values(document.images)) {
    pattern(value, SHA256, 'PHASE5_PERFORMANCE_IMAGE_DIGEST_INVALID');
  }
  if (new Set(Object.values(document.images)).size !== 4) {
    fail('PHASE5_PERFORMANCE_IMAGES_NOT_INDEPENDENT');
  }
  if (enforceEnvironment) validateExpectedEnvironment(document);
  object(document.dataset, ['fingerprint', 'employeeCount']);
  pattern(document.dataset.fingerprint, SHA256, 'PHASE5_PERFORMANCE_DATASET_INVALID');
  equal(document.dataset.employeeCount, 1_000, 'PHASE5_PERFORMANCE_DATASET_SIZE_INVALID');

  object(document.api, [
    'maxVus', 'durationSeconds', 'requestCount', 'errorRate', 'coreP95Ms', 'coreP99Ms',
    'dashboardP95Ms', 'dashboardP99Ms', 'thresholdsPassed',
  ]);
  equal(document.api.maxVus, 1_000, 'PHASE5_PERFORMANCE_VUS_INVALID');
  equal(document.api.durationSeconds, 1_800, 'PHASE5_PERFORMANCE_DURATION_INVALID');
  integer(document.api.requestCount, 1_000, Number.MAX_SAFE_INTEGER, 'PHASE5_PERFORMANCE_REQUESTS_INVALID');
  if (document.api.requestCount < document.api.maxVus * document.api.durationSeconds / 3) {
    fail('PHASE5_PERFORMANCE_REQUEST_VOLUME_INVALID');
  }
  if (endedAt - startedAt < document.api.durationSeconds * 1_000) {
    fail('PHASE5_PERFORMANCE_TIME_INVALID');
  }
  number(document.api.errorRate, 0, 0.001, 'PHASE5_PERFORMANCE_ERROR_RATE_FAILED');
  lessThan(document.api.coreP95Ms, 500, 'PHASE5_PERFORMANCE_CORE_P95_FAILED');
  lessThan(document.api.coreP99Ms, 1_000, 'PHASE5_PERFORMANCE_CORE_P99_FAILED');
  number(document.api.dashboardP95Ms, 0, 2_000, 'PHASE5_PERFORMANCE_DASHBOARD_P95_FAILED');
  number(document.api.dashboardP99Ms, 0, 5_000, 'PHASE5_PERFORMANCE_DASHBOARD_P99_FAILED');
  equal(document.api.thresholdsPassed, true, 'PHASE5_PERFORMANCE_K6_THRESHOLDS_FAILED');

  object(document.payroll, [
    'employeeCount', 'durationMs', 'status', 'errorCount', 'resultHash', 'evidenceHash',
    'externalSideEffects',
  ]);
  equal(document.payroll.employeeCount, 1_000, 'PHASE5_PERFORMANCE_PAYROLL_SIZE_INVALID');
  integer(document.payroll.durationMs, 1, 299_999, 'PHASE5_PERFORMANCE_PAYROLL_DURATION_FAILED');
  equal(document.payroll.status, 'completed', 'PHASE5_PERFORMANCE_PAYROLL_STATUS_FAILED');
  equal(document.payroll.errorCount, 0, 'PHASE5_PERFORMANCE_PAYROLL_ERRORS_FAILED');
  pattern(document.payroll.resultHash, SHA256, 'PHASE5_PERFORMANCE_PAYROLL_RESULT_INVALID');
  pattern(document.payroll.evidenceHash, SHA256, 'PHASE5_PERFORMANCE_PAYROLL_EVIDENCE_INVALID');
  equal(document.payroll.externalSideEffects, false, 'PHASE5_PERFORMANCE_EXTERNAL_EFFECT_FORBIDDEN');

  object(document.infrastructure, [
    'mongoReplicaSetMembers', 'redisTopology', 'apiReplicas', 'workerReplicas',
  ]);
  integer(document.infrastructure.mongoReplicaSetMembers, 3, 20, 'PHASE5_PERFORMANCE_MONGO_HA_REQUIRED');
  if (!['sentinel', 'cluster'].includes(document.infrastructure.redisTopology)) {
    fail('PHASE5_PERFORMANCE_REDIS_HA_REQUIRED');
  }
  integer(document.infrastructure.apiReplicas, 3, 100, 'PHASE5_PERFORMANCE_API_REPLICAS_INVALID');
  integer(document.infrastructure.workerReplicas, 2, 100, 'PHASE5_PERFORMANCE_WORKER_REPLICAS_INVALID');

  object(document.artifacts, ['rawLoadResultHash', 'monitoringSnapshotHash', 'logQueryHash']);
  for (const value of Object.values(document.artifacts)) {
    pattern(value, SHA256, 'PHASE5_PERFORMANCE_ARTIFACT_INVALID');
  }
  if (!Array.isArray(document.signoffs) || document.signoffs.length !== 3) {
    fail('PHASE5_PERFORMANCE_SIGNOFFS_INCOMPLETE');
  }
  const roles = document.signoffs.map((signoff) => {
    object(signoff, ['role', 'evidenceId', 'signedAt']);
    pattern(signoff.evidenceId, ULID, 'PHASE5_PERFORMANCE_SIGNOFF_EVIDENCE_INVALID');
    if (timestamp(signoff.signedAt) < endedAt) fail('PHASE5_PERFORMANCE_SIGNOFF_TIME_INVALID');
    return signoff.role;
  }).sort();
  if (canonical(roles) !== canonical([...SIGNOFF_ROLES].sort())) {
    fail('PHASE5_PERFORMANCE_SIGNOFF_ROLES_INVALID');
  }

  return Object.freeze({
    runId: document.runId,
    commitSha: document.source.commitSha,
    k6BinarySha256: document.source.k6BinarySha256,
    harnessSha256: document.source.harnessSha256,
    deploymentManifestHash: document.source.deploymentManifestHash,
    images: document.images,
    dataset: document.dataset,
    environmentName: document.environment.name,
    region: document.environment.region,
    infrastructure: document.infrastructure,
    api: document.api,
    payroll: document.payroll,
    artifacts: document.artifacts,
    signoffEvidenceIds: document.signoffs.map((signoff) => signoff.evidenceId),
  });
}

function validateComparable(summaries) {
  const runIds = new Set(summaries.map((summary) => summary.runId));
  const rawArtifacts = new Set(summaries.map((summary) => summary.artifacts.rawLoadResultHash));
  const monitoringArtifacts = new Set(
    summaries.map((summary) => summary.artifacts.monitoringSnapshotHash),
  );
  const logArtifacts = new Set(summaries.map((summary) => summary.artifacts.logQueryHash));
  const payrollEvidence = new Set(summaries.map((summary) => summary.payroll.evidenceHash));
  const signoffEvidenceIds = new Set(summaries.flatMap((summary) => summary.signoffEvidenceIds));
  if (
    runIds.size !== 3 || rawArtifacts.size !== 3 || monitoringArtifacts.size !== 3 ||
    logArtifacts.size !== 3 || payrollEvidence.size !== 3 || signoffEvidenceIds.size !== 9
  ) {
    fail('PHASE5_PERFORMANCE_RUNS_NOT_INDEPENDENT');
  }
  const comparable = summaries.map((summary) => canonical({
    commitSha: summary.commitSha,
    k6BinarySha256: summary.k6BinarySha256,
    harnessSha256: summary.harnessSha256,
    deploymentManifestHash: summary.deploymentManifestHash,
    images: summary.images,
    dataset: summary.dataset,
    environmentName: summary.environmentName,
    region: summary.region,
    infrastructure: summary.infrastructure,
    payrollResultHash: summary.payroll.resultHash,
  }));
  if (new Set(comparable).size !== 1) fail('PHASE5_PERFORMANCE_RUNS_NOT_COMPARABLE');
}

function runSelfTest() {
  const runs = [1, 2, 3].map((sequence) => validateEvidence(fixture(sequence)));
  validateComparable(runs);
  const slow = fixture(1);
  slow.api.coreP95Ms = 500;
  expectFailure(() => validateEvidence(slow), 'PHASE5_PERFORMANCE_CORE_P95_FAILED');
  const unsafe = fixture(1);
  unsafe.payroll.externalSideEffects = true;
  expectFailure(() => validateEvidence(unsafe), 'PHASE5_PERFORMANCE_EXTERNAL_EFFECT_FORBIDDEN');
  const forgedHarness = fixture(1);
  forgedHarness.source.harnessSha256 = digest('forged-harness');
  expectFailure(
    () => validateEvidence(forgedHarness),
    'PHASE5_PERFORMANCE_HARNESS_DIGEST_INVALID',
  );
  const reusedMonitoring = [1, 2, 3].map((sequence) => fixture(sequence));
  reusedMonitoring[1].artifacts.monitoringSnapshotHash =
    reusedMonitoring[0].artifacts.monitoringSnapshotHash;
  expectFailure(
    () => validateComparable(reusedMonitoring.map((run) => validateEvidence(run))),
    'PHASE5_PERFORMANCE_RUNS_NOT_INDEPENDENT',
  );
  const productionNamed = fixture(1);
  productionNamed.environment.name = 'prod-capacity';
  expectFailure(
    () => validateEvidence(productionNamed),
    'PHASE5_PERFORMANCE_PROD_FORBIDDEN',
  );
  withExpectedEnvironment(fixture(1), () => {
    validateEvidence(fixture(1), true);
    const mismatched = fixture(1);
    mismatched.source.commitSha = 'b'.repeat(40);
    expectFailure(
      () => validateEvidence(mismatched, true),
      'PHASE5_PERFORMANCE_COMMIT_MISMATCH',
    );
  });
}

function fixture(sequence) {
  const hash = (label) => digest(`${label}-${sequence}`);
  return {
    formatVersion: 1,
    suite: 'gaoq.phase5.capacity.v1',
    runId: `01J8ZQK7V0A2M4N6P8R0T2W4Y${sequence}`,
    environment: {
      name: 'capacity-stage', region: 'cn-test-1', productionEquivalent: true,
      productionTraffic: false, startedAt: `2026-07-2${sequence}T00:00:00.000Z`,
      endedAt: `2026-07-2${sequence}T00:40:00.000Z`,
    },
    source: {
      commitSha: 'a'.repeat(40), k6Version: '2.0.0', k6BinarySha256: K6_BINARY_SHA256,
      harnessSha256: HARNESS_SHA256, deploymentManifestHash: digest('deployment-manifest'),
    },
    images: {
      api: digest('api'),
      worker: digest('worker'),
      web: digest('web'),
      website: digest('website'),
    },
    dataset: { fingerprint: digest('dataset'), employeeCount: 1_000 },
    api: {
      maxVus: 1_000, durationSeconds: 1_800, requestCount: 1_000_000, errorRate: 0.0001,
      coreP95Ms: 300, coreP99Ms: 700, dashboardP95Ms: 1_500, dashboardP99Ms: 4_000,
      thresholdsPassed: true,
    },
    payroll: {
      employeeCount: 1_000, durationMs: 240_000, status: 'completed', errorCount: 0,
      resultHash: digest('payroll-result'), evidenceHash: hash('payroll-evidence'),
      externalSideEffects: false,
    },
    infrastructure: {
      mongoReplicaSetMembers: 3, redisTopology: 'sentinel', apiReplicas: 3, workerReplicas: 2,
    },
    artifacts: {
      rawLoadResultHash: hash('raw-load'), monitoringSnapshotHash: hash('monitoring'),
      logQueryHash: hash('logs'),
    },
    signoffs: SIGNOFF_ROLES.map((role, index) => ({
      role, evidenceId: `01J8ZQK7V0A2M4N6P8R0T2W5${sequence}${index}`,
      signedAt: '2026-07-25T00:00:00.000Z',
    })),
  };
}

function validateExpectedEnvironment(document) {
  const expected = {
    environment: process.env.PERFORMANCE_EXPECTED_ENVIRONMENT,
    region: process.env.PERFORMANCE_EXPECTED_REGION,
    commitSha: process.env.PERFORMANCE_EXPECTED_COMMIT,
    api: process.env.PERFORMANCE_EXPECTED_API_IMAGE,
    worker: process.env.PERFORMANCE_EXPECTED_WORKER_IMAGE,
    web: process.env.PERFORMANCE_EXPECTED_WEB_IMAGE,
    website: process.env.PERFORMANCE_EXPECTED_WEBSITE_IMAGE,
    deploymentManifestHash: process.env.PERFORMANCE_EXPECTED_DEPLOYMENT_MANIFEST,
  };
  pattern(expected.environment, ENVIRONMENT_NAME, 'PHASE5_PERFORMANCE_EXPECTED_ENV_REQUIRED');
  pattern(expected.region, REGION, 'PHASE5_PERFORMANCE_EXPECTED_ENV_REQUIRED');
  pattern(expected.commitSha, COMMIT, 'PHASE5_PERFORMANCE_EXPECTED_SOURCE_REQUIRED');
  for (const field of ['api', 'worker', 'web', 'website', 'deploymentManifestHash']) {
    pattern(expected[field], SHA256, 'PHASE5_PERFORMANCE_EXPECTED_SOURCE_REQUIRED');
  }
  equal(
    document.environment.name,
    expected.environment,
    'PHASE5_PERFORMANCE_ENVIRONMENT_MISMATCH',
  );
  equal(document.environment.region, expected.region, 'PHASE5_PERFORMANCE_REGION_MISMATCH');
  equal(document.source.commitSha, expected.commitSha, 'PHASE5_PERFORMANCE_COMMIT_MISMATCH');
  equal(document.images.api, expected.api, 'PHASE5_PERFORMANCE_IMAGE_MISMATCH');
  equal(document.images.worker, expected.worker, 'PHASE5_PERFORMANCE_IMAGE_MISMATCH');
  equal(document.images.web, expected.web, 'PHASE5_PERFORMANCE_IMAGE_MISMATCH');
  equal(document.images.website, expected.website, 'PHASE5_PERFORMANCE_IMAGE_MISMATCH');
  equal(
    document.source.deploymentManifestHash,
    expected.deploymentManifestHash,
    'PHASE5_PERFORMANCE_DEPLOYMENT_MANIFEST_MISMATCH',
  );
}

function withExpectedEnvironment(document, action) {
  const values = {
    PERFORMANCE_EXPECTED_ENVIRONMENT: document.environment.name,
    PERFORMANCE_EXPECTED_REGION: document.environment.region,
    PERFORMANCE_EXPECTED_COMMIT: document.source.commitSha,
    PERFORMANCE_EXPECTED_API_IMAGE: document.images.api,
    PERFORMANCE_EXPECTED_WORKER_IMAGE: document.images.worker,
    PERFORMANCE_EXPECTED_WEB_IMAGE: document.images.web,
    PERFORMANCE_EXPECTED_WEBSITE_IMAGE: document.images.website,
    PERFORMANCE_EXPECTED_DEPLOYMENT_MANIFEST: document.source.deploymentManifestHash,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function object(value, keys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) {
    fail('PHASE5_PERFORMANCE_SCHEMA_INVALID');
  }
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function pattern(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
}

function number(value, minimum, maximum, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) fail(code);
}

function lessThan(value, maximum, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= maximum) fail(code);
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail('PHASE5_PERFORMANCE_TIMESTAMP_INVALID');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('PHASE5_PERFORMANCE_TIMESTAMP_INVALID');
  return parsed;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function expectFailure(operation, code) {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message === code) return;
    throw error;
  }
  fail('PHASE5_PERFORMANCE_SELF_TEST_DID_NOT_FAIL');
}

function fail(code) {
  throw new Error(code);
}
